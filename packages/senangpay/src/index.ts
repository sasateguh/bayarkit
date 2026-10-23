/**
 * senangPay adapter, on the DOKU platform (DOKU Malaysia "Global" API: Checkout).
 *
 * senangPay has moved its merchants onto DOKU and sends API integrations to the DOKU Malaysia API Reference
 * (guide.senangpay.com/doku-api-integration-guide). This adapter implements THAT contract, written from the official
 * docs only, read 23 October 2026 (`gateways/senangpay/spec.md`, a source next to every fact):
 * doku-developers.apidog.io (`.md` pages: Create / Retrieve Checkout, signature pages, sample code, notifications,
 * status table, error codes) and senangpay.com/doku-migration-faq. NOT yet measured against the DOKU sandbox
 * (api-sandbox.doku.com). The legacy API (`app.senangpay.my/payment/{merchantID}`, `hash` over
 * `secret+detail+amount+order_id`) is dead for the documented example merchant and is NOT implemented; its official
 * test vectors are kept in the tests as documentation only.
 *
 * - Credentials: Client ID, Secret Key (signs), API Key (`Authorization: Basic base64("<API key>:")`, colon included).
 * - Every request sends `Client-Id`, `Request-Timestamp` (ISO 8601 UTC, no milliseconds), `API-Version`
 *   (default `arabica.2025-12-01`) and `Signature: HMACSHA256=<base64 HMAC-SHA256(secret, string)>` where the string
 *   is `Client-Id\nRequest-Timestamp\nPath\nDigest`, values only, no trailing newline, Digest = base64(SHA-256(raw
 *   body)); GET leaves the digest line out. This follows the written rules and the Java/Ruby samples. DOKU's own
 *   Python and Node samples prefix the digest with `Digest:` and the Go sample appends it twice: both are refused.
 * - Amounts are ringgit numbers at DOKU (`100.05`); this adapter converts sen ↔ ringgit at the edge only, and reads an
 *   amount with more than two decimals as unreadable (NaN), never rounds it into a match. Minimum RM2.00 (200 sen),
 *   from the senangPay DOKU FAQ.
 * - `createPayment` = `POST /v3/checkouts` (hosted page). Your `reference` is sent as BOTH the checkout `id` (DOKU's
 *   "merchant's own unique reference", the id Retrieve takes) and `order.invoice_number`. DOKU refuses a second
 *   checkout with the same `id` (`duplicate_transaction`), so a new attempt for the same order needs a new reference.
 * - `getPayment` = `GET /v3/checkouts/{id}`. DOKU says to call it at least 60 seconds after payment completion: a
 *   `confirmPayment` right after a notification may see `not_paid`. Answer that notification with a non-2xx status so
 *   DOKU retries it (30 min, 6 h, 12 h), or check again with `getPayment` after a minute.
 * - Notifications: there is NO per-payment notification URL. Set it in DOKU Back Office → Settings → Webhook, and give
 *   this adapter its PATH as `notificationPath`: DOKU signs notifications like requests, with the path of YOUR URL.
 *   `verifyCallback` checks the RAW body (`readCallback`), with the notification's own `Client-Id` (must be yours) and
 *   `Request-Timestamp`, in constant time, and only then parses the JSON. `input.callbackUrl` is not sent.
 *
 * Where the docs are silent or contradict themselves (UNCONFIRMED in the spec), this adapter picks the safe side:
 * - status: `paid` ONLY when the checkout's `order.status` is `PAID` AND `payment.status` is `SUCCESS` (both appear in
 *   the Retrieve example; the status table says to read `status`, never `state`). `EXPIRED` → expired, `FAILED` →
 *   failed, `PENDING`/`REDIRECT` → pending; `REFUNDED`, `AUTHORIZED`, `CAPTURED`, an order and a transaction that
 *   disagree (order `PENDING` + payment `SUCCESS`) and anything else → unknown (never paid). `state` is ignored, so the `INIT` vs `INITIATE` contradiction (C5) changes nothing;
 * - the Retrieve endpoints do not list a `Signature` header, but the official samples show how to sign a GET (no digest
 *   line), so GETs are signed too; Create Checkout marks it "Conditional" and it is always sent;
 * - response signatures are NOT verified: the docs disagree on their string (3 lines without the path vs 4 lines with
 *   it, C3) and responses arrive over TLS from the host you called. Notifications ARE verified;
 * - card payments: DOKU documents a separate "Cards" notification (other body, `Request-Id` header, labelled signature
 *   string `Client-Id:…\nRequest-Id:…`, with its own contradictions C4) set in Back Office → Settings → Credit Card.
 *   This adapter does not accept that scheme: such a notification fails verification (`null`). Whether a card payment
 *   made on the Checkout page sends a Global or a Cards notification is UNCONFIRMED; the checkout itself is still read
 *   correctly by `getPayment`;
 * - no `Request-Timestamp` age window is enforced on notifications: DOKU's tolerance is UNCONFIRMED and so is whether
 *   a retry 12 hours later carries a fresh timestamp. Replays are stopped by `confirmPayment` asking DOKU again;
 * - references: DOKU's `reference_id` pattern allows `:` but its Identity type does not (C10); `:` is refused, and so
 *   is anything over 30 characters (`invoice_number` limit when the card channel is active). `idempotencyKey` is sent
 *   as `Idempotency-Id` and must match the Identity pattern, at most 255 characters;
 * - `expired_at` is required by DOKU; without `expiresAt` this adapter sends 24 hours from now (DOKU gives no
 *   default). With an `Idempotency-Id`, a retried call therefore needs the same `expiresAt` to be the same payload;
 * - the description is sent as one line item (name ≤ 100 characters; DOKU publishes no limit for it); customer phone
 *   is sent only when already in E.164 (`+60123456789`), email only up to 128 characters, name trimmed to 100;
 * - payment channels are not restricted (DOKU's schema says `payment_channels`, every example sends `channels`, C7):
 *   the Checkout page shows every channel the merchant has;
 * - no paid-at timestamp is documented for non-card channels, so `paidAt` is left out; no fee is reported (`null`);
 * - error messages quote DOKU's `error.code` / `error.message`; any occurrence of your API key, secret key or Basic
 *   credential is masked before it reaches a message.
 */
