/**
 * PayPal Orders v2 adapter: one-time orders (intent CAPTURE), capture, webhooks and refunds over raw REST (no PayPal
 * SDK, zero runtime dependencies).
 *
 * Written from the official docs, read 29 October 2026 (`gateways/paypal/spec.md`, a source next to every fact):
 * developer.paypal.com and the OpenAPI files in paypal/paypal-rest-api-specifications. Measured on the sandbox
 * 30 October 2026 (spec "Measured"): a sandbox buyer approving on PayPal, captures in USD, MYR and JPY, real webhooks
 * verified by the postback, full and partial refunds. The adapter needed no change; what the docs left open:
 * - A capture in a currency the account does not hold (JPY) is `PENDING` with
 *   `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION` and sends `PAYMENT.CAPTURE.PENDING`, so `confirmPayment` says
 *   `not_paid`. MYR captured `COMPLETED` on the sandbox business account used.
 * - Only `PAYMENT.CAPTURE.*` arrives after a capture (about 15 s later); `CHECKOUT.ORDER.COMPLETED` never did. A
 *   `PAYMENT.CAPTURE.REFUNDED` event carries the refund, which names no order, so it verifies as `null`: send refund
 *   events elsewhere, not to `confirmPayment`.
 * - Refunds were `COMPLETED` at once; the capture becomes `PARTIALLY_REFUNDED`, then `REFUNDED`.
 * - A retried webhook is the same delivery (same body, transmission id, time and signature) and still verifies;
 *   so does an event several minutes old. Deduplicate on the event id.
 *
 * - Auth: OAuth 2.0 client credentials (`POST /v1/oauth2/token`, HTTP Basic). The token is cached until a minute
 *   before `expires_in` runs out and fetched again then, or once when PayPal answers 401 to a cached one. Neither the
 *   client secret nor a token ever appears in an error.
 * - Hosts: `environment: 'sandbox'` (the default, so a forgotten setting never moves real money) or `'live'`.
 * - Amounts are integers in PayPal's smallest unit both ways (sen for MYR, cents for USD; whole units for HUF, JPY and
 *   TWD, which PayPal takes without decimals even where ISO 4217 has two). The adapter converts to and from PayPal's
 *   decimal strings (`toPayPalValue`, `fromPayPalValue`); no API takes ringgit or decimals.
 * - Currency: `currency` in the config (default USD) is `info.currency`; an order may name another of PayPal's 24.
 *   MYR works only for a Malaysian PayPal account; a currency the account does not hold can leave the capture
 *   `PENDING` until the merchant accepts it in PayPal.
 * - The reference goes in `purchase_units[0].custom_id` (1–255, not shown to the buyer, copied onto each capture).
 *   `invoice_id` is not used: PayPal shows it to the buyer and refuses it twice per account by default.
 * - `createPayment` sends `payment_source.paypal.experience_context` with `returnUrl` as both return and cancel URL,
 *   so the order is `PAYER_ACTION_REQUIRED` and the buyer link is `rel: payer-action` (`rel: approve` is accepted
 *   too). `callbackUrl` is not sent: PayPal has no per-order webhook; add a webhook to the REST app and pass its id as
 *   `webhookId`. `expiresAt` is not sent (PayPal has no field for it). `idempotencyKey` becomes `PayPal-Request-Id`.
 * - Paying is two steps. The buyer approves on PayPal (order `APPROVED`: nothing has moved, NOT paid), then the app
 *   calls `capturePayment(orderId)` on the return URL or on the `CHECKOUT.ORDER.APPROVED` webhook. `getPayment` only
 *   reads and never captures. `paid` = the order's capture is `COMPLETED`; an order `COMPLETED` with a `DECLINED`
 *   capture is failed, a `PENDING` capture is pending. A refunded capture still reads as paid (as Stripe and Paddle
 *   do); the refund is the `RefundRecord`. The order is marked paid with `confirmPayment` on the
 *   `PAYMENT.CAPTURE.COMPLETED` webhook, which carries the order id in `supplementary_data.related_ids.order_id`.
 * - `capturePayment` always sends a `PayPal-Request-Id` (`capture-<order id>` unless you pass one), so a retried
 *   capture returns the first result instead of capturing again.
 * - Refunds take the capture id, read from the order: `POST /v2/payments/captures/{id}/refund` with the amount. What
 *   may still be refunded = the capture minus the order's refunds that are not `FAILED`/`CANCELLED`. `PENDING` =
 *   `pending`, `COMPLETED` = `succeeded`, `FAILED`/`CANCELLED` = `failed`.
 *
 * Webhook verification is PayPal's postback: the five `PAYPAL-*` headers, your `webhookId` and the event go to
 * `POST /v1/notifications/verify-webhook-signature`, which answers `SUCCESS` or `FAILURE`. The docs ask for the event
 * exactly as received, so the raw body is spliced into the request (after checking it parses as one JSON object),
 * never re-serialised. A missing header or a body that is not a JSON object is refused without calling PayPal.
 * `FAILURE` = `null`; a failed call to PayPal rejects, which `confirmPayment` reports as `gateway_error`, not as a
 * forgery. Simulator ("mock") events cannot be verified this way (PayPal says so); use real sandbox events. The docs
 * name no replay window: deduplicate on the event id (`raw.event_id`).
 */
