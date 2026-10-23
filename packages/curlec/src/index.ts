/**
 * Razorpay Curlec adapter: Payment Links (the hosted page) over the Orders API, raw REST, zero runtime dependencies.
 *
 * Written from the official docs only, read 23 October 2026 (`gateways/curlec/spec.md`, a source next to every fact):
 * curlec.com/docs `.md` exports and the official razorpay-node / razorpay-php / razorpay-python signature utilities.
 * Two further official pages were read the same day for facts the spec does not list: the fetched Payment Link carries
 * `order_id` (docs/api/payments/payment-links/fetch-id-standard.md) and the `payment_link.*` webhook events, whose
 * sample shows the link's order with `receipt` = the link's `reference_id` (docs/webhooks/payment-links.md).
 * NOT yet measured against a Test-mode account.
 *
 * - Host `https://api.razorpay.com/v1` for test AND live: the key pair decides the mode [D1, D3, D4]. Auth is HTTP
 *   Basic `base64(key_id:key_secret)`, the scheme spelled exactly `Basic` [D2]. Bodies and answers are JSON.
 * - `createPayment` creates a Standard Payment Link (`POST /v1/payment_links`): it is the only documented way to get a
 *   hosted page URL (`short_url`) from the server. Standard Checkout needs `checkout.js` in YOUR page; for that flow
 *   call `createOrder` and verify its `order_id|razorpay_payment_id` callback here. Amounts are sen both ways.
 * - `getPayment` reports the ORDER's state [OC]: `paid` only when the order is `paid` (`created`/`attempted` =
 *   pending). For a link it fetches the link, then the order the link carries; a link with no order yet is unpaid.
 * - Three callbacks verify, each with its own key:
 *   - webhook: `X-Razorpay-Signature` = hex HMAC-SHA256(**webhook secret**, the RAW body) [WV]. The official Node
 *     sample signs `JSON.stringify(parsedBody)` (WV L134): that is wrong whenever the bytes differ, and is refused;
 *   - Payment Link redirect (GET query): HMAC-SHA256(**API key secret**,
 *     `payment_link_id|reference_id|status|razorpay_payment_id`) [PLA];
 *   - Standard Checkout callback (POST): HMAC-SHA256(**API key secret**, `order_id|razorpay_payment_id`) [CK].
 *   All compare in constant time (the Node SDK's plain `===` does not, contradiction 9). A verified callback is still
 *   only a claim: `confirmPayment` asks the API again.
 * - `input.callbackUrl` is not sent: Payment Links have no per-link webhook URL. Add the webhook in the Dashboard with
 *   a secret and subscribe to `payment_link.paid` (or `order.paid`), and read it with `readCallback` (raw body).
 *
 * Contradictions in the docs (spec §Contradictions) and the side this adapter takes:
 * 1. raw body vs the Node sample's re-serialised JSON → the raw body only; a re-serialised body fails;
 * 4. minimum "greater than 100" vs "equal to or greater than 100" vs "at least MYR 1.00" → `minimumAmount` 100 sen,
 *    following the API's own error text; Curlec has the final word;
 * 5. a link's first state `issued` vs `created` → both read as pending;
 * 6. a Payment Link redirect WITHOUT `razorpay_payment_link_reference_id` (the SDKs disagree: Node signs "undefined",
 *    PHP signs "", Python refuses) → refused. `createPayment` always sets `reference_id`, so a genuine redirect has it;
 * 12. failure POSTs carry an `error` object and no signature → refused (null), never read.
 *
 * Where the spec says UNCONFIRMED (or is silent), the safe choice:
 * - paid time: no `captured_at`/paid time is documented, so `paidAt` is never set; the order reports no fee (`null`);
 * - the posted Checkout `razorpay_order_id` is used as the id (the docs say verify with YOUR stored order id): the
 *   signature binds that order to the payment, and `confirmPayment` then requires the order's `receipt` to equal your
 *   reference, so a valid callback for another order is a mismatch. Use `verifyCheckoutSignature` with your stored id
 *   if you verify outside `confirmPayment`;
 * - failure-callback field naming (`error[code]`?) is unknown → failure callbacks are refused, not parsed;
 * - idempotency: Payment Links take no idempotency header; `reference_id` must be unique, so a retried create with the
 *   same reference is refused by Curlec (an error, never a second link). `idempotencyKey` is therefore not sent;
 * - `expiresAt` → `expire_by`, checked locally to be ≥ 15 minutes ahead and ≤ 180 days ("six months" is not defined
 *   in days, so the shorter reading is used). No order expiry exists;
 * - `customer.phone` is sent as `contact` only with a country code (8–14 characters, no leading 0); a local number is
 *   dropped rather than rewritten (Curlec does not pre-fill it on the page anyway, PLC "Handy Tips");
 * - notifications are off (`notify.sms`/`email` false, no reminders): you redirect the customer yourself, and SMS
 *   links are not available in Malaysia (PLC);
 * - unknown order/link states read as `unknown`, never `paid`; a link that says `paid` without an order is `unknown`;
 * - webhook events other than `payment.authorized|captured|failed`, `order.paid` and `payment_link.*` are refused
 *   (null); a webhook whose payment and order disagree on the order id is refused;
 * - API rate limits are not published: no retry is attempted here.
 */
