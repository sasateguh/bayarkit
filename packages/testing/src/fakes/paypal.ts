/**
 * A fake PayPal REST API (OAuth token, Orders v2 with intent CAPTURE, capture refunds and the webhook postback check),
 * built from the official docs in `gateways/paypal/spec.md`. Not yet checked against the sandbox: every rule below is
 * the docs' word until a sandbox run says otherwise. Change this file first when PayPal changes.
 *
 * What it checks, and where each rule comes from (spec sections in brackets):
 * - token: `POST /v1/oauth2/token`, HTTP Basic `client_id:secret`, form body `grant_type=client_credentials`; answers
 *   `{ access_token, token_type: 'Bearer', expires_in, ... }` [§1]. A wrong client gets the OAuth 2.0 error body
 *   (`401 { error: 'invalid_client' }`, RFC 6749 §5.2: the PayPal page shows no failure sample). Tokens expire after
 *   `tokenTtlSeconds`; `expireTokens()` ends them all at once so a test proves the adapter fetches a new one;
 * - every other call: `Authorization: Bearer <live token>`, else 401 `AUTHENTICATION_FAILURE`; errors
 *   `{ name, message, debug_id, details[]: { field?, location?, issue, description } }` [§1];
 * - create: intent `CAPTURE` only (AUTHORIZE is out of bayarkit's scope, so the fake refuses it), exactly one purchase
 *   unit (PayPal takes 1–10; bayarkit sends one), `amount.value` a positive decimal STRING with no decimals for HUF,
 *   JPY and TWD and at most two otherwise, a currency from the 24 [§2.1, §7]; `custom_id` 1–255, `invoice_id` 1–127
 *   [§2.1]. With `payment_source.paypal.experience_context` the order is `PAYER_ACTION_REQUIRED` with a `payer-action`
 *   link, without it `CREATED` with an `approve` link [§2.2]. `Prefer` defaults to `return=minimal` (id, status,
 *   links) [OpenAPI `Prefer`];
 * - `PayPal-Request-Id`: a repeat of create, capture or refund with the same key (per call type) answers the first
 *   result again with `200` (the OpenAPI idempotent samples) and never acts twice [§4, §6];
 * - the buyer: `approve()` = `APPROVED` (nothing captured). `markPaid()` = approved AND captured, the state an app
 *   reaches after its own capture call, because the shared conformance suite expects `markPaid` to mean paid.
 *   `nextCapture(id, 'DECLINED' | 'PENDING')` makes the next capture end like the card-testing guide's declined card
 *   (order `COMPLETED`, capture `DECLINED`) or an unheld currency (capture `PENDING`) [§3];
 * - capture: only an `APPROVED` order [§4];
 * - issue names the official OpenAPI files do not show are the fake's own: `ORDER_NOT_APPROVED`,
 *   `ORDER_ALREADY_CAPTURED`, `DECIMAL_PRECISION`, `AMOUNT_NOT_POSITIVE`, `REFUND_CURRENCY_MISMATCH`,
 *   `INVALID_RESOURCE_ID` (PayPal lists its issues on a page that renders in JavaScript; UNCONFIRMED #3). The HTTP
 *   status and `name` follow the errors page; an adapter must not depend on the issue text;
 * - refunds: `POST /v2/payments/captures/{id}/refund` on a `COMPLETED`/`PARTIALLY_REFUNDED` capture, empty body =
 *   what remains, `amount` = partial in the capture's currency, above what remains = 422 `REFUND_AMOUNT_EXCEEDED`.
 *   A refund is `COMPLETED` at once (UNCONFIRMED #7) unless `nextRefund(captureId, 'PENDING')` [§6];
 * - webhooks: `callbackFor` sends a `PAYMENT.CAPTURE.COMPLETED` event (resource = a capture with `custom_id` and
 *   `supplementary_data.related_ids.order_id`) with the five `PAYPAL-*` headers [§5]. The signature is the fake's own
 *   HMAC, so `POST /v1/notifications/verify-webhook-signature` answers `SUCCESS` only for an event this fake sent, with
 *   the same headers, this fake's `webhookId`, and `webhook_event` spliced in BYTE FOR BYTE as delivered (the event is
 *   indented, so re-serialising it fails as the docs warn). Anything else is `FAILURE` (UNCONFIRMED #5) [§5.1].
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type FakeGateway, flip } from './types.js'

/** The 24 currencies PayPal lists [§7]. */
const CURRENCIES = new Set(
  'AUD BRL CAD CNY CZK DKK EUR HKD HUF ILS JPY MYR MXN TWD NZD NOK PHP PLN GBP SGD SEK CHF THB USD'.split(
    ' ',
  ),
)
/** No decimal places in PayPal, whatever ISO 4217 says [§7]. */
const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD'])
/** The headers PayPal sends with every webhook; all five go into the postback check [§5]. */
export const PAYPAL_HEADERS = [
  'paypal-transmission-id',
  'paypal-transmission-time',
  'paypal-transmission-sig',
  'paypal-cert-url',
  'paypal-auth-algo',
] as const

