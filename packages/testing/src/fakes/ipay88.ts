/**
 * A fake iPay88 Malaysia gateway (OPSG, now NTT DATA Payment Services), built from the official public artefacts on
 * the gateway host (signature test tools, the gateway's own `hmac-sha512.js`, a live probe of `enquiry.asp`) and the
 * iPay88-authored but third-party-hosted Technical Specification 1.6.4.4 — see gateways/ipay88/spec.md. NOT measured
 * against a sandbox (none is documented): when someone does, change this file first, then the adapter.
 *
 * - `POST <url>/entry.asp`: the browser form. Checks the parameters, MerchantCode and the HMAC-SHA512 request
 *   Signature, then records the payment as pending and answers an HTML page. Errors are the SPEC's error strings.
 * - `GET|POST <url>/enquiry.asp` (`MerchantCode`, `RefNo`, `Amount`): a bare `text/html` body with HTTP 200 for every
 *   outcome, like the live endpoint: `00` paid, `Invalid parameters`, `Record not found`, `Incorrect amount`,
 *   `Payment fail`.
 * - callbacks are HTML form POSTs (url-encoded) carrying the response fields, with Amount in the `1,278.99` format and
 *   Signature = HMAC-SHA512(MerchantKey, MerchantKey+MerchantCode+PaymentId+RefNo+Amount(no "." or ",")+Currency+Status).
 *
 * Payment ids: iPay88 has no payment id of its own before the customer pays, and its re-query needs RefNo AND Amount,
 * so the adapter's id is `<RefNo>:<amount in sen>`. This fake accepts that id; `callbackFor` / `markPaid` record the
 * payment when the browser form was never posted (the customer reached the payment page in a real flow).
 *
 * ASSUMED where nothing public says (the adapter must not depend on these beyond "not paid"):
 * - an existing unpaid record re-queries as `Payment fail` (the SPEC lists no "pending" answer);
 * - a wrong MerchantCode on enquiry.asp answers `Invalid parameters`;
 * - the request signature includes Xfield1 as the SPEC says (identical to the official tool while Xfield1 is empty).
 */
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CallbackInput } from '@bayarkit/core'
import { type FakeGateway, flip } from './types.js'

/** Written independently of the adapter: every "." and "," removed (SPEC wording), not just the first of each. */
const digits = (amount: string) => amount.replaceAll('.', '').replaceAll(',', '')
/** HMAC-SHA512 keyed with the MerchantKey over a message that ALSO starts with the MerchantKey; lowercase hex. */
const hmac = (key: string, message: string) => createHmac('sha512', key).update(message, 'utf8').digest('hex')

