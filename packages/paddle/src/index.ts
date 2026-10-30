/**
 * Paddle Billing adapter: one-time transactions, webhooks and refunds over raw REST (no Paddle SDK, zero runtime
 * dependencies).
 *
 * Written from the official docs, read 29 October 2026 (`gateways/paddle/spec.md`, a source next to every fact):
 * developer.paddle.com (`.md` renderings) and paddle-node-sdk @ 6a01ef4 for webhook verification. Measured on the
 * sandbox 30 October 2026 (spec "Measured"): card payments, a declined card, real webhooks, refunds. Where the
 * sandbox differed from what the docs led us to expect:
 * - The checkout shows a quantity picker (1 to 100 by default) and the buyer can pay a multiple of the price. The
 *   price is therefore sent with `quantity: { minimum: 1, maximum: 1 }`, which removes the picker.
 * - A retried notification is signed again with a fresh `ts`, so the five-second tolerance holds for retries.
 *
 * - Paddle does not charge Malaysian ringgit. The adapter charges in ONE currency, `currency` in the config (default
 *   USD, any of the 33 Paddle lists), declares it as `info.currency`, and refuses any other before calling Paddle.
 *   `confirmPayment` compares against `info.currency` when the order names none; name it anyway.
 * - Amounts are the currency's minor unit both ways (cents; whole yen for JPY), sent as strings as Paddle asks.
 * - Paddle is the merchant of record and adds tax per buyer country. The price is sent with `tax_mode: "internal"`
 *   (tax included), so what the app asked for is what the buyer pays, and `getPayment` reads the amount from
 *   `details.totals.grand_total` ("total due after credits but before any payments"). Measured: `grand_total` stays
 *   the price whatever the buyer's country; Paddle carves the tax out of it once the address is known (USD 10.50 to
 *   New York = 964 subtotal + 86 tax). Only `grand_total` is relied on.
 * - Every request pins `Paddle-Version: 1`. The key decides the host: `pdl_sdbx_` = sandbox, `pdl_live_` = live.
 * - One non-catalog price on a non-catalog product (`taxCategory`, default `standard`, must be enabled on the account),
 *   your reference in `custom_data.reference`. No customer is sent: the checkout collects it, so a new transaction is
 *   `draft`.
 * - The payment link is `data.checkout.url`: your **default payment link** (set it in Paddle > Checkout first, or every
 *   create fails with `transaction_default_checkout_url_not_set`) plus `?_ptxn=<id>`; that page must load Paddle.js.
 *   `checkoutUrl` in the config picks another approved domain. For an overlay, `Paddle.Checkout.open({ transactionId })`
 *   takes the payment `id`.
 * - Not sent, because Paddle has no field for them on a transaction: `returnUrl` (set the success URL in Paddle.js),
 *   `callbackUrl` (add a notification destination for `transaction.*` events), `expiresAt`, and `idempotencyKey`
 *   (Paddle has no idempotency key: a retried create makes a second transaction).
 * - Status: `paid` and `completed` = paid; `draft`, `ready`, `billed` = pending; `canceled`, `past_due` = failed. A
 *   declined card does not change a one-time transaction's status (measured: it stays `ready`, with an `error`
 *   payment, and `transaction.payment_failed` is sent). A refund does not change it
 *   either: a refunded transaction stays `completed` and reads as paid, as Stripe's does; the refund is the
 *   `RefundRecord` (and `details.adjusted_totals` in `raw`).
 * - Refunds are `POST /adjustments` with `action: refund`: `type: full` when the whole amount is still refundable,
 *   otherwise `partial` on the one line item. Only `completed` transactions can be refunded, and no new refund is
 *   accepted while one awaits approval (`adjustment_pending_refund_request`, Paddle's only guard against a double
 *   refund). A refund starts `pending_approval` (= `pending`, measured); `approved` = `succeeded`, `rejected` = `failed`.
 *   The amount checked before asking is `details.adjusted_totals.grand_total` (what approved refunds left; measured:
 *   it does not drop while a refund is pending).
 *
 * Webhook verification follows the docs and paddle-node-sdk: split `Paddle-Signature` on `;` then `=`, HMAC-SHA256
 * over `${ts}:${rawBody}` keyed with the destination's secret (`pdl_ntfset_…`), hex, constant-time compare against
 * every `h1` (several appear while a secret is rotated), then the age check: older than `toleranceSeconds` (default
 * 5, the SDK's value) is refused. Measured: notifications arrived 0.2 to 2.2 s after their `ts`, and each retry is
 * signed again with a fresh `ts`. Like the Stripe adapter, a future `ts` passes (only the secret can sign one).
 */
