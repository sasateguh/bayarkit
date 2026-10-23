/**
 * A fake eGHL (ADAPTIS e-Commerce) `payment.aspx`, built from the official PUBLIC code only (gateways/eghl/spec.md):
 * the eGHL_HASH class, merchant-api (QUERY), the Omnipay driver (response fields, test vector), paramvalidator (field
 * limits) and the WooCommerce plugin (GET redirect). eGHL publishes no API guide and this fake is NOT measured against
 * the test host (pay.e-ghl.com): when someone does, change this file first so it answers like the real thing, then the
 * adapter.
 *
 * What it does, with the spec section in brackets:
 * - ONE endpoint, `/IPGSG/payment.aspx` (path matched case-insensitively, C7), GET query or POST form; the
 *   `TransactionType` field picks the operation [§1];
 * - `SALE`: checks the paramvalidator required fields and limits (PaymentID ≤ 20, OrderNumber ≤ 40, CustIP ≤ 45,
 *   CustName ≤ 50, CustEmail ≤ 60, CustPhone ≤ 25, PageTimeout ≤ 4 digits), Amount = ringgit with exactly two decimals
 *   and no comma, and HashValue = sha256(password + ServiceID + PaymentID + MerchantReturnURL + MerchantApprovalURL +
 *   MerchantUnApprovalURL + MerchantCallBackURL + Amount + CurrencyCode + CustIP + PageTimeout + CardNo + Token) [§2,
 *   §4]. Accepted = 200 with an HTML payment page. ASSUMED (no public source): a refused SALE is HTTP 400 with a
 *   plain-text reason, and a reused PaymentID is refused (reuse behaviour is UNCONFIRMED, §6);
 * - `QUERY`: PymtMethod, ServiceID, PaymentID, Amount, CurrencyCode, HashValue (sha256(password + ServiceID +
 *   PaymentID + Amount + CurrencyCode)) [§3, §4]. The answer is a URL-encoded `key=value&…` body [§3] signed with the
 *   7-field response HashValue that merchant-api checks [§3, C2]; HashValue2 is NOT included (C2: UNCONFIRMED whether
 *   QUERY carries it). A query that does not match an existing payment in PaymentID, Amount, CurrencyCode AND
 *   PymtMethod answers `TxnExists=1&TxnStatus=-1` (merchant-api README: "matches all parameters sent in Query
 *   request"). ASSUMED: the PymtMethod that matches is the one the buyer PAID with (`DD`, the callback's value) once
 *   paid, and the one sent in the SALE (`ANY`) before; `queryMethod: 'sent'` makes it always the SALE's;
 * - unpaid payments answer TxnStatus `2` (pending) — ASSUMED: no public source says what QUERY returns for a page that
 *   was opened but not paid;
 * - callbacks: the Omnipay response field set, form-encoded, signed with HashValue (legacy, 7 fields) and HashValue2
 *   (10 fields: TxnID, ServiceID, PaymentID, TxnStatus, Amount, CurrencyCode, AuthCode, OrderNumber, Param6, Param7),
 *   TxnID = ServiceID + PaymentID like the official test vector [§4].
 *
 * A payment whose page the customer never opened (the conformance suite never opens one) is opened by `markPaid` /
 * `callbackFor` the way the customer's browser would deliver `created.url`: PaymentID and amount come from the adapter's
 * id `<PaymentID>.<amount in sen>`, and OrderNumber = PaymentID (the adapter sends the reference as both). A SALE that
 * did arrive (a test that fetched `created.url`) is used as received.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

/** The eGHL hash, written independently of the adapter: lowercase hex SHA-256 of password + values, no separator. */
const eghlSha = (password: string, values: (string | undefined)[]) =>
  createHash('sha256')
    .update(password + values.map((v) => v ?? '').join(''), 'utf8')
    .digest('hex')

const SALE_FIELDS = [
  'ServiceID',
  'PaymentID',
  'MerchantReturnURL',
  'MerchantApprovalURL',
  'MerchantUnApprovalURL',
  'MerchantCallBackURL',
  'Amount',
  'CurrencyCode',
  'CustIP',
  'PageTimeout',
  'CardNo',
  'Token',
]
const QUERY_FIELDS = ['ServiceID', 'PaymentID', 'Amount', 'CurrencyCode']
const RESPONSE_FIELDS = ['TxnID', 'ServiceID', 'PaymentID', 'TxnStatus', 'Amount', 'CurrencyCode', 'AuthCode']
const RESPONSE2_FIELDS = [...RESPONSE_FIELDS, 'OrderNumber', 'Param6', 'Param7']

