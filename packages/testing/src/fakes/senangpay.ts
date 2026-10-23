/**
 * A fake senangPay-on-DOKU API (DOKU Malaysia "Global" API, Checkout only), built from the official DOKU Malaysia API
 * Reference (doku-developers.apidog.io, read 2026-10-23) and `gateways/senangpay/spec.md`. NOT yet measured against
 * the DOKU sandbox (api-sandbox.doku.com): when someone does, change this file first so it answers like the real
 * thing, then the adapter. The dead legacy API (app.senangpay.my) is not faked.
 *
 * What it checks, and where each rule comes from (spec sections in brackets):
 * - `Authorization: Basic base64("<API key>:")` (with the colon), else 401 `unauthorized` [A1, D-auth];
 * - `Client-Id` must be this merchant's, else 404 `invalid_client_id`; `Request-Timestamp` must be ISO 8601 UTC, else
 *   400 `request_timestamp_invalid` (the allowed skew is UNCONFIRMED, so only the format is checked) [A1, D-err];
 * - `API-Version` is required on every request (D-cco / D-rco `parameters`), else 400 `missing_parameter`;
 * - `Signature: HMACSHA256=<base64>` over `Client-Id\nRequest-Timestamp\nPath\nDigest` (GET: no digest line), with
 *   Digest = base64(SHA-256(raw body)) [A4.1, D-comp, D-gen]. Create Checkout marks the header "Conditional"; this fake
 *   REQUIRES it on POST (stricter on purpose, so a test proves the adapter signs) and checks it on GET when sent.
 *   A wrong signature → 401 `invalid_signature`;
 * - Create Checkout `POST /v3/checkouts`: `id` (Identity pattern), `order.amount` ringgit number ≥ 2.00 (RM2.00
 *   minimum, S-faq), `order.invoice_number`, `order.currency` = MYR, `order.expired_at` required [A2]; the same `id`
 *   twice → 400 `duplicate_transaction`; `Idempotency-Id` = same result for the same body, 409
 *   `idempotency_id_conflict` for another body [A5, D-idem];
 * - Retrieve `GET /v3/checkouts/{id}` with the merchant's own `id`; order status PENDING/PAID/EXPIRED, payment status
 *   PENDING/SUCCESS/FAILED/EXPIRED [A3, D-rco, D-stat]; unknown id → 404 `transaction_not_found`;
 * - notifications: the Global body (D-nglob example), POSTed as indented JSON and signed like a request, with the path
 *   of the MERCHANT's notification URL [A4, A4.1].
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

type Json = Record<string, unknown>

/** A checkout as the fake keeps it (what `GET /v3/checkouts/{id}` answers). */
export interface SenangPayCheckout {
  id: string
  order: { amount: number; invoice_number: string; currency: string; status: string; expired_at: string }
  payment: { checkout_url: string; type: string; status: string; state: string; channel?: string }
  customer: Json
  metadata: Json
}

export interface FakeSenangPay extends FakeGateway {
  requests: {
    method: string
    path: string
    rawBody: string
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }[]
  /** The fake's own record of a checkout; mutate it to set statuses a test needs. */
  checkout(id: string): SenangPayCheckout | undefined
}

/** base64(SHA-256(raw body bytes)) [A4.1]. */
export const dokuDigest = (rawBody: string): string =>
  createHash('sha256').update(rawBody, 'utf8').digest('base64')

/**
 * The DOKU Global signature exactly as the written rules (D-comp, D-gen) and the Java/Ruby samples build it: values
 * only, one per line, no trailing newline, digest line only when there is a body. Not the Python/Node `Digest:` form.
 */
export function dokuSignature(
  secretKey: string,
  clientId: string,
  timestamp: string,
  path: string,
  rawBody?: string,
): string {
  const lines = [clientId, timestamp, path]
  if (rawBody !== undefined) lines.push(dokuDigest(rawBody))
  return `HMACSHA256=${createHmac('sha256', secretKey).update(lines.join('\n'), 'utf8').digest('base64')}`
}