import { createHash, createHmac } from 'node:crypto'
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

export const HOSTS = {
  sandbox: 'https://api-sandbox.doku.com',
  production: 'https://api.doku.com',
} as const

export const API_VERSION = 'arabica.2025-12-01'

export interface SenangPayConfig {
  /** DOKU Client ID (one per environment). Sent as `Client-Id`; notifications must carry the same value. */
  clientId: string
  /** DOKU Secret Key: signs requests and verifies notifications. */
  secretKey: string
  /** DOKU API Key: the Basic-auth username (empty password). */
  apiKey: string
  environment: keyof typeof HOSTS
  /**
   * The PATH of the notification URL you set in DOKU Back Office → Settings → Webhook, e.g. `/payments/doku` for
   * `https://shop.example/payments/doku`. DOKU signs notifications over it.
   */
  notificationPath: string
  /** Sent as `API-Version`. Default `arabica.2025-12-01`. */
  apiVersion?: string
  /** Clock in milliseconds since the epoch (tests). Default `Date.now`. */
  now?: () => number
  /** Override the host (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const NAME = 'senangpay'
/** DOKU's Identity type (`^[A-Za-z0-9-_]+`), the stricter of the two published patterns (C10). */
const IDENTITY = /^[A-Za-z0-9_-]+$/
const REFERENCE_MAX = 30
const IDEMPOTENCY_MAX = 255
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000
const E164 = /^\+[1-9]\d{1,14}$/

export const info: GatewayInfo = {
  name: NAME,
  // RM2.00 minimum: senangpay.com/doku-migration-faq #Payments Q11.
  minimumAmount: 200,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source: 'DOKU Malaysia API Reference (doku-developers.apidog.io) + senangpay.com/doku-migration-faq',
  },
}

/** base64(SHA-256(raw body bytes)): the Digest component. */
export function dokuDigest(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('base64')
}

/**
 * The string DOKU's Global signature covers: values only, one per line, no trailing newline. `digest` is left out
 * (with its newline) for requests without a body.
 */
export function signingString(parts: {
  clientId: string
  timestamp: string
  path: string
  digest?: string
}): string {
  const lines = [parts.clientId, parts.timestamp, parts.path]
  if (parts.digest) lines.push(parts.digest)
  return lines.join('\n')
}

/** `HMACSHA256=` + base64 HMAC-SHA256 keyed with the Secret Key (UTF-8) over `signingString`. */
export function dokuSignature(secretKey: string, text: string): string {
  return `HMACSHA256=${createHmac('sha256', secretKey).update(text, 'utf8').digest('base64')}`
}

/**
 * Check a `Signature` header over the RAW body, in constant time. Returns false instead of throwing. `path` is the
 * path of the URL the request was sent to (your notification URL for notifications).
 */
