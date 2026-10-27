/**
 * Stripe (Malaysia) adapter: Checkout Sessions over raw REST (no Stripe SDK, zero runtime dependencies).
 *
 * Written from the official docs only, read 23 October 2026 (`gateways/stripe/spec.md`, a source next to every fact):
 * docs.stripe.com (`.md` renderings), github.com/stripe/openapi (`2026-09-30.endive`), and stripe-node
 * `src/Webhooks.ts` @ 3af59f7c for webhook verification. MEASURED in test mode 27 Oct 2026 (Malaysian sandbox account,
 * through this adapter): a card and an FPX payment each arrived as one `checkout.session.completed` with
 * `payment_status: paid` (FPX in test mode has no pending phase), the webhook signature and `confirmPayment` held, a
 * failed FPX payment sent no Checkout event and left the session `open`/`unpaid` (read as `pending`); endive's 400 on
 * `payment_method_types` and the 200-sen MYR minimum are real (below it Stripe's error blames the payment method types).
 *
 * - Every request pins `Stripe-Version` (default `2026-09-30.endive`): without it Stripe uses the account default,
 *   which can change under you.
 * - endive REJECTS `payment_method_types` on Checkout Sessions with HTTP 400. This adapter sends
 *   `allowed_payment_method_types[]` (default card + fpx) instead; it sends the old `payment_method_types[]` only when
 *   you pin a version older than endive, where `allowed_…` did not exist yet. An empty `paymentMethods` sends neither
 *   (Dashboard-managed payment methods).
 * - Bodies are form-encoded with bracket keys (`line_items[0][price_data][currency]=myr`); responses are JSON.
 * - Amounts are sen both ways. MYR minimum charge 200 sen; non-card maximum 8 digits (99 999 999 sen).
 * - Stripe returns `currency` in lower case (`myr`); `getPayment` upper-cases it to bayarkit's `MYR`.
 * - FPX needs a Malaysian Stripe account with a Business Registration Number, MYR, one-time payments only, and FPX
 *   switched on in Dashboard → Settings → Payment methods.
 * - There is no per-session callback URL (`input.callbackUrl` is not sent): add a webhook endpoint in the Dashboard
 *   for `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
 *   `checkout.session.async_payment_failed` and `checkout.session.expired`, and read it with `readCallback` (the
 *   signature covers the RAW body).
 *
 * Webhook verification follows stripe-node: parse `t` and every `v1` (other schemes such as the test-only `v0` are
 * ignored, which prevents a downgrade), HMAC-SHA256 over `${t}.${rawBody}` keyed with the full `whsec_…` string, hex,
 * constant-time compare against each `v1` (several appear while an endpoint secret is being rolled), then the age
 * check. Like stripe-node, the age check is ONE-SIDED (`now - t > tolerance` fails; a future `t` passes): a valid
 * future-dated signature can only come from someone holding the secret. A tolerance of 0 would switch the check off in
 * stripe-node; here it is refused when the gateway is created.
 *
 * Where the docs are silent (UNCONFIRMED in the spec) this adapter picks the safe side:
 * - a delayed method's pending state (`status: complete` + `payment_status: unpaid`) and its later failure both read as
 *   `pending` from `getPayment`: only `payment_status: paid` is ever `paid`;
 * - `payment_status: no_payment_required` reads as `unknown` (never paid);
 * - FPX limits beyond the MYR minimum and the 8-digit maximum are not checked here: Stripe has the final word.
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

export const API_VERSION = '2026-09-30.endive'
/** The first version without `payment_method_types` on Checkout Sessions. */
const ENDIVE_DATE = '2026-09-30'
const MAXIMUM_SEN = 99_999_999
const EXPIRY_MIN_S = 30 * 60
const EXPIRY_MAX_S = 24 * 60 * 60