/** paramvalidator `PaymentRequest` limits for the fields this fake checks, and which are required. */
const SALE_LIMITS: Record<string, [max: number, required: boolean]> = {
  TransactionType: [7, true],
  PymtMethod: [3, true],
  ServiceID: [3, true],
  PaymentID: [20, true],
  OrderNumber: [40, true],
  PaymentDesc: [100, true],
  MerchantReturnURL: [255, true],
  Amount: [15, true],
  CurrencyCode: [3, true],
  HashValue: [64, true],
  CustIP: [45, true],
  CustName: [50, true],
  CustEmail: [60, true],
  CustPhone: [25, true],
  MerchantApprovalURL: [255, false],
  MerchantUnApprovalURL: [255, false],
  MerchantCallBackURL: [255, false],
  PageTimeout: [4, false],
  Param6: [50, false],
  Param7: [50, false],
}

export interface EghlPayment {
  PaymentID: string
  OrderNumber: string
  Amount: string
  CurrencyCode: string
  /** PymtMethod sent in the SALE (`ANY`). */
  sentMethod: string
  /** PymtMethod the buyer paid with, once paid. */
  paidMethod?: string
  TxnID: string
  AuthCode: string
  TxnStatus: string
  TxnMessage: string
  Param6: string
  Param7: string
  /** True when a SALE request actually arrived (false = opened from the id by markPaid/callbackFor). */
  fromSale: boolean
}

export interface FakeEghl extends FakeGateway {
  /** Every request received, fields as decoded from the query string or the form body. */
  requests: { method: string; path: string; fields: Record<string, string> }[]
  /** The fake's own record of a payment, by PaymentID; mutate it to set statuses a test needs. */
  payment(paymentId: string): EghlPayment | undefined
}