import { createHmac } from 'node:crypto'
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
  timingSafeEqualText,
  type VerifiedCallback,
} from '@bayarkit/core'

export const PADDLE_VERSION = '1'
const SANDBOX_HOST = 'sandbox-api.paddle.com'
const LIVE_HOST = 'api.paddle.com'

/** The 33 payment currencies Paddle lists (spec §6). MYR is not one. */
export const CURRENCIES: readonly string[] =
  'USD GBP EUR ARS AUD BRL CAD CHF CLP CNY COP CZK DKK HKD HUF ILS INR JPY KRW MXN NOK NZD PEN PLN RUB SEK SGD THB TRY TWD UAH VND ZAR'.split(
    ' ',
  )
/** Minimum charges the docs state, minor units (spec §6). Other currencies: Paddle has the final word. */
const MINIMUMS: Record<string, number> = { USD: 70, EUR: 65, GBP: 55, SGD: 90, JPY: 100 }
const REFERENCE_MAX = 200

export interface PaddleConfig {
  /** Server API key, `pdl_sdbx_apikey_…` (sandbox) or `pdl_live_apikey_…` (live). The key decides the host. */
  apiKey: string
  /** The notification destination's secret key, `pdl_ntfset_…`. */
  webhookSecret: string
  /** The currency every payment is charged in. Default `USD`; must be one Paddle takes (not MYR). */
  currency?: string
  /** `product.tax_category` of the non-catalog product. Default `standard`; must be enabled on your account. */
  taxCategory?: string
  /** A checkout page on an approved domain. Default: your default payment link. */
  checkoutUrl?: string
  /** Maximum webhook age in seconds. Default 5 (paddle-node-sdk). Must be greater than 0. */
  toleranceSeconds?: number
  /** Clock in milliseconds since the epoch (tests). Default `Date.now`. */
  now?: () => number
  /** Override the host (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export const info: GatewayInfo = {
  name: 'paddle',
  minimumAmount: MINIMUMS.USD as number,
  currency: 'USD',
  evidence: {
    kind: 'measured',
    date: '2026-10-30',
    source:
      'Paddle sandbox: card paid + declined, real webhooks, refunds; developer.paddle.com + paddle-node-sdk',
  },
}

/** `ts` and every `h1` from a `Paddle-Signature` header; other keys are dropped. */
export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = -1
  const signatures: string[] = []
  for (const item of header.split(';')) {
    const [k, v] = item.trim().split('=')
    if (k === 'ts' && v && /^\d+$/.test(v)) timestamp = Number.parseInt(v, 10)
    if (k === 'h1' && v) signatures.push(v)
  }
  return { timestamp, signatures }
}

