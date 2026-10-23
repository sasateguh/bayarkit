/**
 * A fake HitPay API (Payment Requests), built from the official docs in `gateways/hitpay/spec.md` (not yet measured
 * against the HitPay sandbox). When someone measures the sandbox, change this file first so it answers like the real
 * thing, then the adapter.
 *
 * What it checks, and where each rule comes from (spec sections in brackets):
 * - auth: `X-BUSINESS-API-KEY` must be the configured key AND `X-Requested-With: XMLHttpRequest` must be present; the
 *   docs list a missing header as a cause of "Invalid Business API Key" [§1]. ASSUMED: that error is HTTP 401;
 * - create accepts BOTH form-urlencoded (guide + PHP SDK) and JSON (OpenAPI) bodies [§2, §6.4]; `currency` is required,
 *   and `amount` too (the guide says mandatory, the OpenAPI optional: the fake takes the stricter side); `amount` is in
 *   major units, 0.3 to 999999999.99, else 422 with the documented message [§2];
 * - amounts come back as strings in major units (`"10.50"`); timestamps without an offset [§2, §3];
 * - unknown request id → 404 `{"message":"No query results for model [App\\Business\\PaymentRequest] <id>"}` [§3];
 * - callbacks, two schemes [§4]:
 *   - `callbackFor` = the event webhook: JSON body, `Hitpay-Signature` = hex HMAC-SHA256(webhook salt, RAW body).
 *     ASSUMED: the body escapes `/` as `\/` (PHP `json_encode` default), so a handler that re-serialises the parsed
 *     JSON gets different bytes and the signature fails, as it can on a real webhook [§6.3];
 *   - `formCallbackFor` = the legacy per-request `webhook` form POST: `hmac` = hex HMAC-SHA256(API salt, every field
 *     except `hmac`, sorted by key, `key+value` concatenated without separators, empty values included) [§4].
 * ASSUMED (no source): the create response is HTTP 201; the checkout URL path; the shape of `payments[]` beyond the
 * documented status/amount/fees strings.
 */
import { createHmac, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CallbackInput } from '@bayarkit/core'
import { type FakeGateway, flip } from './types.js'

type PaymentRequest = Record<string, unknown> & {
  id: string
  status: string
  amount: string
  currency: string
  payments: Record<string, unknown>[]
}

export interface FakeHitPay extends FakeGateway {
  requests: {
    method: string
    path: string
    /** Body fields as received (form or JSON); repeated form keys (`payment_methods[]`) joined with `,`. */
    body: Record<string, unknown>
    contentType: string | undefined
    headers: Record<string, string | string[] | undefined>
  }[]
  /** The fake's own record (what `GET /v1/payment-requests/{id}` answers). */
  paymentRequest(id: string): PaymentRequest | undefined
  /** The legacy per-request `webhook` form POST, signed with the API salt (`hmac` field). */
  formCallbackFor(id: string, override?: Record<string, string>): CallbackInput
}

/** Event webhook signature, written independently of the adapter: hex HMAC-SHA256(webhook salt, raw body bytes). */
export function hitpayEventSignature(webhookSalt: string, rawBody: string): string {
  return createHmac('sha256', webhookSalt).update(rawBody, 'utf8').digest('hex')
}

/** Legacy `hmac`: every field except `hmac`, keys sorted, `${key}${value}` joined with nothing (PHP SDK ksort+implode). */
export function hitpayFormSignature(apiSalt: string, fields: Record<string, string>): string {
  const keys = Object.keys(fields)
    .filter((k) => k !== 'hmac')
    .sort()
  return createHmac('sha256', apiSalt)
    .update(keys.map((k) => `${k}${fields[k] ?? ''}`).join(''), 'utf8')
    .digest('hex')
}