import { createHmac } from 'node:crypto'
import {
  type CallbackInput,
  type CreatedPayment,
  type CreatePaymentInput,
  type Gateway,
  GatewayError,
  type GatewayInfo,
  type PaymentRecord,
  type PaymentStatus,
  timingSafeEqualText,
  type VerifiedCallback,
} from '@bayarkit/core'

export const API_BASE = 'https://api.razorpay.com'
const NAME = 'curlec'
const MIN_EXPIRY_S = 15 * 60
const MAX_EXPIRY_S = 180 * 24 * 60 * 60
const ORDER_ID = /^order_[A-Za-z0-9]{1,40}$/
const LINK_ID = /^plink_[A-Za-z0-9]{1,40}$/
const PAYMENT_ID = /^pay_[A-Za-z0-9]{1,40}$/
const HEX64 = /^[0-9a-f]{64}$/
/** Printable ASCII, 1–40 characters: `reference_id` (≤ 40, PLC) becomes the order's `receipt` (≤ 40, ASCII, OC). */
const REFERENCE = /^[\x20-\x7e]{1,40}$/

export interface CurlecConfig {
  /** API Key Id (`rzp_test_…` / `rzp_live_…`). Test-mode keys = the sandbox, on the same host. */
  keyId: string
  /** API Key Secret: Basic auth, and the key for Checkout and Payment Link callback signatures. */
  keySecret: string
  /** The webhook secret set in the Dashboard (not the API key secret). Without it, every webhook is refused. */
  webhookSecret?: string
  /** Override the host (tests point this at the fake from `@bayarkit/testing`). Default `https://api.razorpay.com`. */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** Clock in milliseconds since the epoch (tests). Default `Date.now`. */
  now?: () => number
}

export const info: GatewayInfo = {
  name: NAME,
  // Contradiction 4 in the spec; the API's error text says "at least MYR 1.00".
  minimumAmount: 100,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source: 'curlec.com/docs (.md exports) + razorpay-node/php/python signature utilities',
  },
}

const hmacHex = (secret: string, message: string) =>
  createHmac('sha256', secret).update(message, 'utf8').digest('hex')

/** Constant-time check of a hex HMAC-SHA256 signature; false (never a throw) for anything malformed. */
function checkHex(secret: string | undefined, message: string, signature: unknown): boolean {
  if (!secret || typeof signature !== 'string') return false
  const given = signature.trim().toLowerCase()
  return HEX64.test(given) && timingSafeEqualText(hmacHex(secret, message), given)
}