/** Verify a notification as the docs describe (see the header comment). Returns false instead of throwing. */
export function verifyPaddleSignature(
  rawBody: string,
  header: string,
  secret: string,
  toleranceSeconds: number,
  nowMs: number,
): boolean {
  if (!secret || !header || !(toleranceSeconds > 0)) return false
  const { timestamp, signatures } = parseSignatureHeader(header)
  if (timestamp < 0 || !signatures.length) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}:${rawBody}`, 'utf8').digest('hex')
  if (!signatures.some((s) => timingSafeEqualText(expected, s))) return false
  return Math.floor(nowMs / 1000) - timestamp <= toleranceSeconds
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const text = (v: unknown) => (typeof v === 'string' ? v : '')
/** A minor-unit string ("1050") as a number; NaN for anything else, so it never matches. */
const units = (v: unknown) => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : Number.NaN)

const transactionStatus = (s: unknown): PaymentStatus => {
  switch (s) {
    case 'paid':
    case 'completed':
      return 'paid'
    case 'draft':
    case 'ready':
    case 'billed':
      return 'pending'
    case 'canceled':
    case 'past_due':
      return 'failed'
    default:
      return 'unknown'
  }
}

const refundStatus = (s: unknown): RefundStatus =>
  s === 'pending_approval'
    ? 'pending'
    : s === 'approved'
      ? 'succeeded'
      : s === 'rejected'
        ? 'failed'
        : 'unknown'

const TXN_ID = /^txn_[a-z\d]{26}$/
const SECRETISH = /\b(pdl_[A-Za-z0-9_]+|test_[A-Za-z0-9]{8,})/g

export function paddle(config: PaddleConfig): Gateway & {
  readonly info: GatewayInfo & { currency: string }
  refundPayment(input: RefundInput): Promise<RefundRecord>
} {
  const fail = (message: string, code: string) => new GatewayError(message, 'paddle', 0, code)
  const host = config.apiKey?.startsWith('pdl_sdbx_')
    ? SANDBOX_HOST
    : config.apiKey?.startsWith('pdl_live_')
      ? LIVE_HOST
      : ''
  if (!config.baseUrl && !host) {
    throw fail('apiKey must be a Paddle key (pdl_sdbx_… or pdl_live_…)', 'CONFIG')
  }
  const base = (config.baseUrl ?? `https://${host}`).replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const tolerance = config.toleranceSeconds ?? 5
  const now = config.now ?? Date.now
  const currency = config.currency ?? 'USD'
  const taxCategory = config.taxCategory ?? 'standard'
  if (!(Number.isFinite(tolerance) && tolerance > 0)) {
    // 0 would accept a captured notification forever.
    throw fail('toleranceSeconds must be a number greater than 0', 'CONFIG')
  }
  if (!CURRENCIES.includes(currency)) {
    throw fail(`Paddle does not charge in ${currency}; pick one of ${CURRENCIES.join(', ')}`, 'CURRENCY')
  }
  const gatewayInfo = { ...info, currency, minimumAmount: MINIMUMS[currency] ?? 1 }

  async function request(method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.apiKey}`,
      'paddle-version': PADDLE_VERSION,
      accept: 'application/json',
    }
    if (body) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, 'paddle', 0)
    }
    const json = (await res.json().catch(() => null)) as Json | null
    const data = obj(json?.data)
    if (!res.ok || !Object.keys(data).length) {
      // Paddle's own words only: `{ error: { type, code, detail } }`, with anything key-shaped masked.
      const err = obj(json?.error)
      const detail = text(err.detail) || `HTTP ${res.status}`
      throw new GatewayError(
        detail.replace(SECRETISH, '[redacted]'),
        'paddle',
        res.status,
        text(err.code) || undefined,
      )
    }
    return data
  }

  const toRecord = (t: Json, id: string): PaymentRecord => {
    const totals = obj(obj(t.details).totals)
    const fee = totals.fee === null || totals.fee === undefined ? null : units(totals.fee)
    const captured = (Array.isArray(t.payments) ? t.payments : [])
      .map(obj)
      .find((p) => p.status === 'captured' && typeof p.captured_at === 'string')
    const status = transactionStatus(t.status)
    return {
      id: text(t.id) || id,
      reference: text(obj(t.custom_data).reference),
      status,
      amount: units(totals.grand_total),
      currency: text(t.currency_code),
      ...(status === 'paid' && captured ? { paidAt: new Date(text(captured.captured_at)) } : {}),
      fee: Number.isNaN(fee) ? null : fee,
      raw: t,
    }
  }

  const checkId = (id: string) => {
    if (typeof id !== 'string' || !TXN_ID.test(id)) throw fail('invalid transaction id', 'INVALID_ID')
  }
  async function getPayment(id: string): Promise<PaymentRecord> {
    checkId(id)
    return toRecord(await request('GET', `/transactions/${id}`), id)
  }

  return {
    info: gatewayInfo,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (!Number.isSafeInteger(input.amount) || input.amount < gatewayInfo.minimumAmount) {
        throw fail(
          `amount must be a whole number of minor units, at least ${gatewayInfo.minimumAmount} ${currency}`,
          'INVALID_AMOUNT',
        )
      }
      if ((input.currency ?? currency) !== currency) {
        throw fail(`this adapter charges in ${currency}, not ${input.currency}`, 'CURRENCY')
      }
      if (!input.reference || input.reference.length > REFERENCE_MAX) {
        throw fail(`reference must be 1 to ${REFERENCE_MAX} characters`, 'INVALID_REFERENCE')
      }
      const words = input.description?.trim() || `Order ${input.reference}`
      const name = words.slice(0, 150)
      const data = await request('POST', '/transactions', {
        items: [
          {
            quantity: 1,
            price: {
              // `description` is internal (2–500), `name` is shown at checkout (1–150).
              description: (words.length >= 2 ? words : `Order ${input.reference}`).slice(0, 500),
              name,
              unit_price: { amount: String(input.amount), currency_code: currency },
              tax_mode: 'internal',
              // Without it the checkout shows a 1-100 quantity picker and the buyer can pay a multiple (measured).
              quantity: { minimum: 1, maximum: 1 },
              product: { name: words.slice(0, 200), tax_category: taxCategory },
            },
          },
        ],
        custom_data: { reference: input.reference },
        collection_mode: 'automatic',
        ...(config.checkoutUrl ? { checkout: { url: config.checkoutUrl } } : {}),
      })
      const id = data.id
      const url = obj(data.checkout).url
      if (typeof id !== 'string' || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        throw new GatewayError('transaction without id or checkout url', 'paddle', 201)
      }
      return { id, url, raw: data }
    },

    getPayment,

    async refundPayment(input: RefundInput): Promise<RefundRecord> {
      const record = await getPayment(input.paymentId)
      if (record.status !== 'paid') throw fail(`payment is ${record.status}, not paid`, 'NOT_PAID')
      const details = obj(obj(record.raw).details)
      const left = units(obj(details.adjusted_totals).grand_total)
      checkRefundAmount('paddle', input, Number.isNaN(left) ? record.amount : left)
      const items = (Array.isArray(details.line_items) ? details.line_items : []).map(obj)
      const whole = input.amount === record.amount && left === record.amount
      let body: Json
      if (whole) body = { type: 'full' }
      else {
        const itemId = text(items[0]?.id)
        if (items.length !== 1 || !itemId) {
          throw fail('a partial refund needs a transaction with exactly one line item', 'REFUND_ITEMS')
        }
        body = {
          type: 'partial',
          items: [{ item_id: itemId, type: 'partial', amount: String(input.amount) }],
        }
      }
      const adj = await request('POST', '/adjustments', {
        action: 'refund',
        transaction_id: input.paymentId,
        reason: input.reason?.trim() || 'refund',
        ...body,
      })
      return {
        id: text(adj.id),
        paymentId: text(adj.transaction_id) || input.paymentId,
        status: refundStatus(adj.status),
        amount: units(obj(adj.totals).total),
        currency: text(adj.currency_code) || record.currency,
        raw: adj,
      }
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        const headers = cb?.headers ?? {}
        const header =
          headers['paddle-signature'] ??
          Object.entries(headers).find(([k]) => k.toLowerCase() === 'paddle-signature')?.[1] ??
          ''
        const rawBody = typeof cb?.rawBody === 'string' ? cb.rawBody : ''
        if (
          !rawBody ||
          typeof header !== 'string' ||
          !verifyPaddleSignature(rawBody, header, config.webhookSecret, tolerance, now())
        ) {
          return null
        }
        // JSON is parsed only after the signature checks out.
        const event = obj(JSON.parse(rawBody))
        const type = text(event.event_type)
        const t = obj(event.data)
        if (!type.startsWith('transaction.') || !TXN_ID.test(text(t.id))) return null
        let claimedStatus = transactionStatus(t.status)
        if (type === 'transaction.payment_failed' && claimedStatus !== 'paid') claimedStatus = 'failed'
        const reference = text(obj(t.custom_data).reference)
        return {
          id: text(t.id),
          reference,
          claimedStatus,
          raw: {
            event_id: text(event.event_id),
            event_type: type,
            transaction_id: text(t.id),
            reference,
            status: text(t.status),
          },
        }
      } catch {
        return null
      }
    },
  }
}