export async function startFakeEghl(opts: {
  serviceId: string
  password: string
  /** Which PymtMethod a QUERY must carry: the one paid with (default), or always the one sent in the SALE. */
  queryMethod?: 'paid' | 'sent'
}): Promise<FakeEghl> {
  const payments = new Map<string, EghlPayment>()
  const requests: FakeEghl['requests'] = []
  let auth = 0

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const fields: Record<string, string> = Object.fromEntries(url.searchParams)
      if (req.method === 'POST') Object.assign(fields, Object.fromEntries(new URLSearchParams(raw)))
      requests.push({ method: req.method ?? '', path: url.pathname, fields })
      const text = (status: number, body: string, type = 'text/plain') => {
        res.writeHead(status, { 'content-type': `${type}; charset=utf-8` })
        res.end(body)
      }
      if (url.pathname.toLowerCase() !== '/ipgsg/payment.aspx') return text(404, 'Not Found')
      const f = (k: string) => fields[k] ?? ''

      switch (f('TransactionType').toUpperCase()) {
        case 'SALE': {
          for (const [k, [max, required]] of Object.entries(SALE_LIMITS)) {
            if (required && !f(k)) return text(400, `Param '${k}' is required`)
            if ([...f(k)].length > max) return text(400, `Param '${k}' exceeds maxlength i.e. ${max}`)
          }
          if (!/^\d+\.\d{2}$/.test(f('Amount'))) return text(400, `Amount [${f('Amount')}] is invalid`)
          if (f('PageTimeout') && !/^\d+$/.test(f('PageTimeout'))) return text(400, 'PageTimeout is invalid')
          if (f('ServiceID') !== opts.serviceId) return text(400, 'Invalid ServiceID')
          const expected = eghlSha(
            opts.password,
            SALE_FIELDS.map((k) => fields[k]),
          )
          if (f('HashValue').toLowerCase() !== expected) return text(400, 'Invalid HashValue')
          const id = f('PaymentID')
          if (payments.get(id)?.fromSale) return text(400, 'Duplicate PaymentID')
          payments.set(id, {
            ...open(id, f('Amount'), f('OrderNumber')),
            CurrencyCode: f('CurrencyCode'),
            sentMethod: f('PymtMethod'),
            Param6: f('Param6'),
            Param7: f('Param7'),
            fromSale: true,
          })
          return text(
            200,
            '<!doctype html><title>eGHL (fake)</title><h1>Payment page (fake)</h1>',
            'text/html',
          )
        }
        case 'QUERY': {
          for (const k of ['PymtMethod', 'ServiceID', 'PaymentID', 'Amount', 'CurrencyCode', 'HashValue']) {
            if (!f(k)) return text(400, `Param '${k}' is required`)
          }
          const signedQuery = eghlSha(
            opts.password,
            QUERY_FIELDS.map((k) => fields[k]),
          )
          if (f('ServiceID') !== opts.serviceId || f('HashValue').toLowerCase() !== signedQuery) {
            return text(200, answer({ TxnExists: '1', TxnStatus: '-2', TxnMessage: 'Invalid HashValue' }))
          }
          const p = payments.get(f('PaymentID'))
          const method = opts.queryMethod === 'sent' ? p?.sentMethod : (p?.paidMethod ?? p?.sentMethod)
          if (
            !p ||
            p.Amount !== f('Amount') ||
            p.CurrencyCode !== f('CurrencyCode') ||
            method !== f('PymtMethod')
          ) {
            return text(
              200,
              answer({
                ServiceID: f('ServiceID'),
                PaymentID: f('PaymentID'),
                Amount: f('Amount'),
                CurrencyCode: f('CurrencyCode'),
                TxnExists: '1',
                TxnStatus: '-1',
                TxnMessage: 'Transaction not found',
              }),
            )
          }
          return text(
            200,
            answer({
              TransactionType: 'QUERY',
              PymtMethod: f('PymtMethod'),
              ServiceID: opts.serviceId,
              PaymentID: p.PaymentID,
              Amount: p.Amount,
              CurrencyCode: p.CurrencyCode,
              TxnID: p.TxnID,
              TxnExists: '0',
              TxnStatus: p.TxnStatus,
              AuthCode: p.AuthCode,
              BankRefNo: p.TxnStatus === '0' ? `BR${p.AuthCode}` : '',
              TxnMessage: p.TxnMessage,
            }),
          )
        }
        default:
          return text(400, `TransactionType [${f('TransactionType')}] is not supported by this fake`)
      }
    })
  })

  /** A URL-encoded QUERY answer with the 7-field response HashValue merchant-api verifies. */
  function answer(o: Record<string, string>): string {
    const HashValue = eghlSha(
      opts.password,
      RESPONSE_FIELDS.map((k) => o[k]),
    )
    return new URLSearchParams({ ...o, HashValue }).toString()
  }

  function open(paymentId: string, amount: string, orderNumber: string): EghlPayment {
    auth += 1
    return {
      PaymentID: paymentId,
      OrderNumber: orderNumber,
      Amount: amount,
      CurrencyCode: 'MYR',
      sentMethod: 'ANY',
      TxnID: `${opts.serviceId}${paymentId}`,
      AuthCode: `A${String(auth).padStart(5, '0')}`,
      TxnStatus: '2',
      TxnMessage: 'Pending',
      Param6: '',
      Param7: '',
      fromSale: false,
    }
  }

  /** The payment for an adapter id `<PaymentID>.<sen>[.<method>]`, opened as the customer's browser would. */
  function byId(id: string): EghlPayment {
    const m = /^(.+?)\.(\d+)(?:\.[A-Za-z]+)?$/.exec(id)
    if (!m?.[1] || !m[2]) throw new Error(`fake eGHL: not an adapter id: ${id}`)
    const existing = payments.get(m[1])
    if (existing) return existing
    const p = open(m[1], (Number(m[2]) / 100).toFixed(2), m[1])
    payments.set(m[1], p)
    return p
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url: `${origin}/IPGSG/payment.aspx`,
    requests,
    payment: (paymentId) => payments.get(paymentId),
    markPaid(id) {
      const p = byId(id)
      p.TxnStatus = '0'
      p.TxnMessage = 'Transaction Successful'
      p.paidMethod = 'DD'
    },
    callbackFor(id, override = {}) {
      const p = byId(id)
      // The Omnipay response field set (spec §4). It claims success even before markPaid (a replayed or
      // forged-with-a-leaked-password callback), while the fake's own record stays unpaid.
      const fields: Record<string, string> = {
        TransactionType: 'SALE',
        PymtMethod: p.paidMethod ?? 'DD',
        ServiceID: opts.serviceId,
        PaymentID: p.PaymentID,
        OrderNumber: p.OrderNumber,
        Amount: p.Amount,
        CurrencyCode: p.CurrencyCode,
        TxnID: p.TxnID,
        IssuingBank: 'HostSim',
        TxnStatus: '0',
        AuthCode: p.AuthCode,
        TxnMessage: 'Transaction Successful',
        ...(p.Param6 ? { Param6: p.Param6 } : {}),
        ...(p.Param7 ? { Param7: p.Param7 } : {}),
        ...override,
      }
      const { HashValue, HashValue2, ...signed } = fields
      const posted = {
        ...signed,
        HashValue:
          HashValue ??
          eghlSha(
            opts.password,
            RESPONSE_FIELDS.map((k) => signed[k]),
          ),
        HashValue2:
          HashValue2 ??
          eghlSha(
            opts.password,
            RESPONSE2_FIELDS.map((k) => signed[k]),
          ),
      }
      return {
        fields: posted,
        rawBody: new URLSearchParams(posted).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }
    },
    tamper(cb) {
      const fields = { ...cb.fields, HashValue2: flip(cb.fields.HashValue2 ?? '') }
      return { ...cb, fields, rawBody: new URLSearchParams(fields).toString() }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