export function verifyDokuSignature(
  secretKey: string,
  given: string,
  parts: { clientId: string; timestamp: string; path: string; rawBody: string },
): boolean {
  if (!secretKey || !given || !parts.clientId || !parts.timestamp || !parts.rawBody) return false
  const expected = dokuSignature(
    secretKey,
    signingString({
      clientId: parts.clientId,
      timestamp: parts.timestamp,
      path: parts.path,
      digest: dokuDigest(parts.rawBody),
    }),
  )
  return timingSafeEqualText(expected, given)
}

/** DOKU ringgit (number, or a numeric string) → integer sen; NaN for anything else or more than two decimals. */
export function senOf(value: unknown): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(n) || n < 0) return Number.NaN
  const sen = Math.round(n * 100)
  return Math.abs(sen - n * 100) < 1e-6 ? sen : Number.NaN
}

const text = (v: unknown) => (typeof v === 'string' ? v : '')
const obj = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** A checkout from Retrieve: both the order and the transaction must say so before it is `paid`. */
function checkoutStatus(orderStatus: string, paymentStatus: string): PaymentStatus {
  if (orderStatus === 'PAID' && paymentStatus === 'SUCCESS') return 'paid'
  if (orderStatus === 'EXPIRED' || paymentStatus === 'EXPIRED') return 'expired'
  if (paymentStatus === 'FAILED') return 'failed'
  if (paymentStatus === 'PENDING' || paymentStatus === 'REDIRECT') return 'pending'
  if (orderStatus === 'PENDING' && !paymentStatus) return 'pending'
  return 'unknown'
}

/** A notification's claim (it carries no order status). Still only a claim: `confirmPayment` asks DOKU again. */
function claimedStatusOf(paymentStatus: string): PaymentStatus {
  switch (paymentStatus) {
    case 'SUCCESS':
      return 'paid'
    case 'FAILED':
      return 'failed'
    case 'EXPIRED':
      return 'expired'
    case 'PENDING':
    case 'REDIRECT':
      return 'pending'
    default:
      return 'unknown'
  }
}

