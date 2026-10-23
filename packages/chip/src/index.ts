/**
 * CHIP Collect (chip-in.asia) adapter.
 *
 * Written from the official OpenAPI (https://docs.chip-in.asia/openapi/chip-collect.yaml, read 2026-10-23, which the
 * docs call "the canonical machine-readable source of truth") and `gateways/chip/spec.md`. NOT yet measured against
 * CHIP's test mode: where test mode differs from the OpenAPI, this adapter will be wrong until someone runs the
 * conformance suite with test keys.
 *
 * - one host, `https://gate.chip-in.asia/api/v1`. There is no sandbox host: test vs live is decided by the SECRET KEY
 *   (test keys create `is_test: true` purchases that never move real money). `environment` therefore picks no host; it
 *   only makes the adapter refuse a purchase whose `is_test` disagrees (a test payment can never mark a live order paid);
 * - amounts are integer sen everywhere (`price: 100` = RM1.00), so no conversion happens;
 * - `success_callback` must not spell out a port, not even `:443` (`webhooks_callback_port`); the adapter refuses such
 *   a URL before calling CHIP. Redirect and callback URLs go at the TOP level of the body (nested = ignored silently);
 * - callbacks are signed in the `X-Signature` header: base64 RSA PKCS#1 v1.5 over SHA-256 of the RAW body. The body
 *   must never be re-serialised before verifying. RSA verification is not a string comparison, so
 *   `timingSafeEqualText` does not apply here;
 * - `GET /public_key/` answers a JSON-ENCODED string (`"-----BEGIN PUBLIC KEY-----\n…"`), not a bare PEM and not
 *   `{"public_key": …}` (the official PHP SDK getter reads `public_key` and is wrong). `fetchPublicKey()` decodes it.
 *
 * Docs vs the official secondary material (followed: the OpenAPI):
 *
 * | Thing                   | CHIP's AI skill / PHP SDK                 | OpenAPI                                         |
 * |-------------------------|-------------------------------------------|-------------------------------------------------|
 * | Failure URL fields      | `failure_callback`, `cancel_callback`     | only `success_callback`; `failure_redirect`     |
 * | Status `failed`         | listed                                    | does not exist; `error` = a failed ATTEMPT      |
 * | Callback payload        | `{event_type, object: {...}}`             | the Purchase itself, plus `event_type`          |
 * | `GET /public_key/`      | `{"public_key": ...}` (PHP SDK)           | a JSON-encoded PEM string                       |
 *
 * UNCONFIRMED in the OpenAPI, and what this adapter does about it:
 * - `Idempotency-Key`: only the docs' error page mentions it; the OpenAPI and every SDK ignore it. Not sent. Dedupe on
 *   your own `reference` and the stored purchase id.
 * - Whether the company public key differs between test and live keys: fetch it with the SAME secret key you use.
 * - Whether anything is delivered on expiry (there is no `purchase.expired` event): poll `getPayment`.
 * - Field-level 400 bodies: only one example exists; error messages are read from any `{message, code}` in the body.
 */
import { createPublicKey, type KeyObject, verify } from 'node:crypto'
import {
  type CallbackInput,
  type CreatedPayment,
  type CreatePaymentInput,
  type Gateway,
  GatewayError,
  type GatewayInfo,
  type PaymentRecord,
  type PaymentStatus,
  type VerifiedCallback,
} from '@bayarkit/core'

export const BASE_URL = 'https://gate.chip-in.asia/api/v1'

/** Payment method names allowed in `payment_method_whitelist` (OpenAPI enum). */
export type ChipPaymentMethod =
  | 'fpx'
  | 'fpx_b2b1'
  | 'crypto_coin'
  | 'dnqr'
  | 'duitnow_qr'
  | 'maestro'
  | 'mastercard'
  | 'mpgs_apple_pay'
  | 'mpgs_google_pay'
  | 'razer_atome'
  | 'razer_grabpay'
  | 'razer_maybankqr'
  | 'razer_shopeepay'
  | 'razer_tng'
  | 'shopee_pay'
  | 'visa'

