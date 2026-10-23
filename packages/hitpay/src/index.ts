/**
 * HitPay adapter: Payment Requests (`/v1/payment-requests`) over raw REST, zero runtime dependencies.
 *
 * Written from the official sources only, read 23 October 2026 (`gateways/hitpay/spec.md`, a source next to every
 * fact): docs.hitpayapp.com (`openapi.json` and the `.md` exports of the Online Payments, Payment Status and Webhooks
 * guides) and the official PHP SDK / WooCommerce plugin on github.com/hit-pay. NOT yet measured against the sandbox
 * (api.sandbox.hit-pay.com): where the sandbox differs from the docs, this adapter is wrong until someone runs the
 * conformance suite with sandbox keys. Note that a sandbox account must be a Singapore business and does not list FPX,
 * DuitNow or Touch 'n Go, so Malaysian methods cannot be exercised end to end before production.
 *
 * - auth = `X-BUSINESS-API-KEY: <api key>` plus `X-Requested-With: XMLHttpRequest` (the guide lists a missing header as
 *   a cause of "Invalid Business API Key");
 * - HitPay amounts are MAJOR units (ringgit): bayarkit sen are converted at the edge, both ways, and an amount string
 *   with more than two decimals reads as NaN (so confirmPayment reports a mismatch) instead of being rounded;
 * - TWO callback schemes, verified as separate paths with separate salts (contradiction 1 in the spec):
 *   1. the event webhook registered in the Dashboard (or `POST /v1/webhook-events`): JSON body, `Hitpay-Signature`
 *      header = hex HMAC-SHA256(per-webhook salt, the RAW body bytes). The Online Payments guide's Express sample signs
 *      `JSON.stringify(req.body)` instead (contradiction 3); that can fail on genuine webhooks, so only the raw body is
 *      ever verified: use `readCallback(request)`, never a parsed-and-re-serialised body;
 *   2. the legacy per-request `webhook` form POST: `hmac` field = hex HMAC-SHA256(API-key salt, every posted field
 *      except `hmac`, sorted by key, `key+value` concatenated with no separator, empty values included).
 *   When a `Hitpay-Signature` header is present only path 1 is tried (no fall-back to the other salt).
 * - the browser return (`redirect_url?reference=…&status=…`) is unsigned and always refused by `verifyCallback`.
 *
 * Choices made where the sources are silent or disagree (UNCONFIRMED in the spec), each the safe option:
 * - minimum amount: the API states 0.3 (30 sen) for any currency, so `minimumAmount` is 30. Per-method minima are
 *   enforced by HitPay, not here (Touch 'n Go 2 MYR is documented; FPX / DuitNow minima are UNCONFIRMED);
 * - create body encoding: the guide and the PHP SDK send `application/x-www-form-urlencoded`, the OpenAPI declares JSON
 *   (contradiction 4). This adapter sends form-encoded, like the official SDK, and always sends `amount` (the guide
 *   calls it mandatory; the OpenAPI optional);
 * - the per-request `webhook` parameter is called deprecated in the guide but not in the OpenAPI, and the official
 *   WooCommerce plugin still uses it (contradiction 2): `callbackUrl` is sent as `webhook`, so the legacy form
 *   callback reaches it. Register a Dashboard event webhook too (or instead); both verify;
 * - `send_sms` is documented "default false" but its schema says `default: 'true'` (contradiction 10): `send_sms` and
 *   `send_email` are always sent as `"false"`;
 * - `expiresAt` becomes `expires_after: "<n> mins"` (unit spelling from the field description; the OpenAPI example says
 *   "5 minutes"), rounded DOWN so the link never outlives `expiresAt`; less than one minute ahead is refused;
 * - `idempotencyKey`: HitPay documents no idempotency header and duplicate `reference_number` handling is UNCONFIRMED,
 *   so it is ignored. Use one reference per attempt;
 * - status mapping of a payment request: `completed` → paid, `pending` → pending, `failed` → failed, `expired` →
 *   expired, `canceled` and `inactive` → cancelled, anything else → unknown. Only `completed` is ever paid. The same
 *   mapping reads the claimed status of both callback schemes (legacy statuses seen: completed, failed, pending);
 * - event webhook payloads disagree in the docs (a payment-request object with `status: completed` vs payout- or
 *   charge-shaped examples; contradictions 5–7), and so do the `Hitpay-Event-Type` / `Hitpay-Event-Object` header
 *   values. The adapter relies on neither header: a verified body must carry a UUID `id`, which is then looked up as a
 *   payment request by confirmPayment. A charge- or payout-shaped event therefore ends as `gateway_error` (404), never
 *   as paid;
 * - paid time: there is no `paid_at`, and `created_at` / `updated_at` carry no offset (timezone UNCONFIRMED), so
 *   `paidAt` is left out;
 * - fees: `payments[].fees` is a string whose currency is not documented, so `fee` is `null`;
 * - webhook retry schedule and the expected response code are UNCONFIRMED: answer 200 quickly and make "mark paid"
 *   idempotent. Webhook source IPs (production 3.1.13.32, 52.77.254.34; sandbox 54.179.156.147) are not checked here;
 * - error messages quote HitPay's `message` / `errors` only, with any occurrence of the API key or a salt masked.
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
  toRinggit,
  toSen,
  type VerifiedCallback,
} from '@bayarkit/core'

export const HOSTS = {
  sandbox: 'https://api.sandbox.hit-pay.com',
  production: 'https://api.hit-pay.com',
} as const

export interface HitPayConfig {
  /** Business API key (Dashboard → Developers). Sandbox and production keys are separate. */
  apiKey: string
  /** The API-key salt shown beside the API key: verifies the legacy per-request `webhook` form callback (`hmac`). */
  apiSalt: string
  /** The salt of your Dashboard webhook endpoint: verifies event webhooks (`Hitpay-Signature`). */
  webhookSalt: string
  environment: keyof typeof HOSTS
  /** e.g. `['fpx', 'card']`; omitted = every method enabled on the account. */
  paymentMethods?: string[]
  /** Override the host, without `/v1` (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const NAME = 'hitpay'
const MAXIMUM_SEN = 99_999_999_999
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX64 = /^[0-9a-f]{64}$/

export const info: GatewayInfo = {
  name: NAME,
  // From the spec: the API minimum is 0.3 in any currency (create-request schema). Per-method minima are HitPay's call.
  minimumAmount: 30,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source: 'docs.hitpayapp.com (openapi.json + Online Payments / Webhooks guides) + hit-pay/php-sdk',
  },
}

/** Event webhook signature: hex HMAC-SHA256 over the RAW request body, keyed with the webhook endpoint's salt. */
export function eventSignature(webhookSalt: string, rawBody: string): string {
  return createHmac('sha256', webhookSalt).update(rawBody, 'utf8').digest('hex')
}