export interface StripeConfig {
  /** Secret (`sk_test_…` / `sk_live_…`) or restricted (`rk_…`) key. The key decides test vs live mode. */
  secretKey: string
  /** The webhook endpoint's signing secret, `whsec_…`, used as given. */
  webhookSecret: string
  /** Sent as `Stripe-Version` on every request. Default `2026-09-30.endive`. */
  apiVersion?: string
  /** Payment method types to allow. Default `['card', 'fpx']`; `[]` = whatever the Dashboard enables. */
  paymentMethods?: string[]
  /** Maximum webhook age in seconds. Default 300 (stripe-node's default). Must be greater than 0. */
  toleranceSeconds?: number
  /** Clock in milliseconds since the epoch (tests). Default `Date.now`. */
  now?: () => number
  /** Override the host (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export const info: GatewayInfo = {
  name: 'stripe',
  minimumAmount: 200,
  evidence: {
    kind: 'measured',
    date: '2026-10-27',
    source:
      'Stripe test mode (MY account): card + FPX + failed FPX; docs.stripe.com + stripe/openapi + stripe-node',
  },
}

type FormValue = string | number | boolean | undefined | null | FormValue[] | { [key: string]: FormValue }

/**
 * Stripe's form encoding: nested objects as `a[b][c]=v`, arrays of objects as `a[0][b]=v`, arrays of plain values as
 * `a[]=v` (repeated). `undefined` and `null` are left out. Brackets stay literal; names and values are percent-encoded.
 */
export function encodeForm(data: Record<string, FormValue>): string {
  const out: string[] = []
  const walk = (key: string, value: FormValue) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v !== null && typeof v === 'object' ? `${key}[${i}]` : `${key}[]`, v)
      })
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(`${key}[${encodeURIComponent(k)}]`, v)
    } else {
      out.push(`${key}=${encodeURIComponent(String(value))}`)
    }
  }
  for (const [k, v] of Object.entries(data)) walk(encodeURIComponent(k), v)
  return out.join('&')
}

/** `t` and every `v1` from a `Stripe-Signature` header (stripe-node `parseHeader`); other schemes are dropped. */
export function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = -1
  const signatures: string[] = []
  for (const item of header.split(',')) {
    const [k, v] = item.trim().split('=')
    if (k === 't' && v && /^\d+$/.test(v)) timestamp = Number.parseInt(v, 10)
    if (k === 'v1' && v) signatures.push(v)
  }
  return { timestamp, signatures }
}

/**
 * Verify a webhook exactly as stripe-node does (see the header comment). Returns false instead of throwing.
 * `nowMs` is the receiving time in milliseconds.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string,
  webhookSecret: string,
  toleranceSeconds: number,
  nowMs: number,
): boolean {
  if (!webhookSecret || !header || !(toleranceSeconds > 0)) return false
  const { timestamp, signatures } = parseSignatureHeader(header)
  if (timestamp < 0 || !signatures.length) return false
  const expected = createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')
  if (!signatures.some((s) => timingSafeEqualText(expected, s))) return false
  return Math.floor(nowMs / 1000) - timestamp <= toleranceSeconds
}

const sessionStatus = (s: Record<string, unknown>): PaymentStatus => {
  if (s.payment_status === 'paid') return 'paid'
  if (s.status === 'expired') return 'expired'
  if (s.payment_status === 'no_payment_required') return 'unknown'
  if (s.status === 'open' || s.status === 'complete') return 'pending'
  return 'unknown'
}

const SECRETISH = /\b(sk|rk|pk|whsec)_[A-Za-z0-9_*]+/g
/** Stripe's own error text, with anything shaped like a key masked (an "Invalid API Key" message can echo one). */
const quote = (json: Record<string, unknown> | null, fallback: string) => {
  const err = json?.error as Record<string, unknown> | undefined
  const message = typeof err?.message === 'string' && err.message ? err.message : fallback
  return { message: message.replace(SECRETISH, '[redacted]'), code: String(err?.code ?? err?.type ?? '') }
}