const pad = (n: number) => String(n).padStart(2, '0')
/** `2025-07-03T02:18:49`: no offset, as in the docs. ASSUMED local time UTC+8 (refund example). */
const stamp = () => {
  const d = new Date(Date.now() + 8 * 3600_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export async function startFakeHitPay(opts: {
  apiKey: string
  /** API-key salt (Developers page): signs the legacy form callback. */
  apiSalt: string
  /** Per-webhook-endpoint salt: signs event webhooks. */
  webhookSalt: string
}): Promise<FakeHitPay> {
  const store = new Map<string, PaymentRequest>()
  const requests: FakeHitPay['requests'] = []

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const contentType = req.headers['content-type']
      let body: Record<string, unknown> = {}
      if (contentType?.includes('application/json')) {
        try {
          const j = raw ? JSON.parse(raw) : {}
          if (j && typeof j === 'object' && !Array.isArray(j)) body = j
        } catch {}
      } else {
        const form = new URLSearchParams(raw)
        for (const k of new Set(form.keys())) body[k] = form.getAll(k).join(',')
      }
      const path = (req.url ?? '').split('?')[0] ?? ''
      requests.push({ method: req.method ?? '', path, body, contentType, headers: req.headers })
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }

      if (
        req.headers['x-business-api-key'] !== opts.apiKey ||
        req.headers['x-requested-with'] !== 'XMLHttpRequest'
      ) {
        return send(401, { message: 'Invalid Business API Key' })
      }

      if (req.method === 'POST' && path === '/v1/payment-requests') {
        const errors: Record<string, string[]> = {}
        const s = (k: string) => (body[k] == null ? '' : String(body[k]).trim())
        if (!s('currency')) errors.currency = ['The currency field is required.']
        else if (s('currency').length > 3)
          errors.currency = ['The currency may not be greater than 3 characters.']
        const amount = Number(s('amount'))
        if (!s('amount')) errors.amount = ['The amount field is required.']
        else if (!Number.isFinite(amount) || amount < 0.3 || amount > 999999999.99)
          errors.amount = ['The amount must be between 0.3 and 999999999.99.']
        if (s('reference_number').length > 255)
          errors.reference_number = ['The reference number may not be greater than 255 characters.']
        if (s('purpose').length > 255)
          errors.purpose = ['The purpose may not be greater than 255 characters.']
        const first = Object.values(errors)[0]
        if (first) return send(422, { message: first[0], errors })

        const id = randomUUID()
        const now = stamp()
        const pr: PaymentRequest = {
          id,
          name: s('name') || null,
          email: s('email') || null,
          phone: s('phone') || null,
          amount: amount.toFixed(2),
          currency: s('currency'),
          status: 'pending',
          purpose: s('purpose') || null,
          reference_number: s('reference_number') || null,
          payment_methods: s('payment_methods[]') ? s('payment_methods[]').split(',') : ['card'],
          url: `https://securecheckout.sandbox.hit-pay.com/payment-request/@fake/${id}/checkout`,
          redirect_url: s('redirect_url') || null,
          webhook: s('webhook') || null,
          send_sms: false,
          send_email: false,
          allow_repeated_payments: false,
          expiry_date: null,
          created_at: now,
          updated_at: now,
          payments: [],
        }
        store.set(id, pr)
        const { payments: _omit, ...created } = pr
        return send(201, created)
      }

      const one = /^\/v1\/payment-requests\/([^/]+)$/.exec(path)
      if (one && req.method === 'GET') {
        const pr = store.get(one[1] ?? '')
        if (!pr)
          return send(404, {
            message: `No query results for model [App\\Business\\PaymentRequest] ${one[1]}`,
          })
        return send(200, pr)
      }
      send(404, { message: 'Not Found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const get = (id: string) => {
    const pr = store.get(id)
    if (!pr) throw new Error(`fake HitPay: no payment request ${id}`)
    return pr
  }
  /** The charge id a payment would carry; the record itself stays unpaid until markPaid. */
  const chargeIds = new Map<string, string>()
  const chargeId = (id: string) => {
    let c = chargeIds.get(id)
    if (!c) {
      c = randomUUID()
      chargeIds.set(id, c)
    }
    return c
  }

  return {
    url,
    requests,
    paymentRequest: (id) => store.get(id),
    markPaid(id) {
      const pr = get(id)
      const now = stamp()
      pr.status = 'completed'
      pr.updated_at = now
      pr.payments = [
        {
          id: chargeId(id),
          quantity: 1,
          status: 'succeeded',
          buyer_name: pr.name,
          buyer_email: pr.email,
          currency: pr.currency,
          amount: pr.amount,
          refunded_amount: '0.00',
          payment_type: 'card',
          fees: '0.50',
          created_at: now,
          updated_at: now,
        },
      ]
    },
    /**
     * The event webhook (`payment_request.completed`) claiming payment, even before `markPaid` (the fake's record
     * stays unpaid). `override` changes body fields before signing.
     */
    callbackFor(id, override = {}) {
      const pr = get(id)
      const { payments: _omit, ...shown } = pr
      const event = { ...shown, status: 'completed', updated_at: stamp(), ...override }
      const rawBody = JSON.stringify(event).replaceAll('/', '\\/')
      return {
        fields: {},
        rawBody,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'HitPay v2.0',
          'hitpay-event-type': 'completed',
          'hitpay-event-object': 'payment_request',
          'hitpay-signature': hitpayEventSignature(opts.webhookSalt, rawBody),
        },
      }
    },
    formCallbackFor(id, override = {}) {
      const pr = get(id)
      const fields: Record<string, string> = {
        payment_id: chargeId(id),
        payment_request_id: pr.id,
        reference_number: String(pr.reference_number ?? ''),
        phone: String(pr.phone ?? ''),
        amount: pr.amount,
        currency: pr.currency,
        status: 'completed',
        ...override,
      }
      const { hmac, ...signed } = fields
      const posted = { ...signed, hmac: hmac ?? hitpayFormSignature(opts.apiSalt, signed) }
      return {
        fields: posted,
        rawBody: new URLSearchParams(posted).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }
    },
    tamper(cb) {
      if (cb.headers['hitpay-signature'] !== undefined) {
        return { ...cb, headers: { ...cb.headers, 'hitpay-signature': flip(cb.headers['hitpay-signature']) } }
      }
      const fields = { ...cb.fields, hmac: flip(cb.fields.hmac ?? '') }
      return { ...cb, fields, rawBody: new URLSearchParams(fields).toString() }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