/** Webhook: hex HMAC-SHA256 of the RAW body with the webhook secret [WV L138-153]. Never pass re-serialised JSON. */
export const verifyWebhookSignature = (rawBody: string, signature: string, webhookSecret: string): boolean =>
  typeof rawBody === 'string' && rawBody.length > 0 && checkHex(webhookSecret, rawBody, signature)

/** Standard Checkout: HMAC-SHA256(key secret, `order_id|razorpay_payment_id`) [CK L624-640]. Pass YOUR stored order id. */
export const verifyCheckoutSignature = (
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): boolean => checkHex(keySecret, `${orderId}|${paymentId}`, signature)

/** Payment Link redirect: HMAC-SHA256(key secret, `link_id|reference_id|status|payment_id`) [PLA]. */
export const verifyPaymentLinkSignature = (
  p: { paymentLinkId: string; referenceId: string; status: string; paymentId: string },
  signature: string,
  keySecret: string,
): boolean => checkHex(keySecret, `${p.paymentLinkId}|${p.referenceId}|${p.status}|${p.paymentId}`, signature)

/** Order status [OC]: only `paid` is paid; `created` and `attempted` are pending. */
export function orderStatus(status: unknown): PaymentStatus {
  if (status === 'paid') return 'paid'
  if (status === 'created' || status === 'attempted') return 'pending'
  return 'unknown'
}

/** Payment Link status without its order [PLE, PLS]. `paid` alone is never trusted as paid (the order decides). */
export function linkStatus(status: unknown): PaymentStatus {
  if (status === 'created' || status === 'issued' || status === 'partially_paid') return 'pending'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'expired') return 'expired'
  return 'unknown'
}

/** What a verified callback CLAIMS (confirmPayment checks the API anyway). */
function claimOf(event: string, payment: Record<string, unknown> | undefined): PaymentStatus | null {
  switch (event) {
    case 'order.paid':
    case 'payment_link.paid':
      return 'paid'
    case 'payment.captured':
      return payment?.status === 'captured' ? 'paid' : 'unknown'
    case 'payment.authorized':
    case 'payment_link.partially_paid':
      return 'pending'
    case 'payment.failed':
      return 'failed'
    case 'payment_link.cancelled':
      return 'cancelled'
    case 'payment_link.expired':
      return 'expired'
    default:
      return null
  }
}

const KEYISH = /\brzp_(test|live)_[A-Za-z0-9]+/g
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const obj = (v: unknown) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const entityOf = (payload: Record<string, unknown> | undefined, name: string) =>
  obj(obj(payload?.[name])?.entity)