import {
  type CallbackInput,
  type CreatedPayment,
  type CreatePaymentInput,
  checkRefundAmount,
  type Gateway,
  GatewayError,
  type GatewayInfo,
  type PaymentRecord,
  type PaymentStatus,
  type RefundInput,
  type RefundRecord,
  type RefundStatus,
  type VerifiedCallback,
} from '@bayarkit/core'

const SANDBOX_HOST = 'api-m.sandbox.paypal.com'
const LIVE_HOST = 'api-m.paypal.com'

/** The 24 currencies PayPal lists (spec §7). MYR only for a Malaysian account. */
export const CURRENCIES: readonly string[] =
  'AUD BRL CAD CNY CZK DKK EUR HKD HUF ILS JPY MYR MXN TWD NZD NOK PHP PLN GBP SGD SEK CHF THB USD'.split(' ')
/** No decimal places in PayPal, whatever ISO 4217 says (spec §7). */
export const ZERO_DECIMAL: readonly string[] = ['HUF', 'JPY', 'TWD']
const REFERENCE_MAX = 255
const REQUEST_ID_MAX = 108
/** Refresh a cached token this long before PayPal says it expires. */
const TOKEN_MARGIN_MS = 60_000
/** The webhook headers that go into the postback (spec §5). */
const HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const