export function stripe(config: StripeConfig): Gateway & {
  /** Expire an open Checkout Session (the documented way to cancel; its PaymentIntent cannot be cancelled). */
  expirePayment(id: string): Promise<PaymentRecord>
} {
  const base = (config.baseUrl ?? 'https://api.stripe.com').replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const apiVersion = config.apiVersion ?? API_VERSION
  const methods = config.paymentMethods ?? ['card', 'fpx']
  const tolerance = config.toleranceSeconds ?? 300
  const now = config.now ?? Date.now
  if (!(Number.isFinite(tolerance) && tolerance > 0)) {
    // 0 disables stripe-node's recency check, so a captured webhook could be replayed forever.
    throw new GatewayError('toleranceSeconds must be a number greater than 0', 'stripe', 0, 'CONFIG')
  }

  async function request(method: 'GET' | 'POST', path: string, form?: string, idempotencyKey?: string) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.secretKey}`,
      'stripe-version': apiVersion,
      accept: 'application/json',
    }
    if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded'
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(form !== undefined ? { body: form } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, 'stripe', 0)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok || !json) {
      const q = quote(json, `HTTP ${res.status}`)
      throw new GatewayError(q.message, 'stripe', res.status, q.code || undefined)
    }
    return json
  }

  const toRecord = (s: Record<string, unknown>, id: string): PaymentRecord => ({
    id: String(s.id ?? id),
    reference: typeof s.client_reference_id === 'string' ? s.client_reference_id : '',
    status: sessionStatus(s),
    amount: Number.isInteger(s.amount_total) ? (s.amount_total as number) : Number.NaN,
    // Stripe answers lower case ("myr"); bayarkit compares against "MYR".
    currency: typeof s.currency === 'string' ? s.currency.toUpperCase() : '',
    raw: s,
  })

  const checkId = (id: string) => {
    if (!/^cs_[A-Za-z0-9_]{1,250}$/.test(id))
      throw new GatewayError('invalid checkout session id', 'stripe', 0, 'INVALID_ID')
  }

  return {
    info,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (
        !Number.isInteger(input.amount) ||
        input.amount < info.minimumAmount ||
        input.amount > MAXIMUM_SEN
      ) {
        throw new GatewayError(
          `amount must be integer sen from ${info.minimumAmount} to ${MAXIMUM_SEN}`,
          'stripe',
          0,
          'INVALID_AMOUNT',
        )
      }
      if ((input.currency ?? 'MYR') !== 'MYR')
        throw new GatewayError('only MYR is supported', 'stripe', 0, 'CURRENCY')
      if (!input.reference || input.reference.length > 200) {
        throw new GatewayError('reference must be 1 to 200 characters', 'stripe', 0, 'INVALID_REFERENCE')
      }
      const idempotencyKey = input.idempotencyKey ?? input.reference
      if (idempotencyKey.length > 255)
        throw new GatewayError('idempotencyKey must be at most 255 characters', 'stripe', 0, 'INVALID_KEY')
      const email = input.customer?.email?.trim()
      if (email && email.length > 800)
        throw new GatewayError('customer email too long', 'stripe', 0, 'INVALID_EMAIL')
      let expiresAt: number | undefined
      if (input.expiresAt) {
        expiresAt = Math.floor(input.expiresAt.getTime() / 1000)
        const ahead = expiresAt - Math.floor(now() / 1000)
        if (!(ahead >= EXPIRY_MIN_S && ahead <= EXPIRY_MAX_S)) {
          throw new GatewayError(
            'expiresAt must be 30 minutes to 24 hours from now',
            'stripe',
            0,
            'INVALID_EXPIRY',
          )
        }
      }
      const preEndive = apiVersion.slice(0, 10) < ENDIVE_DATE
      const form = encodeForm({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'myr',
              unit_amount: input.amount,
              product_data: { name: input.description.trim() || input.reference },
            },
            quantity: 1,
          },
        ],
        success_url: input.returnUrl,
        cancel_url: input.returnUrl,
        client_reference_id: input.reference,
        customer_email: email || undefined,
        expires_at: expiresAt,
        ...(methods.length
          ? preEndive
            ? { payment_method_types: methods }
            : { allowed_payment_method_types: methods }
          : {}),
      })
      const json = await request('POST', '/v1/checkout/sessions', form, idempotencyKey)
      const id = json.id
      const url = json.url
      if (typeof id !== 'string' || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        throw new GatewayError('checkout session without id or url', 'stripe', 200)
      }
      return { id, url, raw: json }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      checkId(id)
      return toRecord(await request('GET', `/v1/checkout/sessions/${id}`), id)
    },

    async expirePayment(id: string): Promise<PaymentRecord> {
      checkId(id)
      return toRecord(await request('POST', `/v1/checkout/sessions/${id}/expire`, ''), id)
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        const headers = cb?.headers ?? {}
        const header =
          headers['stripe-signature'] ??
          Object.entries(headers).find(([k]) => k.toLowerCase() === 'stripe-signature')?.[1] ??
          ''
        const rawBody = typeof cb?.rawBody === 'string' ? cb.rawBody : ''
        if (!rawBody || !verifyStripeSignature(rawBody, header, config.webhookSecret, tolerance, now()))
          return null
        // JSON is parsed only after the signature checks out (stripe-node `constructEvent`).
        const event = JSON.parse(rawBody) as Record<string, unknown>
        const type = event?.type
        const data = event?.data as Record<string, unknown> | undefined
        const session = data?.object as Record<string, unknown> | undefined
        if (typeof type !== 'string' || !type.startsWith('checkout.session.') || !session) return null
        if (session.object !== 'checkout.session' || typeof session.id !== 'string') return null
        let claimedStatus = sessionStatus(session)
        if (type === 'checkout.session.async_payment_failed' && claimedStatus !== 'paid')
          claimedStatus = 'failed'
        const reference = typeof session.client_reference_id === 'string' ? session.client_reference_id : ''
        return {
          id: session.id,
          reference,
          claimedStatus,
          raw: {
            event_id: String(event.id ?? ''),
            type,
            session_id: session.id,
            client_reference_id: reference,
            status: String(session.status ?? ''),
            payment_status: String(session.payment_status ?? ''),
          },
        }
      } catch {
        return null
      }
    },
  }
}