type Body = Record<string, unknown>
const obj = (v: unknown): Body => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Body) : {})
type Money = { currency_code: string; value: string }
type Link = { href: string; rel: string; method: string }

export interface PayPalCapture extends Body {
  id: string
  status: 'COMPLETED' | 'PENDING' | 'DECLINED' | 'FAILED' | 'PARTIALLY_REFUNDED' | 'REFUNDED'
  amount: Money
  custom_id?: string
  invoice_id?: string
}
export interface PayPalRefund extends Body {
  id: string
  status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'CANCELLED'
  amount: Money
}
export interface PayPalOrder extends Body {
  id: string
  intent: 'CAPTURE'
  status: 'CREATED' | 'PAYER_ACTION_REQUIRED' | 'APPROVED' | 'VOIDED' | 'COMPLETED'
  purchase_units: (Body & {
    reference_id: string
    amount: Money
    custom_id?: string
    invoice_id?: string
    payments?: { captures: PayPalCapture[]; refunds?: PayPalRefund[] }
  })[]
  links: Link[]
}

export interface FakePayPal extends FakeGateway {
  requests: {
    method: string
    path: string
    body: unknown
    headers: Record<string, string | string[] | undefined>
  }[]
  /** The fake's own record of an order (what `GET /v2/checkout/orders/{id}` answers). */
  order(id: string): PayPalOrder | undefined
  capture(id: string): PayPalCapture | undefined
  refund(id: string): PayPalRefund | undefined
  /** The buyer approves on PayPal: `APPROVED`, nothing captured yet [§3]. */
  approve(id: string): void
  /** How the next capture of this order ends: a declined card or a payment held for review [§3]. */
  nextCapture(id: string, status: 'DECLINED' | 'PENDING'): void
  /** How the next refund of this capture ends (UNCONFIRMED #7) [§6]. */
  nextRefund(captureId: string, status: 'PENDING'): void
  /** End every access token issued so far, as if `expires_in` ran out. */
  expireTokens(): void
}

/** Integer in PayPal's smallest unit → the decimal string PayPal takes (`1050` USD → `"10.50"`, `500` JPY → `"500"`). */
const toValue = (minor: number, currency: string): string =>
  ZERO_DECIMAL.has(currency)
    ? String(minor)
    : `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`
/** The decimal string back to an integer, or null when it has more decimals than the currency allows. */
const toMinor = (value: string, currency: string): number | null => {
  const m = /^(\d*)(?:\.(\d+))?$/.exec(value)
  if (!m || value === '') return null
  const decimals = ZERO_DECIMAL.has(currency) ? 0 : 2
  const frac = m[2] ?? ''
  if (frac.length > decimals) return null
  return Number(m[1]) * 10 ** decimals + Number(frac.padEnd(decimals, '0') || '0')
}

const paypalId = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  return [...randomBytes(17)].map((b) => chars[b % chars.length]).join('')
}

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string,
    readonly issue: string,
    readonly description: string,
    readonly field?: string,
  ) {
    super(description)
  }
}
const invalid = (issue: string, field: string, description: string) =>
  new Refused(400, 'INVALID_REQUEST', issue, description, field)
const unprocessable = (issue: string, description: string) =>
  new Refused(422, 'UNPROCESSABLE_ENTITY', issue, description)