export interface PayPalConfig {
  /** The REST app's client id (sandbox and live apps have different ones). */
  clientId: string
  clientSecret: string
  /** The id PayPal gave the webhook you added to this app; every verification names it. */
  webhookId: string
  /** Default `sandbox`. */
  environment?: 'sandbox' | 'live'
  /** The currency an order is charged in when it names none, and `info.currency`. Default `USD`. */
  currency?: string
  /** Shown on the PayPal page instead of the account's business name (at most 127 characters). */
  brandName?: string
  /** Default `NO_SHIPPING` (no address asked); `GET_FROM_FILE` asks for one. */
  shippingPreference?: 'NO_SHIPPING' | 'GET_FROM_FILE'
  /** Override the host (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export const info: GatewayInfo = {
  name: 'paypal',
  minimumAmount: 1,
  currency: 'USD',
  evidence: {
    kind: 'measured',
    date: '2026-10-30',
    source:
      'PayPal sandbox: buyer approval, captures (USD, MYR, JPY pending), real webhooks, refunds; developer.paypal.com',
  },
}

const decimalsOf = (currency: string) => (ZERO_DECIMAL.includes(currency) ? 0 : 2)

/** An integer in PayPal's smallest unit as the decimal string PayPal takes: `1050` USD → `"10.50"`, `500` JPY → `"500"`. */
export function toPayPalValue(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError('amount must be a whole number ≥ 0')
  if (decimalsOf(currency) === 0) return String(minor)
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`
}

/** A PayPal decimal string back to the smallest unit; NaN for anything else (more decimals than the currency has). */
export function fromPayPalValue(value: unknown, currency: string): number {
  if (typeof value !== 'string') return Number.NaN
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(value)
  if (!m) return Number.NaN
  const decimals = decimalsOf(currency)
  const frac = m[2] ?? ''
  if (frac.length > decimals && !/^0*$/.test(frac.slice(decimals))) return Number.NaN
  return Number(m[1]) * 10 ** decimals + Number(frac.slice(0, decimals).padEnd(decimals, '0') || '0')
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : [])
const text = (v: unknown) => (typeof v === 'string' ? v : '')
/** PayPal order and capture ids are upper-case letters and digits; anything else never reaches a URL. */
const ID = /^[A-Z0-9]{1,64}$/
/** Access tokens (`A21AA…`) and Basic credentials, should PayPal ever echo one. */
const SECRETISH = /\b(A21AA[A-Za-z0-9_-]+|Basic\s+[A-Za-z0-9+/=]+)/g

const captureStatus = (s: unknown): PaymentStatus => {
  switch (s) {
    case 'COMPLETED':
    case 'PARTIALLY_REFUNDED':
    case 'REFUNDED':
      return 'paid'
    case 'PENDING':
      return 'pending'
    case 'DECLINED':
    case 'FAILED':
      return 'failed'
    default:
      return 'unknown'
  }
}

const orderStatus = (s: unknown): PaymentStatus => {
  switch (s) {
    case 'CREATED':
    case 'SAVED':
    case 'PAYER_ACTION_REQUIRED':
    case 'APPROVED': // the buyer said yes; nothing is captured
      return 'pending'
    case 'VOIDED':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

const refundStatus = (s: unknown): RefundStatus =>
  s === 'PENDING'
    ? 'pending'
    : s === 'COMPLETED'
      ? 'succeeded'
      : s === 'FAILED' || s === 'CANCELLED'
        ? 'failed'
        : 'unknown'

const headerOf = (headers: Record<string, unknown>, name: string): string => {
  const v = headers[name] ?? Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]
  return typeof v === 'string' ? v : ''
}

export function paypal(config: PayPalConfig): Gateway<Promise<VerifiedCallback | null>> & {
  readonly info: GatewayInfo & { currency: string }
  /**
   * Capture an order the buyer approved. Idempotent: the same `idempotencyKey` (default `capture-<orderId>`) returns the
   * first capture. The record is PayPal's answer; mark the order paid with `confirmPayment` on the webhook.
   */
  capturePayment(orderId: string, opts?: { idempotencyKey?: string }): Promise<PaymentRecord>
  refundPayment(input: RefundInput): Promise<RefundRecord>
} {
  const fail = (message: string, code: string) => new GatewayError(message, 'paypal', 0, code)
  if (!config.clientId || !config.clientSecret) throw fail('clientId and clientSecret are required', 'CONFIG')
  if (!config.webhookId)
    throw fail('webhookId is required (the id of the webhook on your REST app)', 'CONFIG')
  const environment = config.environment ?? 'sandbox'
  if (environment !== 'sandbox' && environment !== 'live') {
    throw fail("environment must be 'sandbox' or 'live'", 'CONFIG')
  }
  const base = (config.baseUrl ?? `https://${environment === 'live' ? LIVE_HOST : SANDBOX_HOST}`).replace(
    /\/+$/,
    '',
  )
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const currency = config.currency ?? 'USD'
  if (!CURRENCIES.includes(currency)) {
    throw fail(`PayPal does not take ${currency}; pick one of ${CURRENCIES.join(', ')}`, 'CURRENCY')
  }
  const gatewayInfo = { ...info, currency }

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, 'paypal', 0)
    }
  }

  let token: { value: string; until: number } | null = null
  let pending: Promise<string> | null = null
  async function fetchToken(): Promise<string> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
    const res = await send(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    })
    const json = obj(await res.json().catch(() => null))
    const value = text(json.access_token)
    const seconds = typeof json.expires_in === 'number' ? json.expires_in : 0
    if (!res.ok || !value) {
      // OAuth's own words (`error`, `error_description`) only.
      const words = [text(json.error), text(json.error_description)].filter(Boolean).join(': ')
      throw new GatewayError(
        `token: ${(words || `HTTP ${res.status}`).replace(SECRETISH, '[redacted]')}`,
        'paypal',
        res.status,
        text(json.error) || undefined,
      )
    }
    token = { value, until: Date.now() + seconds * 1000 - TOKEN_MARGIN_MS }
    return value
  }
  async function bearer(): Promise<string> {
    if (token && token.until > Date.now()) return token.value
    // One token request at a time: concurrent calls wait for the same one.
    pending ??= fetchToken().finally(() => {
      pending = null
    })
    return pending
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: Json | string,
    requestId?: string,
  ): Promise<Json> {
    const call = async (value: string) => {
      const headers: Record<string, string> = {
        authorization: `Bearer ${value}`,
        accept: 'application/json',
        prefer: 'return=representation',
      }
      if (body !== undefined) headers['content-type'] = 'application/json'
      if (requestId) headers['paypal-request-id'] = requestId
      return send(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      })
    }
    const used = await bearer()
    let res = await call(used)
    if (res.status === 401) {
      // PayPal ended the token early: fetch a new one once.
      if (token?.value === used) token = null
      res = await call(await bearer())
    }
    const json = (await res.json().catch(() => null)) as Json | null
    if (!res.ok || !json) {
      // PayPal's own words only: `name`, `details[].issue`, `details[].description`, `debug_id`.
      const e = obj(json)
      const detail = list(e.details)[0] ?? {}
      const words =
        [text(e.name), text(detail.issue), text(detail.description) || text(e.message)]
          .filter(Boolean)
          .join(': ') || `HTTP ${res.status}`
      const debug = text(e.debug_id)
      throw new GatewayError(
        `${words}${debug ? ` (debug_id ${debug})` : ''}`.replace(SECRETISH, '[redacted]'),
        'paypal',
        res.status,
        text(detail.issue) || text(e.name) || undefined,
      )
    }
    return json
  }

  const unitOf = (order: Json) => list(order.purchase_units)[0] ?? {}
  const captureOf = (order: Json) => list(obj(unitOf(order).payments).captures)[0]

  const toRecord = (order: Json, id: string): PaymentRecord => {
    const unit = unitOf(order)
    const capture = captureOf(order)
    const money = obj(capture ? capture.amount : unit.amount)
    const code = text(money.currency_code)
    // Paid is read from the capture, never from the order: a COMPLETED order can hold a DECLINED capture.
    const status = capture ? captureStatus(capture.status) : orderStatus(order.status)
    const feeMoney = capture ? obj(obj(capture.seller_receivable_breakdown).paypal_fee) : {}
    const fee = fromPayPalValue(feeMoney.value, text(feeMoney.currency_code))
    const paidAt = capture && status === 'paid' ? new Date(text(capture.create_time)) : undefined
    return {
      id: text(order.id) || id,
      reference: text(unit.custom_id),
      status,
      amount: fromPayPalValue(money.value, code),
      currency: code,
      ...(paidAt && !Number.isNaN(paidAt.getTime()) ? { paidAt } : {}),
      fee: Number.isNaN(fee) ? null : fee,
      raw: order,
    }
  }

  const checkId = (id: string) => {
    if (typeof id !== 'string' || !ID.test(id)) throw fail('invalid order id', 'INVALID_ID')
  }
  const checkRequestId = (key: string | undefined) => {
    if (key !== undefined && (typeof key !== 'string' || !key || key.length > REQUEST_ID_MAX)) {
      throw fail(`idempotencyKey must be 1 to ${REQUEST_ID_MAX} characters`, 'INVALID_KEY')
    }
  }
  async function getPayment(id: string): Promise<PaymentRecord> {
    checkId(id)
    return toRecord(await request('GET', `/v2/checkout/orders/${id}`), id)
  }

  /** Postback check (see the header comment). Resolves null for anything not authentic; rejects when PayPal fails. */
  async function verify(cb: CallbackInput): Promise<VerifiedCallback | null> {
    let rawBody = ''
    let event: Json = {}
    const fields: Record<string, string> = {}
    try {
      const headers = (cb?.headers ?? {}) as Record<string, unknown>
      for (const [field, name] of Object.entries(HEADERS)) fields[field] = headerOf(headers, name)
      rawBody = typeof cb?.rawBody === 'string' ? cb.rawBody : ''
      if (!rawBody || Object.values(fields).some((v) => !v)) return null
      // Parsing proves the raw text is exactly one JSON object, so splicing it below cannot add other fields.
      const parsed: unknown = JSON.parse(rawBody)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      event = parsed as Json
    } catch {
      return null
    }
    const head = JSON.stringify({ ...fields, webhook_id: config.webhookId })
    const answer = await request(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      `${head.slice(0, -1)},"webhook_event":${rawBody}}`,
    )
    if (answer.verification_status !== 'SUCCESS') return null

    // Authentic. Only checkout-order and capture events name an order; anything else is not a payment callback.
    const type = text(event.event_type)
    const resource = obj(event.resource)
    let orderId = ''
    let captureId = ''
    let reference = ''
    let claimedStatus: PaymentStatus = 'unknown'
    if (type.startsWith('CHECKOUT.ORDER.')) {
      const record = toRecord(resource, text(resource.id))
      orderId = record.id
      captureId = text(captureOf(resource)?.id)
      reference = record.reference
      claimedStatus = record.status
    } else if (type.startsWith('PAYMENT.CAPTURE.')) {
      orderId = text(obj(obj(resource.supplementary_data).related_ids).order_id)
      captureId = text(resource.id)
      reference = text(resource.custom_id)
      claimedStatus = captureStatus(resource.status)
      if (type === 'PAYMENT.CAPTURE.DENIED') claimedStatus = 'failed'
    }
    if (!ID.test(orderId)) return null
    return {
      id: orderId,
      reference,
      claimedStatus,
      raw: {
        event_id: text(event.id),
        event_type: type,
        order_id: orderId,
        capture_id: captureId,
        reference,
        status: text(resource.status),
      },
    }
  }

  return {
    info: gatewayInfo,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      const code = input.currency ?? currency
      if (!CURRENCIES.includes(code)) throw fail(`PayPal does not take ${code}`, 'CURRENCY')
      if (!Number.isSafeInteger(input.amount) || input.amount < gatewayInfo.minimumAmount) {
        throw fail(`amount must be a whole number of ${code} minor units, at least 1`, 'INVALID_AMOUNT')
      }
      if (!input.reference || input.reference.length > REFERENCE_MAX) {
        throw fail(`reference must be 1 to ${REFERENCE_MAX} characters`, 'INVALID_REFERENCE')
      }
      checkRequestId(input.idempotencyKey)
      const description = input.description?.trim().slice(0, 127)
      const order = await request(
        'POST',
        '/v2/checkout/orders',
        {
          intent: 'CAPTURE',
          purchase_units: [
            {
              custom_id: input.reference,
              amount: { currency_code: code, value: toPayPalValue(input.amount, code) },
              ...(description ? { description } : {}),
            },
          ],
          payment_source: {
            paypal: {
              experience_context: {
                return_url: input.returnUrl,
                cancel_url: input.returnUrl,
                user_action: 'PAY_NOW',
                shipping_preference: config.shippingPreference ?? 'NO_SHIPPING',
                ...(config.brandName ? { brand_name: config.brandName.slice(0, 127) } : {}),
              },
            },
          },
        },
        input.idempotencyKey,
      )
      const id = text(order.id)
      const link = list(order.links).find((l) => l.rel === 'payer-action' || l.rel === 'approve')
      const url = text(link?.href)
      if (!ID.test(id) || !/^https?:\/\//.test(url)) {
        throw new GatewayError('order without id or approval link', 'paypal', 201)
      }
      return { id, url, raw: order }
    },

    getPayment,

    async capturePayment(orderId: string, opts: { idempotencyKey?: string } = {}): Promise<PaymentRecord> {
      checkId(orderId)
      checkRequestId(opts.idempotencyKey)
      const order = await request(
        'POST',
        `/v2/checkout/orders/${orderId}/capture`,
        {},
        opts.idempotencyKey ?? `capture-${orderId}`,
      )
      return toRecord(order, orderId)
    },

    async refundPayment(input: RefundInput): Promise<RefundRecord> {
      checkRequestId(input.idempotencyKey)
      const record = await getPayment(input.paymentId)
      const capture = captureOf(obj(record.raw))
      if (record.status !== 'paid' || !capture)
        throw fail(`payment is ${record.status}, not paid`, 'NOT_PAID')
      const captureId = text(capture.id)
      if (!ID.test(captureId)) throw fail('the order has no capture id', 'NOT_PAID')
      const refunded = list(obj(unitOf(obj(record.raw)).payments).refunds)
        .filter((r) => r.status !== 'FAILED' && r.status !== 'CANCELLED')
        .reduce((sum, r) => sum + fromPayPalValue(obj(r.amount).value, record.currency), 0)
      const left = capture.status === 'REFUNDED' ? 0 : record.amount - (Number.isNaN(refunded) ? 0 : refunded)
      checkRefundAmount('paypal', input, left)
      const reason = input.reason?.trim().slice(0, 255)
      const r = await request(
        'POST',
        `/v2/payments/captures/${captureId}/refund`,
        {
          amount: { currency_code: record.currency, value: toPayPalValue(input.amount, record.currency) },
          ...(reason ? { note_to_payer: reason } : {}),
        },
        input.idempotencyKey,
      )
      const money = obj(r.amount)
      const code = text(money.currency_code) || record.currency
      return {
        id: text(r.id),
        paymentId: input.paymentId,
        status: refundStatus(r.status),
        amount: fromPayPalValue(money.value, code),
        currency: code,
        raw: r,
      }
    },

    verifyCallback(cb: CallbackInput): Promise<VerifiedCallback | null> {
      return verify(cb)
    },
  }
}
