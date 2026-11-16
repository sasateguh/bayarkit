/**
 * Sampan Pay adapter: USD invoices the buyer pays in Bitcoin Cash from any wallet; Sampan converts each payment to PUSD
 * and sends it to the merchant's own address. Raw REST (no Sampan or BCH library, zero runtime dependencies).
 *
 * Matched against the live API on 16 November 2026 through this adapter: one unpaid USD 0.20 invoice (create answers
 * 200, `getPayment` = pending with Sampan's `open`), its GET answer and the error answers. No payment and no webhook
 * were measured, so `evidence.kind` stays `docs`. Found live, unlike the first plan: `usd` is a JSON number in the
 * request (a string only passes by coercion), `requiredSats`/`paidSats`/payment sats are decimal strings, `orderId`
 * and `returnUrl` are null when not sent, the limits are USD 0.20 to 250, a key under 24 bytes is refused, ids are 32
 * hex digits, and Sampan's own errors are `{ error, message }` with `below_min`, `above_max`, `bad_request`,
 * `not_found` (also while pay is off), while a body the schema refuses gets the framework's `error: 'Bad Request'`.
 * From Sampan's code, not measured: the webhook body is `{ type, timestamp, data }` with `data` = the GET answer
 * without `webhook`.
 *
 * - There are no accounts and no API key: an invoice names the merchant by `merchantAddress` (a token-aware Bitcoin
 *   Cash address, where the PUSD goes). Every invoice carries `webhookSecret` from the config, so one secret signs
 *   every webhook for this shop (otherwise Sampan generates one per invoice and answers it once).
 * - Amounts are US cents both ways; the adapter sends `usd` as dollars (20 cents → 0.2) and refuses any currency
 *   other than USD before calling Sampan. `reference` is sent as `orderId`, `callbackUrl` as `webhookUrl` (HTTPS,
 *   not a private address), `returnUrl` as is. Not sent, because the invoice has no field for them: `description`,
 *   `customer`, `expiresAt` (Sampan's own validity applies) and `idempotencyKey` (a retried create makes a second
 *   invoice).
 * - The payment link is `statusUrl`: Sampan's page with the address, the QR code and the BCH amount. The address and
 *   the BIP21 URI are in `raw` for a page of your own.
 * - Status, from Sampan's own words: `paid`, `overpaid` and `paid_late` = paid, but only once every payment has a PUSD
 *   conversion on record (Sampan counts a payment as soon as it sees it, before converting it; one entry in `convert`
 *   per converted payment); `open` and `underpaid` = pending (never paid, so
 *   `confirmPayment` refuses them; Sampan's `underToleranceBps` decides what counts as enough); `expired` = expired;
 *   anything else = unknown. `paid_late` (first payment seen after `expiresAt`) is paid because the PUSD arrived anyway,
 *   but only when `paidSats` reaches `requiredSats`: Sampan reports paid_late whatever the size, and converts only what
 *   a short payment covers. A late payment inside the tolerance stays pending; check `raw.status` for a human. `amount` is the INVOICE amount: what reached the merchant in PUSD
 *   rarely matches to the cent (it is in `raw.convert`), and an overpayment stays the buyer's and merchant's matter.
 * - No refunds: Sampan holds no funds, so a payment can only be returned by the merchant, outside the API.
 *
 * Webhooks follow Standard Webhooks: `webhook-id`, `webhook-timestamp` (unix seconds) and `webhook-signature`
 * (space-separated `v1,<base64>`), HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` keyed with the base64 after
 * `whsec_`, constant-time compare against every `v1` signature, then the time check in both directions
 * (`toleranceSeconds`, default 300 as in the specification). Retries keep the same `webhook-id`: deduplicate on it.
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
  withoutTrailingSlashes,
} from '@bayarkit/core'

export const DEFAULT_BASE_URL = 'https://sampan.sasateguh.com'
const REFERENCE_MAX = 200

export interface SampanConfig {
  /** Your token-aware Bitcoin Cash address (`bitcoincash:z…`/`r…`): Sampan sends the PUSD here. */
  merchantAddress: string
  /** Standard Webhooks secret, `whsec_<base64 of at least 24 bytes>`, sent with every invoice and used to verify every webhook. */
  webhookSecret: string
  /** Smallest invoice in US cents. Default 20 (USD 0.20, the live minimum); Sampan has the final word (`below_min`). */
  minimumAmount?: number
  /** Maximum webhook age in seconds, both directions. Default 300 (Standard Webhooks). Must be greater than 0. */
  toleranceSeconds?: number
  /** Clock in milliseconds since the epoch (tests). Default `Date.now`. */
  now?: () => number
  /** Default `https://sampan.sasateguh.com`; tests point this at the fake from `@bayarkit/testing`. */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export const info: GatewayInfo = {
  name: 'sampan',
  minimumAmount: 20,
  currency: 'USD',
  evidence: {
    kind: 'docs',
    date: '2026-11-16',
    source:
      'Sampan Pay invoice API, request and answer shapes matched against the live API (one unpaid invoice); no payment or webhook measured',
  },
}

