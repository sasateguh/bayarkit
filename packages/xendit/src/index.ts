/**
 * Xendit (Malaysia) adapter: Payment Sessions (`/sessions`, hosted checkout) plus the v3 payment request lookup
 * (`/v3/payment_requests/{id}`), over raw REST with zero runtime dependencies.
 *
 * Written from the official sources only, read 23 October 2026 (`gateways/xendit/spec.md`, a source next to every
 * fact): docs.xendit.co (`.md` exports with the embedded OpenAPI) and Xendit's own agent skill (github.com/xendit/
 * xendit-ai). NOT yet measured against a Xendit test-mode account: where test mode differs from the docs, this adapter
 * is wrong until someone runs the conformance suite with a `xnd_development_…` key.
 *
 * ⚠ WEBHOOKS ARE NOT SIGNED. Xendit sends a STATIC per-environment token in the `x-callback-token` header and nothing
 * else: no HMAC, no signature over the body, no timestamp, no nonce (spec §4). `verifyCallback` compares that header
 * with your configured `callbackToken` in constant time, and only then parses the RAW JSON body. That is much weaker
 * than a signature: anyone who has seen the token once (a log, a proxy, a leaked env file) can send any body they like,
 * forever, and a genuine webhook can be replayed or have its body altered without the check noticing. The real
 * protection is `confirmPayment`, which ignores the body's claims and asks Xendit again with a fresh GET; Xendit's own
 * WHMCS plugin does exactly that (it re-fetches the invoice and trusts only that answer). Never mark an order paid from
 * the webhook body.
 *
 * - Host: `https://api.xendit.co` for test AND live. The API key's prefix picks the mode: `xnd_development_…` = test,
 *   `xnd_production_…` = live. Any other key is refused when the gateway is created. Each mode has its own webhook token.
 * - Auth: HTTP Basic with the secret key as user name and an empty password (`base64("<key>:")`).
 * - Amounts: Xendit uses MAJOR units (ringgit with decimals), not sen. bayarkit sen are converted at the edge both ways
 *   (1050 sen → `10.5`); an amount that is not a whole number of sen, or not a JSON number, reads back as NaN, so
 *   `confirmPayment` reports a mismatch instead of rounding.
 * - Sessions are created as `session_type: PAY`, `mode: PAYMENT_LINK`, `capture_method: AUTOMATIC`, `country: MY`,
 *   `currency: MYR`; redirect the customer to the returned `url` (`payment_link_url`). Xendit says never to log or
 *   store that URL; store the id (`ps-…`) and fetch the session again if you need the link.
 * - There is no per-request callback URL (`input.callbackUrl` is not sent): set the webhook URL and copy the
 *   verification token in Dashboard → Settings → Webhooks, for payment sessions AND for payments.
 * - Webhooks read: `payment_session.completed` / `payment_session.expired` (the id is the session `ps-…`) and
 *   `payment.capture` / `payment.authorization` / `payment.failure` (the id is the payment request `pr-…`, and
 *   `getPayment` then reads `GET /v3/payment_requests/{id}` with `api-version: 2024-11-11`). Refund and other events
 *   read as `null`. Xendit recommends fulfilling on `payment.capture`: a payment received after a session was
 *   cancelled or expired is still collected and the session status does not change, so only the payment request
 *   shows it.
 * - Statuses are spelled as the OpenAPI spells them: sessions `ACTIVE`/`COMPLETED`/`EXPIRED`/`CANCELED` (one L),
 *   payment requests `ACCEPTING_PAYMENTS`/`REQUIRES_ACTION`/`AUTHORIZED`/`CANCELED`/`EXPIRED`/`SUCCEEDED`/`FAILED`.
 *   Refunds use `CANCELLED` (two Ls); refunds are not read here. FPX has NO refunds at all.
 * - `cancelPayment(id)` = `POST /sessions/{id}/cancel` (ACTIVE sessions only).
 *
 * Choices made where the sources are silent or disagree (UNCONFIRMED in the spec), each the safe option:
 * - minimum amount: no session-level minimum is documented (the API only says > 0); every Malaysian channel page gives
 *   RM 1, so `minimumAmount` is 100 sen. Channel maximums (FPX 30,000.00, Touch 'n Go 25,000.00, cards 5,000.00) are
 *   left to Xendit;
 * - MYR decimal places: the docs only say "the decimal places allowed for the given currency". The adapter sends at
 *   most two (whole sen) and reads back strictly (see Amounts above); if Xendit refuses, its `INVALID_AMOUNT` is quoted;
 * - idempotency: no idempotency header is documented for `/sessions`, and `reference_id` uniqueness is not enforced,
 *   so `idempotencyKey` is ignored and a retried `createPayment` can create a second session. Use one reference per
 *   attempt and let `confirmPayment` match it;
 * - replay protection: none exists. The adapter cannot add one without a timestamp; `confirmPayment` (fresh GET +
 *   exact reference/amount/currency match) is what makes a replay harmless. Make "mark order paid" idempotent:
 *   duplicates and out-of-order deliveries are documented;
 * - contradiction C1: the session-webhook OpenAPI declares Basic auth and no token header, while the prose docs and the
 *   payment/refund OpenAPI say every webhook carries `x-callback-token`. Session webhooks are treated like the rest:
 *   no token = `null`, and an `Authorization` header is never accepted instead;
 * - contradiction C2: the Magento/WooCommerce plugins verify an undocumented ECDSA-P384 "TPI" channel with a
 *   `signature` field in the body. It is not for custom integrations and has no test vector, so it is ignored: a body
 *   `signature` never stands in for the token;
 * - contradiction C3: the session-webhook schema has no `amount`/`currency`, its examples do. Neither is read from any
 *   callback; amount, currency and reference come from `getPayment`;
 * - contradiction C5: Xendit's agent skill says a cancelled session becomes `CANCELLED`, the enum says `CANCELED`. Both
 *   read as `cancelled` (neither is ever paid);
 * - contradiction C8 / C12: the migration guide calls the failure event `payment.failed` (the enum says
 *   `payment.failure`), and the webhook table adds `payment.expiry`. All three are read; only the fresh GET decides;
 * - a `COMPLETED` session is `paid` only when it is a `PAY` session whose `capture_method` is not `MANUAL` (a manual
 *   capture session completes on authorisation, before money moves); `AUTHORIZED` payment requests are `pending`;
 * - a payment request's amount is the sum of `captures[].capture_amount` when captures are present (what was actually
 *   collected), otherwise `request_amount`. That a session-started payment request carries the session's
 *   `reference_id` is UNCONFIRMED: if it does not, `confirmPayment` on a `payment.capture` callback ends as `mismatch`
 *   (never paid) and the `payment_session.completed` callback is the one that confirms;
 * - paid time: the session object has no paid-time field, so a session's `paidAt` is left out; a payment request's
 *   `paidAt` is its last `capture_timestamp` (ISO 8601; precision and time zone are UNCONFIRMED, an unparsable value is
 *   left out). `fee` is never reported;
 * - `customer` is not sent: it is not required for PAY sessions, and its `reference_id` format contradicts its own
 *   examples (C13); `metadata` is not sent either (C4: 50/40/500 vs 20/40/80 limits);
 * - `expiresAt` must be at least 10 minutes ahead (checked before calling Xendit); the documented maximum has no number,
 *   so Xendit's `INVALID_EXPIRY_DATE` decides. Return URLs must be HTTPS (checked before calling Xendit);
 * - webhook source IPs are not published (only "contact CS"), so none are checked; the webhook timeout for v3 is
 *   undocumented: answer 2xx quickly and process asynchronously;
 * - error messages quote Xendit's `message` and `error_code` only, with anything shaped like a Xendit key and the
 *   configured webhook token masked.
 */