/** 1278.99 RM in sen → "1,278.99" (the SPEC's response format). */
const display = (sen: number) => {
  const whole = Math.floor(sen / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${whole}.${String(sen % 100).padStart(2, '0')}`
}
/** "1,278.99" or "1278.99" → sen; NaN otherwise. */
const senOf = (amount: string) =>
  /^(\d{1,3}(,\d{3})+|\d+)\.\d{2}$/.test(amount) ? Number(digits(amount)) : NaN

interface Payment {
  refNo: string
  amount: number
  currency: string
  status: 'pending' | 'paid' | 'failed'
  paymentId: string
  transId: string
  tranDate: string
}

export interface FakeIPay88 extends FakeGateway {
  /** Every request received: method, path, and the form/query parameters. */
  requests: { method: string; path: string; params: Record<string, string> }[]
  /** Record a failed payment (re-query answers `Payment fail`). */
  markFailed(id: string): void
}

const REQUIRED = [
  'MerchantCode',
  'PaymentId',
  'RefNo',
  'Amount',
  'Currency',
  'ProdDesc',
  'UserName',
  'UserEmail',
  'UserContact',
  'Remark',
  'Lang',
  'SignatureType',
  'Signature',
  'ResponseURL',
  'BackendURL',
]

export async function startFakeIPay88(opts: {
  merchantCode: string
  merchantKey: string
}): Promise<FakeIPay88> {
  const payments = new Map<string, Payment>()
  const requests: FakeIPay88['requests'] = []
  let n = 0

  const parseId = (id: string) => {
    const at = id.lastIndexOf(':')
    const refNo = id.slice(0, at)
    const amount = Number(id.slice(at + 1))
    if (at < 1 || !/^\d+$/.test(id.slice(at + 1)) || !Number.isSafeInteger(amount)) {
      throw new Error(`fake iPay88: not a payment id (<RefNo>:<sen>): ${id}`)
    }
    return { refNo, amount }
  }
  const myNow = () => {
    const d = new Date(Date.now() + 8 * 3600_000).toISOString()
    return `${d.slice(0, 10)} ${d.slice(11, 19)}`
  }
  const record = (refNo: string, amount: number, currency = 'MYR') => {
    let p = payments.get(refNo)
    if (!p) {
      n += 1
      p = {
        refNo,
        amount,
        currency,
        status: 'pending',
        paymentId: '2',
        transId: `T${String(n).padStart(9, '0')}`,
        tranDate: myNow(),
      }
      payments.set(refNo, p)
    }
    return p
  }
  const byId = (id: string) => {
    const { refNo, amount } = parseId(id)
    return record(refNo, amount)
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const [path = '', query = ''] = (req.url ?? '').split('?')
      const params = Object.fromEntries(new URLSearchParams(req.method === 'POST' ? raw : query))
      requests.push({ method: req.method ?? '', path, params })
      // Live probe: bare text, Content-Type text/html, HTTP 200 for every outcome.
      const text = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(body)
      }

      if (path === '/epayment/enquiry.asp' && (req.method === 'GET' || req.method === 'POST')) {
        const { MerchantCode, RefNo, Amount } = params
        if (!MerchantCode || !RefNo || !Amount || MerchantCode !== opts.merchantCode)
          return text('Invalid parameters')
        const p = payments.get(RefNo)
        if (!p) return text('Record not found')
        if (senOf(Amount) !== p.amount) return text('Incorrect amount')
        return text(p.status === 'paid' ? '00' : 'Payment fail')
      }

      if (path === '/epayment/entry.asp' && req.method === 'POST') {
        // SPEC: "O" fields may be empty but the parameter must exist.
        if (REQUIRED.some((k) => params[k] === undefined)) return text('Invalid parameters')
        const p = params as Record<string, string>
        if (p.MerchantCode !== opts.merchantCode) return text('Invalid merchant code')
        const expected = hmac(
          opts.merchantKey,
          `${opts.merchantKey}${p.MerchantCode}${p.RefNo}${digits(p.Amount ?? '')}${p.Currency}${p.Xfield1 ?? ''}`,
        )
        if (p.SignatureType !== 'HMACSHA512' || p.Signature !== expected) return text('Signature not match')
        const amount = senOf(p.Amount ?? '')
        if (!Number.isFinite(amount) || !p.RefNo || !p.ResponseURL || !p.BackendURL)
          return text('Invalid parameters')
        const existing = payments.get(p.RefNo)
        if (existing?.status === 'paid') return text('Duplicate reference number')
        if (existing) payments.delete(p.RefNo) // a failed RefNo may be retried
        record(p.RefNo, amount, p.Currency)
        return text(`<!doctype html><title>Fake iPay88</title><p>Fake iPay88 payment page for ${p.RefNo}</p>`)
      }
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('Not found')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url: `${origin}/epayment`,
    requests,
    markPaid(id) {
      byId(id).status = 'paid'
    },
    markFailed(id) {
      byId(id).status = 'failed'
    },
    callbackFor(id, override = {}): CallbackInput {
      const p = byId(id)
      // The response fields (SPEC p.11), as the gateway posts them to ResponseURL and BackendURL. It claims success
      // even before markPaid (a replayed or forged-with-a-leaked-key callback).
      const fields: Record<string, string> = {
        MerchantCode: opts.merchantCode,
        PaymentId: p.paymentId,
        RefNo: p.refNo,
        Amount: display(p.amount),
        Currency: p.currency,
        Remark: '',
        TransId: p.transId,
        AuthCode: '',
        Status: '1',
        ErrDesc: '',
        CCName: '',
        CCNo: '',
        S_bankname: '',
        S_country: '',
        TranDate: p.tranDate,
        Xfield1: '',
        ...override,
      }
      if (override.Signature === undefined) {
        fields.Signature = hmac(
          opts.merchantKey,
          `${opts.merchantKey}${fields.MerchantCode}${fields.PaymentId}${fields.RefNo}${digits(fields.Amount ?? '')}${fields.Currency}${fields.Status}`,
        )
      }
      return {
        fields,
        rawBody: new URLSearchParams(fields).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }
    },
    tamper: (cb) => {
      const fields = { ...cb.fields, Signature: flip(cb.fields.Signature ?? '') }
      return { ...cb, fields, rawBody: new URLSearchParams(fields).toString() }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