/** US cents as a dollar string: 20 → "0.20" (sent as the JSON number `Number(dollars(c))`). */
export const dollars = (cents: number): string =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

/** Sampan's dollar string as cents: "10.5" → 1050; NaN for anything else, so it never matches. */
const cents = (v: unknown): number => {
  const m = typeof v === 'string' ? /^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.exec(v) : null
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : Number.NaN
}

// At least 24 bytes of key (32 base64 characters), as Sampan requires.
const SECRET = /^whsec_([A-Za-z0-9+/]{32,}={0,2})$/

/** Verify a Standard Webhooks signature (see the header comment). Returns false instead of throwing. */
export function verifySampanSignature(
  rawBody: string,
  headers: { id: string; timestamp: string; signature: string },
  secret: string,
  toleranceSeconds: number,
  nowMs: number,
): boolean {
  const key = SECRET.exec(secret)?.[1]
  const { id, timestamp, signature } = headers
  if (!key || !id || !signature || !/^\d{1,12}$/.test(timestamp) || !(toleranceSeconds > 0)) return false
  const expected = createHmac('sha256', Buffer.from(key, 'base64'))
    .update(`${id}.${timestamp}.${rawBody}`, 'utf8')
    .digest('base64')
  const ok = signature
    .split(' ')
    .some((s) => s.startsWith('v1,') && timingSafeEqualText(expected, s.slice(3)))
  return ok && Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) <= toleranceSeconds
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const text = (v: unknown) => (typeof v === 'string' ? v : '')
const list = (v: unknown) => (Array.isArray(v) ? v : [])

/** A whole number of satoshis from Sampan's decimal string; -1 for anything else. */
const sats = (v: unknown): bigint => (typeof v === 'string' && /^\d{1,20}$/.test(v) ? BigInt(v) : -1n)

/** Sampan's status, with the PUSD conversion as the evidence a paid status needs. */
const invoiceStatus = (inv: Json): PaymentStatus => {
  const converted = list(inv.payments).length > 0 && list(inv.convert).length >= list(inv.payments).length
  switch (inv.status) {
    case 'paid':
    case 'overpaid':
      return converted ? 'paid' : 'pending'
    case 'paid_late':
      // Sampan says paid_late for any payment first seen after expiry, whatever its size: ask for the full amount.
      return converted && sats(inv.requiredSats) >= 0n && sats(inv.paidSats) >= sats(inv.requiredSats)
        ? 'paid'
        : 'pending'
    case 'open':
    case 'underpaid':
      return 'pending'
    case 'expired':
      return 'expired'
    default:
      return 'unknown'
  }
}

const INVOICE_ID = /^[0-9a-f]{32}$/
const SECRETISH = /whsec_[A-Za-z0-9+/=]*/g

