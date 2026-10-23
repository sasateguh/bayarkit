/**
 * A fake 2C2P PGW Payment API (v4.x Payment Token + Payment Inquiry + backend notification), built from the official
 * documentation in `gateways/2c2p/spec.md` (developer.2c2p.com, read 23 October 2026). NOT yet measured against the
 * sandbox (sandbox-pgw.2c2p.com): when someone does, change this file first so it answers like the real thing, then
 * the adapter.
 *
 * What it does, and where each rule comes from (spec sections in brackets):
 * - `POST /payment/<4.3|4.5>/paymentToken` and `/paymentInquiry`, both versions answer; other versions → plain
 *   `UnsupportedApiVersion` [§1, observed probe];
 * - request and response bodies are `{"payload":"<JWT>"}`, HS256, the merchant secret key's hex STRING used as ASCII
 *   bytes (not hex-decoded) [§1, §4a, TV1/TV2];
 * - a request whose JWT does not verify → plain unsigned `{"respCode":"9042","respDesc":"Hash value mismatch"}`; an
 *   unreadable body → plain `{"respCode":"9040",…}` [§1 observed probe; §3 table]. ASSUMED: HTTP 200 for both, and
 *   errors unsigned (whether error responses are signed is UNCONFIRMED);
 * - `amount` is decimal MAJOR units (ringgit), D(12,5) [§2]; `invoiceNo` AN 50, unique (9015) [§2, §6];
 *   `idempotencyID` repeats the first answer (ASSUMED: the docs only say it "recognises retries") [§6];
 * - Payment Inquiry by `invoiceNo` or `paymentToken`; respCode 0000 paid, 2002 not found [§3]. ASSUMED: a token that
 *   exists but has no payment yet answers 0001 "Transaction is pending" (the docs do not say);
 * - inquiry `amount` is a JSON number (inquiry sample), the backend notification's is a STRING "230.87" (backend
 *   sample) [§9 C6]; `transactionDateTime` is `yyyyMMddHHmmss` [§3];
 * - backend notification: `{"payload":"<JWT>"}` JSON posted to backendReturnUrl [§4a].
 */
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CallbackInput } from '@bayarkit/core'
import { type FakeGateway, flip } from './types.js'

const VERSIONS = new Set(['4.3', '4.5'])

/** HS256 JWT exactly as 2C2P builds it (written independently of the adapter): compact JSON, base64url, no padding. */
export function sign2C2PJwt(claims: Record<string, unknown>, secretKey: string): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const sig = createHmac('sha256', Buffer.from(secretKey, 'utf8'))
    .update(`${head}.${body}`)
    .digest('base64url')
  return `${head}.${body}.${sig}`
}

function readJwt(token: string, secretKey: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head = '', body = '', sig = ''] = parts
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))
    if (header?.alg !== 'HS256') return null
    const want = createHmac('sha256', Buffer.from(secretKey, 'utf8'))
      .update(`${head}.${body}`)
      .digest('base64url')
    if (want !== sig) return null
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null
  } catch {
    return null
  }
}

interface Txn {
  invoiceNo: string
  paymentToken: string
  /** Amount as 2C2P stores it: major units, two decimals for MYR. */
  amount: string
  currencyCode: string
  description: string
  idempotencyID: string
  respCode: string
  respDesc: string
  transactionDateTime: string
  tranRef: string
  referenceNo: string
  approvalCode: string
}

export interface Fake2C2P extends FakeGateway {
  /** Every request: path, the outer JSON body, the decoded JWT claims (null when the JWT did not verify). */
  requests: { path: string; body: unknown; claims: Record<string, unknown> | null }[]
  /** Put a payment in any documented state (`0001` pending, `0003` cancelled, `4005` declined, `9020` expired…). */
  setStatus(invoiceNo: string, respCode: string, respDesc?: string): void
  /** The browser's frontend return (`paymentResponse=<base64 JSON>`), UNSIGNED exactly as documented [§4b]. */
  frontendFor(invoiceNo: string): CallbackInput
}

const pad = (n: number) => String(n).padStart(2, '0')
/** `yyyyMMddHHmmss`. ASSUMED Malaysia time; the docs do not give the timezone. */
const stamp = () => {
  const d = new Date(Date.now() + 8 * 3600_000)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
}