export interface ChipConfig {
  /** Secret key (Bearer). A test-mode key creates test purchases; a live key creates live ones. Same host for both. */
  secretKey: string
  /** Brand ID (UUID) from Portal → Developers → Brands. */
  brandId: string
  /**
   * PEM public key that signs `success_callback` deliveries. Get it once with `fetchPublicKey()` (using the same secret
   * key) and store it in your config. Without it, `verifyCallback` returns `null` for every callback. Literal `\n`
   * sequences (from an environment variable) are turned into newlines.
   */
  publicKey?: string
  /**
   * Required: `'test'` or `'live'`. CHIP has one host and the secret key alone decides the mode, so this picks no host;
   * it is the guard that a test purchase can never mark a live order paid: a purchase whose `is_test` says otherwise is
   * refused (`MODE_MISMATCH`), and one that does not say (`MODE_UNKNOWN`) is refused too.
   */
  environment: 'test' | 'live'
  /** Restrict the payment page to these methods (values from `GET /payment_methods/`). Default: all enabled methods. */
  paymentMethods?: ChipPaymentMethod[]
  /** Override the base URL including `/api/v1` (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * OpenAPI `PurchaseStatus`. `error` and `blocked` are failed ATTEMPTS, not final states: the purchase can still be paid,
 * so they stay `pending`. `chargeback`, `pending_refund` and `refunded` (fully OR partially) mean money came and went
 * back: no normalised state fits, so they are `unknown` and never `paid`.
 */
export const STATUS: Record<string, PaymentStatus> = {
  created: 'pending',
  sent: 'pending',
  viewed: 'pending',
  overdue: 'pending',
  error: 'pending',
  blocked: 'pending',
  hold: 'pending',
  pending_execute: 'pending',
  pending_charge: 'pending',
  pending_capture: 'pending',
  pending_release: 'pending',
  preauthorized: 'pending',
  paid: 'paid',
  cleared: 'paid',
  settled: 'paid',
  cancelled: 'cancelled',
  released: 'cancelled',
  expired: 'expired',
  chargeback: 'unknown',
  pending_refund: 'unknown',
  refunded: 'unknown',
}

export const mapStatus = (status: unknown): PaymentStatus => STATUS[String(status)] ?? 'unknown'

export const info: GatewayInfo = {
  name: 'chip',
  // FPX B2C minimum RM1 (docs changelog 2026-07-30); DuitNow QR allows less, but one floor keeps every method usable.
  minimumAmount: 100,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source: 'CHIP Collect OpenAPI (docs.chip-in.asia/openapi/chip-collect.yaml)',
  },
}

/** True when the URL text spells out a port (`new URL()` would silently drop `:443`, so the text is checked). */
export function hasExplicitPort(url: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? ''
  const host = authority.slice(authority.lastIndexOf('@') + 1)
  return /:\d*$/.test(host.startsWith('[') ? host.slice(host.indexOf(']') + 1) : host)
}

/** Turn the body of `GET /public_key/` (a JSON-encoded PEM string) into a PEM. `null` for any other shape. */
export function decodePublicKey(body: string): string | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof value !== 'string' || !value.includes('-----BEGIN PUBLIC KEY-----')) return null
  return value
}

/** Verify CHIP's `X-Signature` over the raw body. Never throws. */
export function verifySignature(rawBody: string, signature: string, key: KeyObject): boolean {
  const sig = signature.trim()
  if (!sig || sig.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) return false
  try {
    return verify('sha256', Buffer.from(rawBody, 'utf8'), key, Buffer.from(sig, 'base64'))
  } catch {
    return false
  }
}