export function sampan(config: SampanConfig): Gateway & { readonly info: GatewayInfo & { currency: 'USD' } } {
  const fail = (message: string, code: string) => new GatewayError(message, 'sampan', 0, code)
  if (typeof config?.webhookSecret !== 'string' || !SECRET.test(config.webhookSecret)) {
    throw fail(
      'webhookSecret must be a Standard Webhooks secret: whsec_ followed by base64 of at least 24 bytes',
      'CONFIG',
    )
  }
  if (typeof config.merchantAddress !== 'string' || !config.merchantAddress.trim()) {
    throw fail('merchantAddress must be your token-aware Bitcoin Cash address', 'CONFIG')
  }
  const tolerance = config.toleranceSeconds ?? 300
  if (!(Number.isFinite(tolerance) && tolerance > 0)) {
    throw fail('toleranceSeconds must be a number greater than 0', 'CONFIG')
  }
  const minimumAmount = config.minimumAmount ?? info.minimumAmount
  if (!(Number.isSafeInteger(minimumAmount) && minimumAmount > 0)) {
    throw fail('minimumAmount must be a whole number of cents greater than 0', 'CONFIG')
  }
  const base = withoutTrailingSlashes(config.baseUrl ?? DEFAULT_BASE_URL)
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const now = config.now ?? Date.now
  const gatewayInfo = { ...info, currency: 'USD' as const, minimumAmount }

  async function request(method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, 'sampan', 0)
    }
    const json = obj(await res.json().catch(() => null))
    if (!res.ok || !text(json.id)) {
      // Sampan's own words only (`{ error, message }`), with anything secret-shaped masked.
      const message = text(json.message) || `HTTP ${res.status}`
      throw new GatewayError(
        message.replace(SECRETISH, '[redacted]'),
        'sampan',
        res.status,
        text(json.error) || undefined,
      )
    }
    return json
  }

  const toRecord = (inv: Json, id: string): PaymentRecord => ({
    id: text(inv.id) || id,
    reference: text(inv.orderId),
    status: invoiceStatus(inv),
    amount: cents(inv.usd),
    currency: 'USD',
    fee: null,
    raw: inv,
  })

  return {
    info: gatewayInfo,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (!Number.isSafeInteger(input.amount) || input.amount < minimumAmount) {
        throw fail(`amount must be a whole number of US cents, at least ${minimumAmount}`, 'INVALID_AMOUNT')
      }
      if ((input.currency ?? 'USD') !== 'USD') {
        throw fail(`Sampan Pay invoices are in USD, not ${input.currency}`, 'CURRENCY')
      }
      if (!input.reference || input.reference.length > REFERENCE_MAX) {
        throw fail(`reference must be 1 to ${REFERENCE_MAX} characters`, 'INVALID_REFERENCE')
      }
      const data = await request('POST', '/api/pay/invoice', {
        usd: Number(dollars(input.amount)),
        merchantAddress: config.merchantAddress,
        orderId: input.reference,
        webhookUrl: input.callbackUrl,
        webhookSecret: config.webhookSecret,
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      })
      const id = text(data.id)
      let url = ''
      try {
        url = new URL(text(data.statusUrl), `${base}/`).href
      } catch {}
      if (!INVOICE_ID.test(id) || !/^https?:\/\//.test(url)) {
        throw new GatewayError('invoice without id or status url', 'sampan', 200)
      }
      // Sampan answers a secret only when it generated one; this adapter always sends its own, but never keep one.
      const { webhookSecret: _never, ...raw } = data
      return { id, url, raw }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      if (typeof id !== 'string' || !INVOICE_ID.test(id)) throw fail('invalid invoice id', 'INVALID_ID')
      return toRecord(await request('GET', `/api/pay/invoice/${id}`), id)
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        const headers = cb?.headers ?? {}
        const header = (name: string) => {
          const v = headers[name] ?? Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]
          return typeof v === 'string' ? v : ''
        }
        const rawBody = typeof cb?.rawBody === 'string' ? cb.rawBody : ''
        const signed = {
          id: header('webhook-id'),
          timestamp: header('webhook-timestamp'),
          signature: header('webhook-signature'),
        }
        if (!rawBody || !verifySampanSignature(rawBody, signed, config.webhookSecret, tolerance, now())) {
          return null
        }
        // JSON is parsed only after the signature checks out.
        const event = obj(JSON.parse(rawBody))
        const type = text(event.type)
        const inv = obj(event.data)
        const id = text(inv.id)
        if (!type.startsWith('invoice.') || !INVOICE_ID.test(id)) return null
        const reference = text(inv.orderId)
        return {
          id,
          reference,
          claimedStatus: invoiceStatus(inv),
          raw: { webhook_id: signed.id, type, invoice_id: id, reference, status: text(inv.status) },
        }
      } catch {
        return null
      }
    },
  }
}