/** The string the legacy `hmac` signs: every field except `hmac`, sorted by key, `key+value`, no separators. */
export function formSigningString(fields: Record<string, string>): string {
  return Object.keys(fields)
    .filter((k) => k !== 'hmac')
    .sort()
    .map((k) => `${k}${fields[k] ?? ''}`)
    .join('')
}

/** Legacy form-callback `hmac`: hex HMAC-SHA256(API-key salt, `formSigningString(fields)`). */
export function formSignature(apiSalt: string, fields: Record<string, string>): string {
  return createHmac('sha256', apiSalt).update(formSigningString(fields), 'utf8').digest('hex')
}

/** Payment-request status → bayarkit status. Only `completed` is paid. */
export function requestStatus(status: unknown): PaymentStatus {
  switch (status) {
    case 'completed':
      return 'paid'
    case 'pending':
      return 'pending'
    case 'failed':
      return 'failed'
    case 'expired':
      return 'expired'
    case 'canceled':
    case 'inactive':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** "10.50" → 1050; more than two decimals, signs or anything else → NaN (never rounded into a match). */
function senOf(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return Number.NaN
  const text = String(value).trim()
  return /^\d+(\.\d{1,2})?$/.test(text) ? toSen(text) : Number.NaN
}

const chars = (text: string, max: number) => [...text].slice(0, max).join('')

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (headers[name] !== undefined) return headers[name]
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]
}