function rsaKey(pem: string): KeyObject {
  let key: KeyObject
  try {
    key = createPublicKey(pem.replace(/\\n/g, '\n'))
  } catch {
    throw new GatewayError('publicKey is not a PEM public key', 'chip', 0, 'INVALID_PUBLIC_KEY')
  }
  if (key.asymmetricKeyType !== 'rsa')
    throw new GatewayError('publicKey must be an RSA key', 'chip', 0, 'INVALID_PUBLIC_KEY')
  return key
}

/** First `{message, code}` anywhere in a CHIP error body (`__all__` is an array live, an object in the OpenAPI). */
function errorOf(json: unknown): { message: string; code?: string } | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  if (typeof o.message === 'string')
    return { message: o.message, ...(typeof o.code === 'string' ? { code: o.code } : {}) }
  for (const v of Object.values(o)) {
    const found = Array.isArray(v) ? v.map(errorOf).find(Boolean) : errorOf(v)
    if (found) return found
  }
  return null
}

const int = (v: unknown): number | undefined => (Number.isInteger(v) ? (v as number) : undefined)

export function chip(config: ChipConfig): Gateway & {
  /**
   * `GET /public_key/` with this secret key, JSON-decoded to a PEM. Store the result and pass it as `publicKey`;
   * fetching it on every callback is not needed.
   */
  fetchPublicKey(): Promise<string>
} {
  if (config.environment !== 'test' && config.environment !== 'live') {
    throw new GatewayError(
      "environment must be 'test' or 'live' (the guard against test payments)",
      'chip',
      0,
      'CONFIG',
    )
  }
  const base = (config.baseUrl ?? BASE_URL).replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const key = config.publicKey ? rsaKey(config.publicKey) : null
  const headers = {
    authorization: `Bearer ${config.secretKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
  }

  // Error text quotes the RESPONSE only; the secret key travels in a request header and never reaches a message.
  async function request(path: string, init: RequestInit) {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, 'chip', 0)
    }
    const text = await res.text().catch(() => '')
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { res, json, text }
  }

  function fail(what: string, r: { res: Response; json: unknown; text: string }): never {
    const e = errorOf(r.json)
    throw new GatewayError(
      e ? e.message.slice(0, 200) : `${what} HTTP ${r.res.status}`,
      'chip',
      r.res.status,
      e?.code,
    )
  }

  function checkMode(p: Record<string, unknown>) {
    if (typeof p.is_test !== 'boolean') {
      throw new GatewayError(
        'purchase does not say whether it is a test (is_test)',
        'chip',
        0,
        'MODE_UNKNOWN',
      )
    }
    if (p.is_test !== (config.environment === 'test')) {
      throw new GatewayError(
        `purchase is_test=${p.is_test} but environment is "${config.environment}"`,
        'chip',
        0,
        'MODE_MISMATCH',
      )
    }
  }

  return {
    info,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (!Number.isInteger(input.amount) || input.amount < info.minimumAmount) {
        throw new GatewayError(
          `amount must be integer sen ≥ ${info.minimumAmount}`,
          'chip',
          0,
          'INVALID_AMOUNT',
        )
      }
      if ((input.currency ?? 'MYR') !== 'MYR')
        throw new GatewayError('only MYR is supported', 'chip', 0, 'CURRENCY')
      const email = input.customer?.email?.trim() ?? ''
      // ClientDetails.email is the one required client field (OpenAPI).
      if (!email) throw new GatewayError('customer email is required', 'chip', 0, 'EMAIL_REQUIRED')
      if (!/^https?:\/\//i.test(input.callbackUrl)) {
        throw new GatewayError('callbackUrl must be http or https', 'chip', 0, 'webhooks_callback_scheme')
      }
      if (hasExplicitPort(input.callbackUrl)) {
        throw new GatewayError(
          'callbackUrl must not contain a port (CHIP rejects even :443)',
          'chip',
          0,
          'webhooks_callback_port',
        )
      }
      let due: number | undefined
      if (input.expiresAt) {
        due = Math.floor(input.expiresAt.getTime() / 1000)
        if (!Number.isFinite(due))
          throw new GatewayError('expiresAt is not a valid date', 'chip', 0, 'INVALID_DUE')
      }
      const name = input.customer?.name?.trim() ?? ''
      const body = {
        brand_id: config.brandId,
        client: { email, ...(name ? { full_name: name.slice(0, 1000) } : {}) },
        purchase: {
          currency: 'MYR',
          products: [{ name: input.description.trim().slice(0, 256) || 'Payment', price: input.amount }],
          ...(due !== undefined ? { due_strict: true } : {}),
        },
        reference: input.reference,
        // Top level only: nested inside `purchase` these are ignored silently.
        success_redirect: input.returnUrl,
        failure_redirect: input.returnUrl,
        success_callback: input.callbackUrl,
        ...(due !== undefined ? { due } : {}),
        ...(config.paymentMethods?.length ? { payment_method_whitelist: config.paymentMethods } : {}),
      }
      const r = await request('/purchases/', { method: 'POST', body: JSON.stringify(body) })
      const p = r.json as Record<string, unknown> | null
      if (r.res.status !== 201 || !p || typeof p.id !== 'string' || typeof p.checkout_url !== 'string') {
        fail('create purchase', r)
      }
      if (!/^https?:\/\//.test(p.checkout_url as string)) fail('create purchase', r)
      checkMode(p)
      return { id: p.id as string, url: p.checkout_url as string, raw: p }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(id))
        throw new GatewayError('invalid purchase id', 'chip', 0, 'INVALID_ID')
      const r = await request(`/purchases/${id}/`, { method: 'GET' })
      const p = r.json as Record<string, unknown> | null
      if (!r.res.ok || !p || typeof p !== 'object' || Array.isArray(p)) fail('purchase', r)
      checkMode(p)
      const details = (p.purchase ?? {}) as Record<string, unknown>
      const payment = (p.payment && typeof p.payment === 'object' ? p.payment : null) as Record<
        string,
        unknown
      > | null
      // What was actually received once paid (`payment.amount` = net + fee + pending); before that, what is charged.
      const amount = int(payment?.amount) ?? int(details.total) ?? Number.NaN
      const paidOn = int(payment?.paid_on)
      const fee = payment ? (int(payment.fee_amount) ?? null) : undefined
      return {
        id: String(p.id ?? id),
        reference: typeof p.reference === 'string' ? p.reference : '',
        status: mapStatus(p.status),
        amount,
        currency: String(payment?.currency ?? details.currency ?? ''),
        ...(paidOn !== undefined ? { paidAt: new Date(paidOn * 1000) } : {}),
        ...(fee !== undefined ? { fee } : {}),
        raw: p,
      }
    },

    verifyCallback({ rawBody, headers: h }: CallbackInput): VerifiedCallback | null {
      if (!key || typeof rawBody !== 'string' || !rawBody) return null
      const signature = h?.['x-signature']
      if (typeof signature !== 'string' || !verifySignature(rawBody, signature, key)) return null
      let body: unknown
      try {
        body = JSON.parse(rawBody)
      } catch {
        return null
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null
      const p = body as Record<string, unknown>
      if (typeof p.id !== 'string' || !p.id) return null
      const raw: Record<string, string> = {}
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') raw[k] = String(v)
      }
      return {
        id: p.id,
        reference: typeof p.reference === 'string' ? p.reference : '',
        claimedStatus: mapStatus(p.status),
        raw,
      }
    },

    async fetchPublicKey() {
      const r = await request('/public_key/', { method: 'GET' })
      if (!r.res.ok) fail('public key', r)
      const pem = decodePublicKey(r.text)
      if (!pem)
        throw new GatewayError('public key response is not a JSON-encoded PEM string', 'chip', r.res.status)
      rsaKey(pem)
      return pem
    },
  }
}