const chars = (value: string, max: number) => [...value].slice(0, max).join('')
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function senangpay(config: SenangPayConfig): Gateway {
  const base = (config.baseUrl ?? HOSTS[config.environment] ?? '').replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const apiVersion = config.apiVersion ?? API_VERSION
  const now = config.now ?? Date.now
  const notificationPath = config.notificationPath ?? ''
  if (!config.clientId || !config.secretKey || !config.apiKey || !base) {
    throw new GatewayError('clientId, secretKey, apiKey and environment are required', NAME, 0, 'CONFIG')
  }
  if (!/^\/[^\s?#]*$/.test(notificationPath)) {
    throw new GatewayError(
      'notificationPath must be the path of your notification URL, starting with "/"',
      NAME,
      0,
      'CONFIG',
    )
  }
  const basic = Buffer.from(`${config.apiKey}:`).toString('base64')
  const secrets = [config.secretKey, config.apiKey, basic].filter((s) => s.length >= 4)
  const mask = (message: string) => secrets.reduce((m, s) => m.split(s).join('[redacted]'), message)

  async function request(method: 'GET' | 'POST', path: string, body?: string, idempotencyId?: string) {
    const timestamp = isoSeconds(now())
    const headers: Record<string, string> = {
      authorization: `Basic ${basic}`,
      'client-id': config.clientId,
      'request-timestamp': timestamp,
      'api-version': apiVersion,
      accept: 'application/json',
      signature: dokuSignature(
        config.secretKey,
        signingString({
          clientId: config.clientId,
          timestamp,
          path,
          ...(body !== undefined ? { digest: dokuDigest(body) } : {}),
        }),
      ),
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (idempotencyId) headers['idempotency-id'] = idempotencyId
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, NAME, 0)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok || !json) {
      const err = obj(json?.error)
      const code = text(err?.code)
      const message = text(err?.message)
      throw new GatewayError(
        mask(
          `${method} ${path.split('/').slice(0, 3).join('/')} HTTP ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message.slice(0, 300)}` : ''}`,
        ),
        NAME,
        res.status,
        code || undefined,
      )
    }
    return json
  }

  return {
    info,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (!Number.isInteger(input.amount) || input.amount < info.minimumAmount) {
        throw new GatewayError(
          `amount must be integer sen ≥ ${info.minimumAmount}, got ${input.amount}`,
          NAME,
          0,
          'INVALID_AMOUNT',
        )
      }
      if ((input.currency ?? 'MYR') !== 'MYR')
        throw new GatewayError('only MYR is supported', NAME, 0, 'CURRENCY')
      const reference = input.reference
      if (typeof reference !== 'string' || !IDENTITY.test(reference) || reference.length > REFERENCE_MAX) {
        throw new GatewayError(
          `reference must be 1–${REFERENCE_MAX} characters of A–Z, a–z, 0–9, "-" and "_"`,
          NAME,
          0,
          'INVALID_REFERENCE',
        )
      }
      const idempotencyId = input.idempotencyKey
      if (
        idempotencyId !== undefined &&
        (!IDENTITY.test(idempotencyId) || idempotencyId.length > IDEMPOTENCY_MAX)
      ) {
        throw new GatewayError(
          `idempotencyKey must be 1–${IDEMPOTENCY_MAX} characters of A–Z, a–z, 0–9, "-" and "_"`,
          NAME,
          0,
          'INVALID_KEY',
        )
      }
      const expiresMs = input.expiresAt ? input.expiresAt.getTime() : now() + DEFAULT_EXPIRY_MS
      if (!Number.isFinite(expiresMs) || expiresMs <= now()) {
        throw new GatewayError('expiresAt must be in the future', NAME, 0, 'INVALID_EXPIRY')
      }
      const ringgit = input.amount / 100
      const name = chars(input.customer?.name?.trim() ?? '', 100)
      const email = input.customer?.email?.trim() ?? ''
      const phone = (input.customer?.phone ?? '').replace(/[\s()-]/g, '')
      const customer = {
        ...(name ? { name } : {}),
        ...(email && email.length <= 128 ? { email } : {}),
        ...(E164.test(phone) ? { phone } : {}),
      }
      const body = JSON.stringify({
        id: reference,
        order: {
          amount: ringgit,
          invoice_number: reference,
          currency: 'MYR',
          line_items: [
            { name: chars(input.description.trim(), 100) || reference, quantity: 1, price: ringgit },
          ],
          expired_at: isoSeconds(expiresMs),
        },
        checkout_experience: { callback_url: input.returnUrl },
        ...(Object.keys(customer).length ? { customer } : {}),
      })
      const json = await request('POST', '/v3/checkouts', body, idempotencyId)
      const url = text(obj(json.payment)?.checkout_url)
      if (json.id !== reference || !/^https?:\/\//.test(url)) {
        throw new GatewayError('create checkout: response without this id or a checkout_url', NAME, 200)
      }
      return { id: reference, url, raw: json }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      if (typeof id !== 'string' || !IDENTITY.test(id) || id.length > 128)
        throw new GatewayError('invalid checkout id', NAME, 0, 'INVALID_ID')
      const json = await request('GET', `/v3/checkouts/${id}`)
      const order = obj(json.order)
      const payment = obj(json.payment)
      return {
        id: typeof json.id === 'string' ? json.id : id,
        reference: text(order?.invoice_number),
        status: checkoutStatus(text(order?.status), text(payment?.status)),
        // What was paid when the retrieve says so (`payment.amount`, the create-payment schema); the checkout retrieve
        // documents only `order.amount`, which is used otherwise.
        amount: senOf(payment?.amount ?? order?.amount),
        currency: text(order?.currency),
        // DOKU reports no fee and, for non-card channels, no paid-at time.
        fee: null,
        raw: json,
      }
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        const headers = cb?.headers ?? {}
        const header = (name: string) =>
          headers[name] ?? Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? ''
        const clientId = header('client-id')
        const timestamp = header('request-timestamp')
        const rawBody = typeof cb?.rawBody === 'string' ? cb.rawBody : ''
        if (clientId !== config.clientId || !timestamp || /[\r\n]/.test(timestamp)) return null
        if (
          !verifyDokuSignature(config.secretKey, header('signature'), {
            clientId,
            timestamp,
            path: notificationPath,
            rawBody,
          })
        )
          return null
        // JSON is parsed only after the signature checks out.
        const body = obj(JSON.parse(rawBody))
        const order = obj(body?.order)
        const payment = obj(body?.payment)
        const id = body?.id
        if (typeof id !== 'string' || !IDENTITY.test(id) || !order || !payment) return null
        const status = text(payment.status)
        return {
          id,
          reference: text(order.invoice_number),
          claimedStatus: claimedStatusOf(status),
          raw: {
            id,
            invoice_number: text(order.invoice_number),
            amount: String(order.amount ?? ''),
            currency: text(order.currency),
            channel: text(payment.channel),
            status,
            state: text(payment.state),
          },
        }
      } catch {
        return null
      }
    },
  }
}