const MESSAGES: Record<string, string> = {
  INVALID_REQUEST: 'Request is not well-formed, syntactically incorrect, or violates schema.',
  AUTHENTICATION_FAILURE:
    'Authentication failed due to missing Authorization header, or invalid authentication credentials.',
  RESOURCE_NOT_FOUND: 'The specified resource does not exist.',
  UNPROCESSABLE_ENTITY:
    'The requested action could not be performed, semantically incorrect, or failed business validation.',
}

/**
 * The raw text of the top-level `key` value in a JSON object, exactly as written. Used to read `webhook_event` from the
 * postback without re-serialising it.
 */
function rawMember(json: string, key: string): string | undefined {
  // Walks the top-level object only: a key is a string at depth 1 followed by ':'.
  let depth = 0
  let valueStart = -1
  for (let i = 0; i < json.length; i++) {
    const c = json[i]
    if (c === '"') {
      const from = i
      for (i++; i < json.length && json[i] !== '"'; i++) if (json[i] === '\\') i++
      if (depth !== 1 || valueStart >= 0) continue
      let k = i + 1
      while (/\s/.test(json[k] ?? '')) k++
      if (json[k] !== ':' || json.slice(from, i + 1) !== `"${key}"`) continue
      k++
      while (/\s/.test(json[k] ?? '')) k++
      valueStart = k
      i = k - 1
    } else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (valueStart >= 0 && depth === 1) return json.slice(valueStart, i + 1)
    }
  }
  return undefined
}