import { createHash } from 'node:crypto'
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

export const BASE_URL = 'https://api.xendit.co'
/** The only value of the v3 `api-version` header enum. */
export const API_VERSION = '2024-11-11'
const MIN_EXPIRY_MS = 10 * 60_000
const SESSION_ID = /^ps-[A-Za-z0-9]{24}$/
const PAYMENT_REQUEST_ID = /^pr-[A-Za-z0-9-]{1,64}$/
const SESSION_EVENTS = new Set(['payment_session.completed', 'payment_session.expired'])
const PAYMENT_EVENTS = new Set([
  'payment.capture',
  'payment.authorization',
  'payment.failure',
  // C8: the migration guide's spelling of payment.failure.
  'payment.failed',
  // C12: listed in the webhook table, not in the OpenAPI enum.
  'payment.expiry',
])

export interface XenditConfig {
  /** Secret API key. `xnd_development_…` = test mode, `xnd_production_…` = live mode (same host). */
  secretKey: string
  /** The webhook verification token from Dashboard → Settings → Webhooks (one per mode). Compared, never sent. */
  callbackToken: string
  /** Optional guard: refuse to start when the key's prefix says the other mode. */
  environment?: 'test' | 'live'
  /** Channel codes for `allowed_payment_channels` (e.g. `['MAYB2U_FPX', 'DUITNOW_PAY']`). Default: all activated. */
  paymentChannels?: string[]
  /** Clock in milliseconds since the epoch (tests). Default `Date.now`. */
  now?: () => number
  /** Override the host (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export const info: GatewayInfo = {
  name: 'xendit',
  minimumAmount: 100,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source:
      'docs.xendit.co (.md + embedded OpenAPI: sessions, payment webhooks) + github.com/xendit/xendit-ai',
  },
}

/** 1050 sen → 10.5 ringgit (a JSON number; integer sen divided by 100 prints with at most two decimals). */
export function senToRinggit(sen: number): number {
  if (!Number.isInteger(sen)) throw new RangeError('amount must be integer sen')
  return sen / 100
}

/** A Xendit amount (JSON number, ringgit) → sen. NaN unless it is a finite, non-negative whole number of sen. */
export function ringgitToSen(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return Number.NaN
  const sen = Math.round(value * 100)
  return Math.abs(value * 100 - sen) < 1e-6 ? sen : Number.NaN
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/**
 * The whole of Xendit's webhook "verification": the `x-callback-token` header equals the configured token. Both are
 * hashed first so the comparison is constant-time and does not leak the token's length. Empty values never match.
 */
export function verifyCallbackToken(received: string | undefined, configured: string): boolean {
  if (typeof received !== 'string' || !received || !configured) return false
  return timingSafeEqualText(sha256(received), sha256(configured))
}

/** A session (GET `/sessions/{id}`) → bayarkit status. Only a completed, automatically captured PAY session is paid. */
export function sessionStatus(s: Record<string, unknown>): PaymentStatus {
  switch (s.status) {
    case 'COMPLETED':
      if (s.session_type !== 'PAY') return 'unknown'
      return s.capture_method === 'MANUAL' ? 'pending' : 'paid'
    case 'ACTIVE':
      return 'pending'
    case 'EXPIRED':
      return 'expired'
    case 'CANCELED': // the OpenAPI enum
    case 'CANCELLED': // C5: Xendit's agent skill
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** A v3 payment request or payment → bayarkit status. Only `SUCCEEDED` is paid. */
export function paymentRequestStatus(p: Record<string, unknown>): PaymentStatus {
  switch (p.status) {
    case 'SUCCEEDED':
      return 'paid'
    case 'REQUIRES_ACTION':
    case 'ACCEPTING_PAYMENTS':
    case 'PENDING':
    case 'AUTHORIZED': // manual capture: authorised, not collected
      return 'pending'
    case 'FAILED':
      return 'failed'
    case 'CANCELED':
    case 'CANCELLED':
      return 'cancelled'
    case 'EXPIRED':
      return 'expired'
    default:
      return 'unknown'
  }
}

/** What a session webhook claims (the body is unverified; `getPayment` decides). */
const sessionClaim = (event: string, data: Record<string, unknown>): PaymentStatus => {
  if (data.status === 'COMPLETED') return 'paid'
  if (typeof data.status === 'string') return sessionStatus(data)
  return event === 'payment_session.completed' ? 'paid' : 'expired'
}

const paymentClaim = (event: string, data: Record<string, unknown>): PaymentStatus => {
  const s = paymentRequestStatus(data)
  if (s !== 'unknown') return s
  if (event === 'payment.capture') return 'paid'
  if (event === 'payment.failure' || event === 'payment.failed') return 'failed'
  if (event === 'payment.expiry') return 'expired'
  return 'pending'
}

const KEYISH = /\bxnd_[A-Za-z0-9_]+/g

const headerValue = (headers: Record<string, string> | undefined, name: string): string | undefined => {
  if (!headers) return undefined
  if (typeof headers[name] === 'string') return headers[name]
  const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name)
  return typeof hit?.[1] === 'string' ? hit[1] : undefined
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function xendit(config: XenditConfig): Gateway & {
  /** Cancel an ACTIVE session (`POST /sessions/{id}/cancel`). A payment arriving afterwards is still collected. */
  cancelPayment(id: string): Promise<PaymentRecord>
} {
  const base = (config.baseUrl ?? BASE_URL).replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const now = config.now ?? Date.now
  const mode = /^xnd_development_/.test(config.secretKey ?? '')
    ? 'test'
    : /^xnd_production_/.test(config.secretKey ?? '')
      ? 'live'
      : null
  if (!mode) {
    throw new GatewayError(
      'secretKey must be a Xendit secret key (xnd_development_… or xnd_production_…)',
      'xendit',
      0,
      'CONFIG',
    )
  }
  if (config.environment && config.environment !== mode) {
    throw new GatewayError(
      `environment is "${config.environment}" but the key is a ${mode} key`,
      'xendit',
      0,
      'CONFIG',
    )
  }
  if (typeof config.callbackToken !== 'string' || !config.callbackToken) {
    throw new GatewayError(
      'callbackToken (Dashboard → Settings → Webhooks) is required',
      'xendit',
      0,
      'CONFIG',
    )
  }
  const auth = `Basic ${Buffer.from(`${config.secretKey}:`).toString('base64')}`

  /** Xendit's own error text and code, with anything shaped like a key, and the webhook token, masked. */
  const quote = (json: Record<string, unknown> | null, fallback: string) => {
    let message = typeof json?.message === 'string' && json.message ? json.message : fallback
    message = message.replace(KEYISH, '[redacted]').split(config.callbackToken).join('[redacted]')
    return { message, code: typeof json?.error_code === 'string' ? json.error_code : undefined }
  }

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, v3 = false) {
    const headers: Record<string, string> = { authorization: auth, accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (v3) headers['api-version'] = API_VERSION
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, 'xendit', 0)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok || !json || typeof json !== 'object') {
      const q = quote(json, `HTTP ${res.status}`)
      throw new GatewayError(q.message, 'xendit', res.status, q.code)
    }
    return json
  }

  const sessionRecord = (s: Record<string, unknown>, id: string): PaymentRecord => ({
    id: str(s.payment_session_id) || id,
    reference: str(s.reference_id),
    status: sessionStatus(s),
    amount: ringgitToSen(s.amount),
    currency: str(s.currency),
    raw: s,
  })

  const paymentRequestRecord = (p: Record<string, unknown>, id: string): PaymentRecord => {
    const captures = Array.isArray(p.captures)
      ? (p.captures as unknown[]).filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      : []
    const amount = captures.length
      ? captures.reduce((sum, c) => sum + ringgitToSen(c.capture_amount), 0)
      : ringgitToSen(p.request_amount)
    const lastCapture = captures.at(-1)?.capture_timestamp
    const paidAt = typeof lastCapture === 'string' ? new Date(lastCapture) : undefined
    return {
      id: str(p.payment_request_id) || id,
      reference: str(p.reference_id),
      status: paymentRequestStatus(p),
      amount,
      currency: str(p.currency),
      ...(paidAt && !Number.isNaN(paidAt.getTime()) ? { paidAt } : {}),
      raw: p,
    }
  }

  return {
    info,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (!Number.isInteger(input.amount) || input.amount < info.minimumAmount) {
        throw new GatewayError(
          `amount must be integer sen, at least ${info.minimumAmount}`,
          'xendit',
          0,
          'INVALID_AMOUNT',
        )
      }
      if ((input.currency ?? 'MYR') !== 'MYR')
        throw new GatewayError('only MYR is supported', 'xendit', 0, 'CURRENCY')
      if (!input.reference || input.reference.length > 64) {
        throw new GatewayError('reference must be 1 to 64 characters', 'xendit', 0, 'INVALID_REFERENCE')
      }
      if (!/^https:\/\/\S+$/.test(input.returnUrl ?? '')) {
        throw new GatewayError('returnUrl must be an HTTPS URL', 'xendit', 0, 'INVALID_URL')
      }
      let expiresAt: string | undefined
      if (input.expiresAt) {
        const t = input.expiresAt.getTime()
        if (!(t - now() >= MIN_EXPIRY_MS)) {
          throw new GatewayError(
            'expiresAt must be at least 10 minutes from now',
            'xendit',
            0,
            'INVALID_EXPIRY',
          )
        }
        expiresAt = input.expiresAt.toISOString()
      }
      const description = (input.description ?? '').trim().slice(0, 1000) || input.reference
      const channels = config.paymentChannels ?? []
      const json = await request('POST', '/sessions', {
        reference_id: input.reference,
        session_type: 'PAY',
        mode: 'PAYMENT_LINK',
        amount: senToRinggit(input.amount),
        currency: 'MYR',
        country: 'MY',
        capture_method: 'AUTOMATIC',
        description,
        success_return_url: input.returnUrl,
        cancel_return_url: input.returnUrl,
        ...(expiresAt ? { expires_at: expiresAt } : {}),
        ...(channels.length ? { allowed_payment_channels: channels } : {}),
      })
      const id = json.payment_session_id
      const url = json.payment_link_url
      if (
        typeof id !== 'string' ||
        !SESSION_ID.test(id) ||
        typeof url !== 'string' ||
        !/^https:\/\//.test(url)
      ) {
        throw new GatewayError('session without payment_session_id or payment_link_url', 'xendit', 201)
      }
      return { id, url, raw: json }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      if (SESSION_ID.test(id)) return sessionRecord(await request('GET', `/sessions/${id}`), id)
      if (PAYMENT_REQUEST_ID.test(id)) {
        return paymentRequestRecord(await request('GET', `/v3/payment_requests/${id}`, undefined, true), id)
      }
      throw new GatewayError(
        'invalid id (expected a ps-… session or pr-… payment request)',
        'xendit',
        0,
        'INVALID_ID',
      )
    },

    async cancelPayment(id: string): Promise<PaymentRecord> {
      if (!SESSION_ID.test(id)) throw new GatewayError('invalid session id', 'xendit', 0, 'INVALID_ID')
      return sessionRecord(await request('POST', `/sessions/${id}/cancel`), id)
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        // The token is the ONLY check Xendit offers (see the header comment). C1: no Authorization fallback.
        if (!verifyCallbackToken(headerValue(cb?.headers, 'x-callback-token'), config.callbackToken))
          return null
        const rawBody = typeof cb?.rawBody === 'string' ? cb.rawBody : ''
        if (!rawBody) return null
        const payload = JSON.parse(rawBody) as Record<string, unknown>
        const event = payload?.event
        const data = payload?.data as Record<string, unknown> | undefined
        if (typeof event !== 'string' || !data || typeof data !== 'object' || Array.isArray(data)) return null
        let id: string
        let claimedStatus: PaymentStatus
        if (SESSION_EVENTS.has(event)) {
          id = str(data.payment_session_id)
          if (!SESSION_ID.test(id)) return null
          claimedStatus = sessionClaim(event, data)
        } else if (PAYMENT_EVENTS.has(event)) {
          id = str(data.payment_request_id)
          if (!PAYMENT_REQUEST_ID.test(id)) return null
          claimedStatus = paymentClaim(event, data)
        } else {
          return null
        }
        const reference = str(data.reference_id)
        return {
          id,
          reference,
          claimedStatus,
          raw: {
            event,
            id,
            reference_id: reference,
            status: str(data.status),
            payment_id: str(data.payment_id),
            business_id: str(payload.business_id),
          },
        }
      } catch {
        return null
      }
    },
  }
}