/** D(12,5), major units, positive: a JSON number or a decimal string. Returns two-decimal text or null. */
function amountOf(v: unknown): string | null {
  const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
  const m = /^(\d{1,7})(?:\.(\d{1,5}))?$/.exec(text)
  if (!m) return null
  const frac = (m[2] ?? '').padEnd(5, '0')
  if (/[1-9]/.test(frac.slice(2))) return null // MYR has two decimals (ISO 4217)
  const out = `${Number(m[1])}.${frac.slice(0, 2)}`
  return Number(out) > 0 ? out : null
}

export async function startFake2C2P(opts: { merchantId: string; secretKey: string }): Promise<Fake2C2P> {
  const txns = new Map<string, Txn>()
  const byToken = new Map<string, string>()
  const byIdempotency = new Map<string, string>()
  const requests: Fake2C2P['requests'] = []
  let origin = ''

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const plain = (o: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(o))
      }
      const signed = (claims: Record<string, unknown>) =>
        plain({ payload: sign2C2PJwt(claims, opts.secretKey) })
      const path = (req.url ?? '').split('?')[0] ?? ''
      const m = /^\/payment\/([0-9.]+)\/(paymentToken|paymentInquiry)$/.exec(path)
      let body: unknown = null
      try {
        body = JSON.parse(raw)
      } catch {}
      const token = (body as { payload?: unknown } | null)?.payload
      const claims = typeof token === 'string' ? readJwt(token, opts.secretKey) : null
      requests.push({ path, body, claims })
      if (req.method !== 'POST' || !m) {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ respCode: '9040', respDesc: 'Invalid Request (9040)' }))
      }
      if (!VERSIONS.has(m[1] ?? '')) return plain({ respCode: '9040', respDesc: 'UnsupportedApiVersion' })
      if (!(req.headers['content-type'] ?? '').includes('json') || typeof token !== 'string') {
        return plain({ respCode: '9040', respDesc: 'Invalid Request (9040)' })
      }
      if (!claims) return plain({ respCode: '9042', respDesc: 'Hash value mismatch' })
      if (claims.merchantID !== opts.merchantId)
        return signed({ respCode: '9007', respDesc: 'Invalid merchant' })

      if (m[2] === 'paymentToken') {
        const s = (k: string) => (claims[k] == null ? '' : String(claims[k]))
        if (!s('invoiceNo') || !s('description') || claims.amount === undefined) {
          return signed({ respCode: '9005', respDesc: 'Some mandatory fields are missing' })
        }
        if (!/^[A-Za-z0-9]{1,50}$/.test(s('invoiceNo')) || [...s('description')].length > 250) {
          return signed({ respCode: '9006', respDesc: 'This field exceeded its authorized length' })
        }
        const amount = amountOf(claims.amount)
        if (!amount) return signed({ respCode: '9009', respDesc: 'Amount is invalid' })
        if (s('currencyCode') && s('currencyCode') !== 'MYR')
          return signed({ respCode: '9010', respDesc: 'Invalid Currency Code' })
        if (s('paymentExpiry') && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s('paymentExpiry')))
          return signed({ respCode: '9008', respDesc: 'Invalid payment expiry' })
        const idem = s('idempotencyID')
        const again = idem ? byIdempotency.get(idem) : undefined
        if (again) {
          const t = txns.get(again)
          if (t) return signed(tokenResponse(m[1] ?? '4.3', t))
        }
        if (txns.has(s('invoiceNo'))) return signed({ respCode: '9015', respDesc: 'Existing Invoice Number' })
        const paymentToken = randomBytes(48).toString('base64')
        const t: Txn = {
          invoiceNo: s('invoiceNo'),
          paymentToken,
          amount,
          currencyCode: s('currencyCode') || 'MYR',
          description: s('description'),
          idempotencyID: idem,
          respCode: '0001',
          respDesc: 'Transaction is pending',
          transactionDateTime: '',
          tranRef: '',
          referenceNo: '',
          approvalCode: '',
        }
        txns.set(t.invoiceNo, t)
        byToken.set(paymentToken, t.invoiceNo)
        if (idem) byIdempotency.set(idem, t.invoiceNo)
        return signed(tokenResponse(m[1] ?? '4.3', t))
      }

      // paymentInquiry: merchantID + (paymentToken | invoiceNo) [§3].
      const invoiceNo =
        typeof claims.paymentToken === 'string' && claims.paymentToken
          ? byToken.get(claims.paymentToken)
          : typeof claims.invoiceNo === 'string'
            ? claims.invoiceNo
            : undefined
      const t = invoiceNo ? txns.get(invoiceNo) : undefined
      if (!t) return signed({ respCode: '2002', respDesc: 'Transaction not found' })
      return signed({
        merchantID: opts.merchantId,
        invoiceNo: t.invoiceNo,
        amount: Number(t.amount), // inquiry sample: a JSON number (1000.00 → 1000)
        currencyCode: t.currencyCode,
        transactionDateTime: t.transactionDateTime,
        agentCode: '',
        channelCode: t.respCode === '0000' ? 'VI' : '',
        approvalCode: t.approvalCode,
        referenceNo: t.referenceNo,
        tranRef: t.tranRef,
        accountNo: t.respCode === '0000' ? '411111XXXXXX1111' : '',
        idempotencyID: t.idempotencyID,
        userDefined1: '',
        respCode: t.respCode,
        respDesc: t.respDesc,
      })
    })
  })

  function tokenResponse(version: string, t: Txn) {
    return {
      webPaymentUrl: `${origin}/payment/${version}/#/token/${encodeURIComponent(t.paymentToken)}`,
      paymentToken: t.paymentToken,
      respCode: '0000',
      respDesc: 'Success',
    }
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const txn = (id: string) => {
    const t = txns.get(id)
    if (!t) throw new Error(`fake 2C2P: no invoice ${id}`)
    return t
  }

  return {
    url: origin,
    requests,
    markPaid(id) {
      const t = txn(id)
      Object.assign(t, {
        respCode: '0000',
        respDesc: 'Success',
        transactionDateTime: stamp(),
        tranRef: String(Math.floor(Math.random() * 1e7)),
        referenceNo: String(Math.floor(Math.random() * 1e7)),
        approvalCode: String(Math.floor(Math.random() * 1e6)).padStart(6, '0'),
      })
    },
    setStatus(id, respCode, respDesc = `status ${respCode}`) {
      Object.assign(txn(id), { respCode, respDesc })
    },
    /**
     * The backend notification claiming success (even before markPaid; the fake's record stays unpaid). Field set and
     * types follow the backend sample: `amount` a STRING, `cardNo` (C6). `override` changes claims before signing.
     */
    callbackFor(id, override = {}) {
      const t = txn(id)
      const claims: Record<string, unknown> = {
        merchantID: opts.merchantId,
        invoiceNo: t.invoiceNo,
        cardNo: '411111XXXXXX1111',
        amount: t.amount,
        currencyCode: t.currencyCode,
        tranRef: t.tranRef || '2868821',
        referenceNo: t.referenceNo || '2785703',
        approvalCode: t.approvalCode || '531484',
        eci: '05',
        transactionDateTime: t.transactionDateTime || stamp(),
        respCode: '0000',
        respDesc: 'Success',
        ...override,
      }
      // The outer JSON is indented: what is signed is the JWT inside it, not these bytes (spec §4a).
      const rawBody = JSON.stringify({ payload: sign2C2PJwt(claims, opts.secretKey) }, null, '\t')
      return {
        fields: { payload: JSON.parse(rawBody).payload },
        rawBody,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }
    },
    frontendFor(id) {
      const t = txn(id)
      const json = JSON.stringify({
        locale: null,
        invoiceNo: t.invoiceNo,
        channelCode: 'CC',
        respCode: '2000',
        respDesc: 'Transaction is completed, please do payment inquiry request for full payment information.',
      })
      const paymentResponse = Buffer.from(json).toString('base64')
      return {
        fields: { paymentResponse },
        rawBody: new URLSearchParams({ paymentResponse }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }
    },
    tamper(cb) {
      const swap = (jwt: string) => {
        const [h = '', p = '', s = ''] = jwt.split('.')
        return `${h}.${p}.${flip(s)}`
      }
      let body: { payload?: unknown } = {}
      try {
        body = JSON.parse(cb.rawBody)
      } catch {}
      const jwt = typeof body.payload === 'string' ? body.payload : (cb.fields.payload ?? '')
      const forged = swap(jwt)
      return {
        ...cb,
        fields: { ...cb.fields, payload: forged },
        rawBody: JSON.stringify({ payload: forged }, null, '\t'),
      }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