export function hitpay(config: HitPayConfig): Gateway {
  const base = (config.baseUrl ?? HOSTS[config.environment]).replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const secrets = [config.apiKey, config.apiSalt, config.webhookSalt].filter((s) => s && s.length >= 4)
  const mask = (text: string) => secrets.reduce((t, s) => t.split(s).join('[redacted]'), text)

  async function request(method: 'GET' | 'POST', path: string, form?: URLSearchParams) {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          'x-business-api-key': config.apiKey,
          'x-requested-with': 'XMLHttpRequest',
          accept: 'application/json',
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { body: form.toString() } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, NAME, 0)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { res, json }
  }

  // Quotes the RESPONSE only (masked); the key travels in a header and never reaches a message.
  function fail(what: string, res: Response, json: Record<string, unknown> | null): never {
    const message = typeof json?.message === 'string' ? json.message : ''
    const errors =
      json?.errors && typeof json.errors === 'object' ? (json.errors as Record<string, unknown>) : {}
    const details = Object.values(errors)
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .map(String)
      .filter((d) => d !== message)
    const text = [message, ...details].filter(Boolean).join('; ').slice(0, 300)
    throw new GatewayError(
      mask(`${what} HTTP ${res.status}${text ? `: ${text}` : ''}`),
      NAME,
      res.status,
      Object.keys(errors)[0],
    )
  }

  const verifyEvent = (rawBody: unknown, given: string): VerifiedCallback | null => {
    const signature = given.trim().toLowerCase()
    if (!config.webhookSalt || typeof rawBody !== 'string' || !rawBody || !HEX64.test(signature)) return null
    if (!timingSafeEqualText(eventSignature(config.webhookSalt, rawBody), signature)) return null
    // Parsed only after the signature checks out.
    const body = JSON.parse(rawBody) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const o = body as Record<string, unknown>
    if (typeof o.id !== 'string' || !UUID.test(o.id)) return null
    const reference = typeof o.reference_number === 'string' ? o.reference_number : ''
    const raw: Record<string, string> = {}
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') raw[k] = String(v)
    }
    return { id: o.id, reference, claimedStatus: requestStatus(o.status), raw }
  }

  const verifyForm = (fields: Record<string, string>): VerifiedCallback | null => {
    const given = String(fields.hmac ?? '')
      .trim()
      .toLowerCase()
    const id = String(fields.payment_request_id ?? '')
    if (!config.apiSalt || !HEX64.test(given) || !UUID.test(id)) return null
    const signed: Record<string, string> = {}
    for (const [k, v] of Object.entries(fields)) if (k !== 'hmac') signed[k] = v == null ? '' : String(v)
    if (!timingSafeEqualText(formSignature(config.apiSalt, signed), given)) return null
    return {
      id,
      reference: String(fields.reference_number ?? ''),
      claimedStatus: requestStatus(fields.status),
      raw: { ...signed },
    }
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
          `amount must be integer sen from ${info.minimumAmount} to ${MAXIMUM_SEN}, got ${input.amount}`,
          NAME,
          0,
          'INVALID_AMOUNT',
        )
      }
      if ((input.currency ?? 'MYR') !== 'MYR')
        throw new GatewayError('only MYR is supported', NAME, 0, 'CURRENCY')
      // Sent as given: truncating would make confirmPayment's reference check fail later.
      const reference = input.reference
      if (!reference.trim() || [...reference].length > 255) {
        throw new GatewayError('reference must be 1–255 characters', NAME, 0, 'INVALID_REFERENCE')
      }
      const form = new URLSearchParams({
        amount: toRinggit(input.amount),
        currency: 'MYR',
        reference_number: reference,
        redirect_url: input.returnUrl,
        webhook: input.callbackUrl,
        send_email: 'false',
        send_sms: 'false',
      })
      const purpose = chars(input.description.trim(), 255)
      if (purpose) form.set('purpose', purpose)
      const name = input.customer?.name?.trim()
      if (name) form.set('name', chars(name, 255))
      const email = input.customer?.email?.trim()
      if (email) form.set('email', email)
      // HitPay wants E.164 (`+60123456789`); anything else is left out rather than guessed.
      const phone = (input.customer?.phone ?? '').replace(/[\s()-]/g, '')
      if (/^\+[1-9]\d{7,14}$/.test(phone)) form.set('phone', phone)
      if (input.expiresAt) {
        const minutes = Math.floor((input.expiresAt.getTime() - Date.now()) / 60_000)
        if (!(minutes >= 1))
          throw new GatewayError('expiresAt must be at least one minute ahead', NAME, 0, 'INVALID_EXPIRY')
        form.set('expires_after', `${minutes} mins`)
      }
      for (const m of config.paymentMethods ?? []) form.append('payment_methods[]', m)

      const { res, json } = await request('POST', '/v1/payment-requests', form)
      const id = json?.id
      const url = json?.url
      if (
        !res.ok ||
        typeof id !== 'string' ||
        !UUID.test(id) ||
        typeof url !== 'string' ||
        !/^https?:\/\//.test(url)
      ) {
        fail('create payment request', res, json)
      }
      return { id, url, raw: json }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      if (!UUID.test(id)) throw new GatewayError('invalid payment request id', NAME, 0, 'INVALID_ID')
      const { res, json } = await request('GET', `/v1/payment-requests/${id}`)
      if (!res.ok || !json || typeof json !== 'object') fail('get payment request', res, json)
      return {
        id: typeof json.id === 'string' ? json.id : id,
        reference: typeof json.reference_number === 'string' ? json.reference_number : '',
        status: requestStatus(json.status),
        amount: senOf(json.amount),
        currency: typeof json.currency === 'string' ? json.currency.toUpperCase() : '',
        fee: null,
        raw: json,
      }
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        const signature = header(cb?.headers, 'hitpay-signature')
        if (signature !== undefined) return verifyEvent(cb.rawBody, String(signature))
        const fields = cb?.fields
        if (fields && typeof fields === 'object' && fields.hmac !== undefined) return verifyForm(fields)
        return null
      } catch {
        return null
      }
    },
  }
}