const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const obj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export async function startFakeSenangPay(opts: {
  clientId: string
  /** Signs requests and notifications. */
  secretKey: string
  /** The API key used as the Basic-auth username. */
  apiKey: string
  /** The path of the merchant's notification URL (Back Office → Settings → Webhook); notifications are signed over it. */
  notificationPath: string
}): Promise<FakeSenangPay> {
  const checkouts = new Map<string, SenangPayCheckout>()
  const idempotent = new Map<string, { digest: string; status: number; body: unknown }>()
  const requests: FakeSenangPay['requests'] = []
  const basic = `Basic ${Buffer.from(`${opts.apiKey}:`).toString('base64')}`

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      let body: unknown = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {}
      requests.push({ method: req.method ?? '', path, rawBody: raw, body, headers: req.headers })
      const send = (status: number, o: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(o))
      }
      const fail = (status: number, code: string, message: string) =>
        send(status, { error: { code, message } })
      const header = (name: string) => {
        const v = req.headers[name]
        return typeof v === 'string' ? v : ''
      }

      if (header('authorization') !== basic)
        return fail(401, 'unauthorized', 'Authentication failed. Please provice a valid API key or token')
      if (header('client-id') !== opts.clientId)
        return fail(404, 'invalid_client_id', 'Client Id is not registered.')
      const timestamp = header('request-timestamp')
      if (!ISO_UTC.test(timestamp) || Number.isNaN(Date.parse(timestamp)))
        return fail(
          400,
          'request_timestamp_invalid',
          'Request-Timestamp is missing or outside the allowed range.',
        )
      if (!header('api-version'))
        return fail(400, 'missing_parameter', 'Required paramater API-Version is missing.')
      const signature = header('signature')
      if (req.method === 'POST' && !signature)
        return fail(400, 'signature_missing', 'Signature is required but was not provided')
      if (signature) {
        const expected = dokuSignature(
          opts.secretKey,
          opts.clientId,
          timestamp,
          path,
          req.method === 'POST' ? raw : undefined,
        )
        if (signature !== expected)
          return fail(401, 'invalid_signature', 'Invalid Signature, please check the signature components')
      }

      if (req.method === 'POST' && path === '/v3/checkouts') {
        if (header('content-type').split(';')[0]?.trim() !== 'application/json')
          return fail(400, 'unsupported_media_type', 'Content-Type must be application/json.')
        const key = header('idempotency-id')
        const digest = dokuDigest(raw)
        const saved = key ? idempotent.get(key) : undefined
        if (saved) {
          if (saved.digest !== digest)
            return fail(409, 'idempotency_id_conflict', 'Duplicate request with the same idempotency id')
          return send(saved.status, saved.body)
        }
        const result = create(body)
        if (key) idempotent.set(key, { digest, ...result })
        return send(result.status, result.body)
      }

      const get = /^\/v3\/checkouts\/([^/]+)$/.exec(path)
      if (req.method === 'GET' && get) {
        const c = checkouts.get(decodeURIComponent(get[1] ?? ''))
        if (!c) return fail(404, 'transaction_not_found', 'Transaction with the given ID does not exist')
        return send(200, c)
      }
      return fail(404, 'transaction_not_found', 'Transaction with the given ID does not exist')
    })
  })

  function create(body: unknown): { status: number; body: unknown } {
    const bad = (code: string, message: string) => ({ status: 400, body: { error: { code, message } } })
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return bad('invalid_json', 'Request body must be valid JSON.')
    const b = body as Json
    const order = b.order as Json | undefined
    if (typeof b.id !== 'string' || !IDENTITY.test(b.id))
      return bad('invalid_parameter', 'Parameter id has invalid value or format.')
    if (!order || typeof order !== 'object')
      return bad('missing_parameter', 'Required paramater order is missing.')
    const amount = order.amount
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 2)
      return bad('invalid_parameter', 'Parameter order.amount has invalid value or format.')
    if (typeof order.invoice_number !== 'string' || !order.invoice_number)
      return bad('missing_parameter', 'Required paramater order.invoice_number is missing.')
    if (order.currency !== 'MYR') return bad('currency_not_support', 'The selected currency is not supported')
    if (typeof order.expired_at !== 'string' || Number.isNaN(Date.parse(order.expired_at)))
      return bad('missing_parameter', 'Required paramater order.expired_at is missing.')
    if (checkouts.has(b.id))
      return bad('duplicate_transaction', 'A transaction with the same reference already exists.')
    const checkout: SenangPayCheckout = {
      id: b.id,
      order: {
        amount,
        invoice_number: order.invoice_number,
        currency: 'MYR',
        status: 'PENDING',
        expired_at: order.expired_at,
      },
      payment: {
        checkout_url: `https://sandbox.doku.com/checkout-link-v2/${randomBytes(16).toString('hex')}`,
        type: 'SALE',
        status: 'PENDING',
        state: 'INITIATE',
      },
      customer: (b.customer as Json | undefined) ?? {},
      metadata: (b.metadata as Json | undefined) ?? {},
    }
    checkouts.set(b.id, checkout)
    const { order: o, payment, customer } = checkout
    return {
      status: 200,
      body: {
        id: checkout.id,
        order: {
          amount: o.amount,
          invoice_number: o.invoice_number,
          currency: o.currency,
          expired_at: o.expired_at,
        },
        checkout_experience: b.checkout_experience ?? {},
        payment: {
          checkout_url: payment.checkout_url,
          type: payment.type,
          status: payment.status,
          state: payment.state,
        },
        customer,
      },
    }
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const find = (id: string) => {
    const c = checkouts.get(id)
    if (!c) throw new Error(`fake senangPay: no checkout ${id}`)
    return c
  }

  return {
    url,
    requests,
    checkout: (id) => checkouts.get(id),
    markPaid(id) {
      const c = find(id)
      c.order.status = 'PAID'
      c.payment.status = 'SUCCESS'
      c.payment.state = 'COMPLETED'
      c.payment.channel = 'INTERNET_BANKING_FPX'
    },
    /**
     * A Global payment notification claiming success (even before `markPaid`; the fake's record stays unpaid).
     * `override` keys with a dot set nested fields (`order.invoice_number`); plain keys set `payment.<key>`. A numeric
     * `amount` value is sent as a JSON number.
     */
    callbackFor(id, override = {}) {
      const c = find(id)
      const notification: Json = {
        id: c.id,
        order: {
          amount: c.order.amount,
          invoice_number: c.order.invoice_number,
          currency: c.order.currency,
          expired_at: c.order.expired_at,
        },
        payment: {
          channel: c.payment.channel ?? 'INTERNET_BANKING_FPX',
          type: 'SALE',
          initiation_type: 'customer_initiate',
          amount: c.order.amount,
          currency: c.order.currency,
          status: 'SUCCESS',
          state: 'COMPLETED',
        },
        customer: c.customer,
        metadata: c.metadata,
      }
      for (const [key, value] of Object.entries(override)) {
        const [outer, inner] = key.includes('.') ? key.split('.', 2) : ['payment', key]
        const slot = outer ?? ''
        if (!obj(notification[slot])) notification[slot] = {}
        const target = notification[slot] as Json
        target[inner ?? ''] = /amount$/.test(key) && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value
      }
      // Indented, so a handler that re-serialises the parsed JSON gets different bytes and the signature fails.
      const rawBody = JSON.stringify(notification, null, 2)
      const timestamp = isoNow()
      return {
        fields: { id: c.id },
        rawBody,
        headers: {
          'content-type': 'application/json',
          'client-id': opts.clientId,
          'request-timestamp': timestamp,
          'api-version': 'doku-global.2025-12-01',
          signature: dokuSignature(opts.secretKey, opts.clientId, timestamp, opts.notificationPath, rawBody),
        },
      }
    },
    tamper: (cb) => ({
      ...cb,
      headers: {
        ...cb.headers,
        signature: (cb.headers.signature ?? '').replace(
          /^HMACSHA256=(.+)$/,
          (_m, b64: string) => `HMACSHA256=${flip(b64)}`,
        ),
      },
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