export function curlec(config: CurlecConfig): Gateway & {
  /** Create an Order for Standard Checkout (`checkout.js` in your page). `receipt` = your reference. */
  createOrder(input: {
    reference: string
    amount: number
    notes?: Record<string, string>
  }): Promise<{ id: string; raw: unknown }>
} {
  const base = (config.baseUrl ?? API_BASE).replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const now = config.now ?? Date.now
  const authorization = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`

  async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, NAME, 0)
    }
    const json = obj(await res.json().catch(() => null))
    if (!res.ok || !json || json.error) {
      // Quotes Curlec's own `error.description`; anything shaped like a key id is masked.
      const err = obj(json?.error)
      const text = str(err?.description).slice(0, 300) || `HTTP ${res.status}`
      const field = str(err?.field)
      throw new GatewayError(
        `${text.replace(KEYISH, '[redacted]')}${field ? ` (${field})` : ''}`,
        NAME,
        res.status,
        str(err?.code) || undefined,
      )
    }
    return json
  }

  const checkAmount = (amount: number) => {
    if (!Number.isInteger(amount) || amount < info.minimumAmount) {
      throw new GatewayError(
        `amount must be integer sen ≥ ${info.minimumAmount}, got ${amount}`,
        NAME,
        0,
        'INVALID_AMOUNT',
      )
    }
  }
  const checkReference = (reference: string) => {
    // Sent as given: trimming or truncating would make confirmPayment's reference check fail later.
    if (typeof reference !== 'string' || !REFERENCE.test(reference)) {
      throw new GatewayError(
        'reference must be 1–40 printable ASCII characters',
        NAME,
        0,
        'INVALID_REFERENCE',
      )
    }
  }

  const fromOrder = (order: Record<string, unknown>, id: string, reference?: string): PaymentRecord => ({
    id,
    reference: reference ?? str(order.receipt),
    status: orderStatus(order.status),
    amount: Number.isInteger(order.amount) ? (order.amount as number) : Number.NaN,
    currency: str(order.currency).toUpperCase(),
    fee: null,
    raw: order,
  })

  return {
    info,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      checkAmount(input.amount)
      if ((input.currency ?? 'MYR') !== 'MYR')
        throw new GatewayError('only MYR is supported', NAME, 0, 'CURRENCY')
      checkReference(input.reference)
      if (!/^https?:\/\/\S+$/.test(input.returnUrl ?? ''))
        throw new GatewayError('returnUrl must be an http(s) URL', NAME, 0, 'INVALID_URL')
      let expireBy: number | undefined
      if (input.expiresAt) {
        expireBy = Math.floor(input.expiresAt.getTime() / 1000)
        const ahead = expireBy - Math.floor(now() / 1000)
        if (!(ahead >= MIN_EXPIRY_S && ahead <= MAX_EXPIRY_S)) {
          throw new GatewayError(
            'expiresAt must be 15 minutes to 180 days from now',
            NAME,
            0,
            'INVALID_EXPIRY',
          )
        }
      }
      const name = input.customer?.name?.trim()
      const email = input.customer?.email?.trim()
      const phone = (input.customer?.phone ?? '').replace(/[\s()-]/g, '')
      const contact = /^\+?[1-9]\d{6,13}$/.test(phone) && phone.length >= 8 && phone.length <= 14 ? phone : ''
      const customer = {
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
        ...(contact ? { contact } : {}),
      }
      const json = await request('POST', '/v1/payment_links', {
        amount: input.amount,
        currency: 'MYR',
        accept_partial: false,
        reference_id: input.reference,
        description: [...(input.description ?? '').trim()].slice(0, 2048).join('') || input.reference,
        ...(Object.keys(customer).length ? { customer } : {}),
        ...(expireBy !== undefined ? { expire_by: expireBy } : {}),
        notify: { sms: false, email: false },
        reminder_enable: false,
        callback_url: input.returnUrl,
        callback_method: 'get',
      })
      const id = json.id
      const url = json.short_url
      if (
        typeof id !== 'string' ||
        !LINK_ID.test(id) ||
        typeof url !== 'string' ||
        !/^https?:\/\//.test(url)
      ) {
        throw new GatewayError('payment link without id or short_url', NAME, 200)
      }
      return { id, url, raw: json }
    },

    async createOrder(input) {
      checkAmount(input.amount)
      checkReference(input.reference)
      const json = await request('POST', '/v1/orders', {
        amount: input.amount,
        currency: 'MYR',
        receipt: input.reference,
        ...(input.notes ? { notes: input.notes } : {}),
      })
      if (typeof json.id !== 'string' || !ORDER_ID.test(json.id))
        throw new GatewayError('order without id', NAME, 200)
      return { id: json.id, raw: json }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      if (typeof id === 'string' && ORDER_ID.test(id))
        return fromOrder(await request('GET', `/v1/orders/${id}`), id)
      if (typeof id !== 'string' || !LINK_ID.test(id))
        throw new GatewayError('invalid payment link or order id', NAME, 0, 'INVALID_ID')
      const link = await request('GET', `/v1/payment_links/${id}`)
      const reference = str(link.reference_id)
      const orderId = str(link.order_id)
      if (!ORDER_ID.test(orderId)) {
        return {
          id,
          reference,
          status: linkStatus(link.status),
          amount: Number.isInteger(link.amount) ? (link.amount as number) : Number.NaN,
          currency: str(link.currency).toUpperCase(),
          fee: null,
          raw: { payment_link: link },
        }
      }
      const order = await request('GET', `/v1/orders/${orderId}`)
      const record = fromOrder(order, id, reference)
      // An unpaid order behind a link that has ended reports the link's end.
      const ended = linkStatus(link.status)
      if (record.status !== 'paid' && (ended === 'cancelled' || ended === 'expired')) record.status = ended
      return { ...record, raw: { payment_link: link, order } }
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        const headers = cb?.headers ?? {}
        const fields = cb?.fields ?? {}
        const header =
          headers['x-razorpay-signature'] ??
          Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-razorpay-signature')?.[1]

        if (header !== undefined) {
          // Webhook: the RAW body only, keyed with the webhook secret.
          const rawBody = typeof cb.rawBody === 'string' ? cb.rawBody : ''
          if (!verifyWebhookSignature(rawBody, header, config.webhookSecret ?? '')) return null
          const event = obj(JSON.parse(rawBody))
          const name = str(event?.event)
          if (event?.entity !== 'event' || !name) return null
          const payload = obj(event.payload)
          const payment = entityOf(payload, 'payment')
          const order = entityOf(payload, 'order')
          const link = entityOf(payload, 'payment_link')
          const claimedStatus = claimOf(name, payment)
          if (!claimedStatus) return null
          const orderId = str(order?.id) || str(payment?.order_id)
          if (order && payment && str(payment.order_id) && str(payment.order_id) !== str(order.id))
            return null
          const linkId = str(link?.id)
          const id = LINK_ID.test(linkId) ? linkId : orderId
          if (!LINK_ID.test(id) && !ORDER_ID.test(id)) return null
          const reference = LINK_ID.test(id) ? str(link?.reference_id) : str(order?.receipt)
          return {
            id,
            reference,
            claimedStatus,
            raw: {
              event: name,
              event_id: str(headers['x-razorpay-event-id']),
              order_id: orderId,
              payment_id: str(payment?.id),
              payment_link_id: linkId,
            },
          }
        }

        if (fields.razorpay_payment_link_id !== undefined) {
          // Payment Link redirect (GET query), keyed with the API key secret. No reference id → refused (contradiction 6).
          const linkId = fields.razorpay_payment_link_id
          const referenceId = fields.razorpay_payment_link_reference_id
          const status = fields.razorpay_payment_link_status ?? ''
          const paymentId = fields.razorpay_payment_id ?? ''
          if (!LINK_ID.test(linkId) || referenceId === undefined || !PAYMENT_ID.test(paymentId)) return null
          if (
            !verifyPaymentLinkSignature(
              { paymentLinkId: linkId, referenceId, status, paymentId },
              fields.razorpay_signature ?? '',
              config.keySecret,
            )
          )
            return null
          return {
            id: linkId,
            reference: referenceId,
            claimedStatus: status === 'paid' ? 'paid' : linkStatus(status),
            raw: { ...fields },
          }
        }

        if (fields.razorpay_order_id !== undefined) {
          // Standard Checkout callback (POST), keyed with the API key secret. A failure POST has no signature.
          const orderId = fields.razorpay_order_id
          const paymentId = fields.razorpay_payment_id ?? ''
          if (!ORDER_ID.test(orderId) || !PAYMENT_ID.test(paymentId)) return null
          if (!verifyCheckoutSignature(orderId, paymentId, fields.razorpay_signature ?? '', config.keySecret))
            return null
          // The order's receipt is checked by confirmPayment through getPayment.
          return { id: orderId, reference: '', claimedStatus: 'paid', raw: { ...fields } }
        }
        return null
      } catch {
        return null
      }
    },
  }
}