export async function startFakePayPal(opts: {
  clientId: string
  clientSecret: string
  /** The id PayPal gives the webhook (listener) of this app; every verification must name it [§5]. */
  webhookId: string
  /** `expires_in` of a new token; the docs' sample is 31668 seconds [§1]. */
  tokenTtlSeconds?: number
}): Promise<FakePayPal> {
  const ttl = opts.tokenTtlSeconds ?? 32400
  const signingKey = randomBytes(32)
  const tokens = new Map<string, number>()
  const orders = new Map<string, PayPalOrder>()
  const captures = new Map<string, { capture: PayPalCapture; orderId: string }>()
  const refunds = new Map<string, PayPalRefund>()
  const replies = new Map<string, { status: number; body: unknown }>()
  const captureOutcome = new Map<string, 'DECLINED' | 'PENDING'>()
  const refundOutcome = new Map<string, 'PENDING'>()
  const requests: FakePayPal['requests'] = []
  const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  let url = ''

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d) => {
      raw += d
    })
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      const send = (status: number, o?: unknown) => {
        res.writeHead(status, o === undefined ? {} : { 'content-type': 'application/json' })
        res.end(o === undefined ? undefined : JSON.stringify(o))
      }
      const debug_id = randomBytes(7).toString('hex').slice(0, 13)
      const fail = (e: Refused) =>
        send(e.status, {
          name: e.errorName,
          message: MESSAGES[e.errorName] ?? e.errorName,
          debug_id,
          details: [
            {
              ...(e.field ? { field: e.field, location: 'body' } : {}),
              issue: e.issue,
              description: e.description,
            },
          ],
          links: [],
        })
      let body: unknown = null
      if (raw && path !== '/v1/oauth2/token') {
        try {
          body = JSON.parse(raw)
        } catch {
          body = undefined
        }
      }
      requests.push({ method: req.method ?? '', path, body: body ?? raw, headers: req.headers })

      if (req.method === 'POST' && path === '/v1/oauth2/token') return token(req, raw, send)

      const auth = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
      const expires = auth ? tokens.get(auth) : undefined
      if (expires === undefined || expires <= Date.now()) {
        return send(401, {
          name: 'AUTHENTICATION_FAILURE',
          message: MESSAGES.AUTHENTICATION_FAILURE,
          debug_id,
          links: [],
        })
      }
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          return fail(
            new Refused(415, 'UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json.'),
          )
        }
        if (body === undefined || (raw && (typeof body !== 'object' || body === null))) {
          return fail(invalid('MALFORMED_REQUEST_JSON', '/', 'The request JSON is not well formed.'))
        }
      }
      const requestId = req.headers['paypal-request-id']
      const once = (kind: string, run: () => { status: number; body: unknown }) => {
        if (typeof requestId !== 'string' || !requestId) {
          const r = run()
          return send(r.status, r.body)
        }
        if (requestId.length > 108) {
          return fail(invalid('INVALID_STRING_LENGTH', 'PayPal-Request-Id', 'At most 108 characters.'))
        }
        const key = `${kind}:${requestId}`
        const seen = replies.get(key)
        if (seen) return send(200, seen.body)
        const r = run()
        replies.set(key, r)
        return send(r.status, r.body)
      }
      const minimal = !String(req.headers.prefer ?? '').includes('return=representation')

      try {
        if (req.method === 'POST' && path === '/v2/checkout/orders') {
          return once('create', () => {
            const o = create(obj(body))
            return {
              status: 201,
              body: minimal ? { id: o.id, status: o.status, links: o.links } : o,
            }
          })
        }
        const get = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(path)
        if (req.method === 'GET' && get) return send(200, findOrder(get[1] ?? ''))
        const cap = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(path)
        if (req.method === 'POST' && cap) {
          return once(`capture:${cap[1]}`, () => ({ status: 201, body: captureOrder(cap[1] ?? '') }))
        }
        const getCap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(path)
        if (req.method === 'GET' && getCap) return send(200, findCapture(getCap[1] ?? '').capture)
        const ref = /^\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/.exec(path)
        if (req.method === 'POST' && ref) {
          return once(`refund:${ref[1]}`, () => ({ status: 201, body: refund(ref[1] ?? '', obj(body)) }))
        }
        const getRef = /^\/v2\/payments\/refunds\/([A-Z0-9]+)$/.exec(path)
        if (req.method === 'GET' && getRef) {
          const r = refunds.get(getRef[1] ?? '')
          if (!r) throw notFound(getRef[1] ?? '')
          return send(200, r)
        }
        if (req.method === 'POST' && path === '/v1/notifications/verify-webhook-signature') {
          return send(200, { verification_status: verify(obj(body), raw) })
        }
        return send(404, {
          name: 'RESOURCE_NOT_FOUND',
          message: MESSAGES.RESOURCE_NOT_FOUND,
          debug_id,
          details: [{ issue: 'INVALID_URI', description: `${req.method} ${path}` }],
          links: [],
        })
      } catch (e) {
        if (e instanceof Refused) return fail(e)
        throw e
      }
    })
  })

  function token(req: IncomingMessage, raw: string, send: (status: number, o?: unknown) => void) {
    const basic = /^Basic (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    const expected = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')
    if (!basic || basic !== expected) {
      return send(401, { error: 'invalid_client', error_description: 'Client Authentication failed' })
    }
    if (!String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
      return send(400, { error: 'invalid_request', error_description: 'Send a form body.' })
    }
    if (new URLSearchParams(raw).get('grant_type') !== 'client_credentials') {
      return send(400, {
        error: 'unsupported_grant_type',
        error_description: 'Grant Type is NULL or unsupported',
      })
    }
    const access_token = `A21AA${randomBytes(24).toString('base64url')}`
    tokens.set(access_token, Date.now() + ttl * 1000)
    send(200, {
      scope: 'https://uri.paypal.com/services/payments/refund',
      access_token,
      token_type: 'Bearer',
      app_id: `APP-${paypalId()}`,
      expires_in: ttl,
      nonce: `${iso()}${randomBytes(8).toString('hex')}`,
    })
  }

  const notFound = (id: string) =>
    new Refused(
      404,
      'RESOURCE_NOT_FOUND',
      'INVALID_RESOURCE_ID',
      `Specified resource ID ${id} does not exist.`,
    )

  function findOrder(id: string): PayPalOrder {
    const o = orders.get(id)
    if (!o) throw notFound(id)
    return o
  }
  function findCapture(id: string) {
    const c = captures.get(id)
    if (!c) throw notFound(id)
    return c
  }

  function create(body: Body): PayPalOrder {
    if (body.intent !== 'CAPTURE') {
      if (body.intent === undefined)
        throw invalid('MISSING_REQUIRED_PARAMETER', '/intent', 'intent is required.')
      throw invalid('INVALID_PARAMETER_VALUE', '/intent', 'fake PayPal: only intent CAPTURE (pay now).')
    }
    const units = body.purchase_units
    if (!Array.isArray(units) || units.length < 1) {
      throw invalid('INVALID_ARRAY_MIN_ITEMS', '/purchase_units', 'At least one purchase unit.')
    }
    if (units.length > 1) {
      throw invalid('INVALID_PARAMETER_VALUE', '/purchase_units', 'fake PayPal: one purchase unit.')
    }
    const unit = obj(units[0])
    const amount = obj(unit.amount)
    const currency = amount.currency_code
    if (typeof currency !== 'string' || !CURRENCIES.has(currency)) {
      throw invalid(
        'INVALID_CURRENCY_CODE',
        '/purchase_units/@reference_id==default/amount/currency_code',
        'Currency code is invalid or is not currently supported.',
      )
    }
    const value = amount.value
    if (
      typeof value !== 'string' ||
      value.length > 32 ||
      !/^((-?[0-9]+)|(-?([0-9]+)?[.][0-9]+))$/.test(value)
    ) {
      throw invalid(
        'INVALID_PARAMETER_SYNTAX',
        '/purchase_units/@reference_id==default/amount/value',
        'amount.value must be a decimal string.',
      )
    }
    if (value.startsWith('-'))
      throw unprocessable('AMOUNT_NOT_POSITIVE', 'amount.value must be greater than zero.')
    const minor = toMinor(value, currency)
    if (minor === null) {
      throw unprocessable(
        'DECIMAL_PRECISION',
        `${currency} takes ${ZERO_DECIMAL.has(currency) ? 'no' : 'at most two'} decimal places.`,
      )
    }
    if (minor <= 0) throw unprocessable('AMOUNT_NOT_POSITIVE', 'amount.value must be greater than zero.')
    for (const [field, max] of [
      ['custom_id', 255],
      ['invoice_id', 127],
      ['reference_id', 256],
    ] as const) {
      const v = unit[field]
      if (v !== undefined && (typeof v !== 'string' || v.length < 1 || v.length > max)) {
        throw invalid(
          'INVALID_STRING_LENGTH',
          `/purchase_units/@reference_id==default/${field}`,
          `${field}: 1 to ${max}.`,
        )
      }
    }
    const id = paypalId()
    const action = Object.keys(obj(obj(obj(body.payment_source).paypal).experience_context)).length > 0
    const now = iso()
    const order: PayPalOrder = {
      id,
      intent: 'CAPTURE',
      status: action ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
      purchase_units: [
        {
          ...unit,
          reference_id: typeof unit.reference_id === 'string' ? unit.reference_id : 'default',
          amount: { currency_code: currency, value },
          ...(typeof unit.description === 'string' ? { description: unit.description.slice(0, 127) } : {}),
        },
      ],
      ...(body.payment_source ? { payment_source: body.payment_source } : {}),
      create_time: now,
      update_time: now,
      links: [
        { href: `${url}/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' },
        { href: `${url}/checkoutnow?token=${id}`, rel: action ? 'payer-action' : 'approve', method: 'GET' },
        { href: `${url}/v2/checkout/orders/${id}`, rel: 'update', method: 'PATCH' },
        { href: `${url}/v2/checkout/orders/${id}/capture`, rel: 'capture', method: 'POST' },
      ],
    }
    orders.set(id, order)
    return order
  }

  function captureOrder(id: string): PayPalOrder {
    const o = findOrder(id)
    if (o.status === 'COMPLETED') {
      throw unprocessable('ORDER_ALREADY_CAPTURED', 'Order already captured.')
    }
    if (o.status !== 'APPROVED') {
      throw unprocessable('ORDER_NOT_APPROVED', 'Payer has not yet approved the Order for payment.')
    }
    const unit = o.purchase_units[0]
    if (!unit) throw notFound(id)
    const outcome = captureOutcome.get(id)
    captureOutcome.delete(id)
    const now = iso()
    const captureId = paypalId()
    const capture: PayPalCapture = {
      id: captureId,
      status: outcome ?? 'COMPLETED',
      ...(outcome === 'PENDING' ? { status_details: { reason: 'PENDING_REVIEW' } } : {}),
      amount: { ...unit.amount },
      ...(unit.custom_id ? { custom_id: unit.custom_id } : {}),
      ...(unit.invoice_id ? { invoice_id: unit.invoice_id } : {}),
      final_capture: true,
      seller_receivable_breakdown: { gross_amount: { ...unit.amount } },
      supplementary_data: { related_ids: { order_id: id } },
      create_time: now,
      update_time: now,
      links: [
        { href: `${url}/v2/payments/captures/${captureId}`, rel: 'self', method: 'GET' },
        { href: `${url}/v2/payments/captures/${captureId}/refund`, rel: 'refund', method: 'POST' },
        { href: `${url}/v2/checkout/orders/${id}`, rel: 'up', method: 'GET' },
      ],
    }
    captures.set(captureId, { capture, orderId: id })
    unit.payments = { captures: [capture] }
    o.status = 'COMPLETED'
    o.update_time = now
    o.links = o.links.filter((l) => l.rel === 'self')
    return o
  }

  function refund(captureId: string, body: Body): PayPalRefund {
    const { capture, orderId } = findCapture(captureId)
    if (capture.status !== 'COMPLETED' && capture.status !== 'PARTIALLY_REFUNDED') {
      throw unprocessable('CAPTURE_STATUS_NOT_VALID', `The capture is ${capture.status}.`)
    }
    const currency = capture.amount.currency_code
    const done = [...refunds.values()]
      .filter((r) => r.capture_id === captureId && r.status !== 'FAILED' && r.status !== 'CANCELLED')
      .reduce((s, r) => s + (toMinor(r.amount.value, currency) ?? 0), 0)
    const left = (toMinor(capture.amount.value, currency) ?? 0) - done
    let minor = left
    if (body.amount !== undefined) {
      const a = obj(body.amount)
      if (a.currency_code !== currency) {
        throw unprocessable('REFUND_CURRENCY_MISMATCH', `Refund in ${currency}, the capture's currency.`)
      }
      const m = typeof a.value === 'string' ? toMinor(a.value, currency) : null
      if (m === null)
        throw invalid('INVALID_PARAMETER_SYNTAX', '/amount/value', 'amount.value must be a decimal string.')
      if (m <= 0) throw unprocessable('AMOUNT_NOT_POSITIVE', 'amount.value must be greater than zero.')
      minor = m
    }
    if (minor > left || left <= 0) {
      throw unprocessable(
        'REFUND_AMOUNT_EXCEEDED',
        'The refund amount must be less than or equal to the capture amount that has not yet been refunded.',
      )
    }
    const status = refundOutcome.get(captureId) ?? 'COMPLETED'
    refundOutcome.delete(captureId)
    const now = iso()
    const id = paypalId()
    const r: PayPalRefund = {
      id,
      status,
      ...(status === 'PENDING' ? { status_details: { reason: 'ECHECK' } } : {}),
      amount: { currency_code: currency, value: toValue(minor, currency) },
      capture_id: captureId,
      ...(typeof body.note_to_payer === 'string' ? { note_to_payer: body.note_to_payer } : {}),
      ...(capture.custom_id ? { custom_id: capture.custom_id } : {}),
      create_time: now,
      update_time: now,
      links: [
        { href: `${url}/v2/payments/refunds/${id}`, rel: 'self', method: 'GET' },
        { href: `${url}/v2/payments/captures/${captureId}`, rel: 'up', method: 'GET' },
      ],
    }
    refunds.set(id, r)
    capture.status = minor === left ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    capture.update_time = now
    const payments = orders.get(orderId)?.purchase_units[0]?.payments
    if (payments) payments.refunds = [...(payments.refunds ?? []), r]
    return r
  }

  const sign = (headers: Record<string, string>, rawEvent: string) =>
    createHmac('sha256', signingKey)
      .update(
        [
          headers['paypal-transmission-id'],
          headers['paypal-transmission-time'],
          opts.webhookId,
          createHash('sha256').update(rawEvent, 'utf8').digest('hex'),
        ].join('|'),
      )
      .digest('base64')

  function verify(body: Body, raw: string): 'SUCCESS' | 'FAILURE' {
    const required = [
      'auth_algo',
      'cert_url',
      'transmission_id',
      'transmission_sig',
      'transmission_time',
      'webhook_id',
      'webhook_event',
    ]
    for (const f of required) {
      if (body[f] === undefined || body[f] === null || body[f] === '') {
        throw invalid('MISSING_REQUIRED_PARAMETER', `/${f}`, `${f} is required.`)
      }
    }
    const rawEvent = rawMember(raw, 'webhook_event')
    if (body.webhook_id !== opts.webhookId || body.auth_algo !== 'SHA256withRSA' || !rawEvent)
      return 'FAILURE'
    const expected = Buffer.from(
      sign(
        {
          'paypal-transmission-id': String(body.transmission_id),
          'paypal-transmission-time': String(body.transmission_time),
        },
        rawEvent,
      ),
    )
    const given = Buffer.from(String(body.transmission_sig))
    return given.length === expected.length && timingSafeEqual(given, expected) ? 'SUCCESS' : 'FAILURE'
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const known = (id: string) => {
    const o = orders.get(id)
    if (!o) throw new Error(`fake PayPal: no order ${id}`)
    return o
  }
  const approve = (id: string) => {
    const o = known(id)
    if (o.status !== 'CREATED' && o.status !== 'PAYER_ACTION_REQUIRED') return
    o.status = 'APPROVED'
    o.update_time = iso()
    o.payer = { payer_id: paypalId().slice(0, 13), email_address: 'buyer@example.com' }
  }

  return {
    url,
    requests,
    order: (id) => orders.get(id),
    capture: (id) => captures.get(id)?.capture,
    refund: (id) => refunds.get(id),
    approve,
    markPaid(id) {
      approve(id)
      if (known(id).status === 'APPROVED') captureOrder(id)
    },
    nextCapture(id, status) {
      known(id)
      captureOutcome.set(id, status)
    },
    nextRefund(captureId, status) {
      if (!captures.has(captureId)) throw new Error(`fake PayPal: no capture ${captureId}`)
      refundOutcome.set(captureId, status)
    },
    expireTokens() {
      for (const t of tokens.keys()) tokens.set(t, 0)
    },
    /**
     * A `PAYMENT.CAPTURE.COMPLETED` event claiming payment (even before `markPaid`: the capture in it is the order's
     * real one when there is one, else made up, and the fake's record stays unpaid). `override` changes fields of the
     * capture `resource` before signing; the key `event_type` changes the event instead.
     */
    callbackFor(id, override = {}) {
      const { event_type, ...fields } = override
      const o = known(id)
      const unit = o.purchase_units[0]
      const real = unit?.payments?.captures[0]
      const now = iso()
      const resource = {
        ...(real ?? {
          id: paypalId(),
          amount: unit?.amount,
          ...(unit?.custom_id ? { custom_id: unit.custom_id } : {}),
          final_capture: true,
          supplementary_data: { related_ids: { order_id: id } },
          create_time: now,
          update_time: now,
        }),
        status: 'COMPLETED',
        ...fields,
      }
      const event = {
        id: `WH-${paypalId()}-${paypalId()}`,
        event_version: '1.0',
        create_time: now,
        resource_type: 'capture',
        resource_version: '2.0',
        event_type: event_type ?? 'PAYMENT.CAPTURE.COMPLETED',
        summary: `Payment completed for ${resource.amount?.value} ${resource.amount?.currency_code}`,
        resource,
      }
      // Indented, so a handler that re-serialises the parsed JSON posts different bytes and verification fails.
      const rawBody = JSON.stringify(event, null, 2)
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'paypal-transmission-id': randomBytes(16).toString('hex'),
        'paypal-transmission-time': now,
        'paypal-cert-url': `${url}/v1/notifications/certs/CERT-fake`,
        'paypal-auth-algo': 'SHA256withRSA',
      }
      headers['paypal-transmission-sig'] = sign(headers, rawBody)
      return { fields: {}, rawBody, headers }
    },
    tamper: (cb) => ({
      ...cb,
      headers: {
        ...cb.headers,
        'paypal-transmission-sig': flip(cb.headers['paypal-transmission-sig'] ?? ''),
      },
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
