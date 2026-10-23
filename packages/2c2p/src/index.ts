/**
 * 2C2P adapter: PGW Payment API v4.x, Redirect (hosted payment page) through the Payment Token API.
 *
 * Written from the official documentation only (developer.2c2p.com `.md` exports and recipes, read 23 October 2026);
 * every fact has its source in gateways/2c2p/spec.md. NOT yet measured against the sandbox (sandbox-pgw.2c2p.com):
 * where the sandbox differs from the docs, this adapter will be wrong until someone runs the conformance suite there.
 *
 * - Requests and responses are `{"payload":"<JWT>"}`: HS256 over `base64url(header).base64url(claims)`, keyed with the
 *   merchant Secret Key's hex STRING as ASCII bytes. It is NOT hex-decoded: the official vectors only verify that way
 *   (spec §1, §4c TV1–TV3; all three are reproduced in the tests). Implemented with node:crypto, no JWT library.
 * - Only `alg: "HS256"` is accepted (`none`, other algorithms and a `crit` header are refused), the signature must be
 *   the exact canonical base64url text, and it is compared in constant time.
 * - Amounts are decimal MAJOR units at 2C2P (`2500.90000`, D(12,5)), integer sen here: `sen / 100` is sent as a JSON
 *   number (2C2P's own sample serialises `1000.00` as `1000`), and answers (number or string, see C6) are parsed as
 *   decimal text, never through floating-point rounding.
 * - The backend notification (JSON `{"payload": JWT}` posted to backendReturnUrl) is the only signed callback. The
 *   signature covers the JWT segments, not the HTTP body bytes, so the JWT is taken from the raw body (or from a
 *   framework-parsed `payload` field) and verified as received; its claims are never re-encoded.
 * - The frontend return (`paymentResponse=<base64 JSON>` form POST to frontendReturnUrl) is UNSIGNED: verifyCallback
 *   always refuses it. Its respCode `2000` only means "do a payment inquiry".
 * - The id passed to getPayment is the `invoiceNo` (= your reference): the notification carries no paymentToken, and
 *   Payment Inquiry accepts `invoiceNo`. invoiceNo must be unique at 2C2P, so a reference can be paid for only once.
 * - Only respCode `0000` is ever `paid`.
 *
 * Contradictions in the official material (spec §9) and what this adapter does:
 * - C1/C2: the official WooCommerce plugin uses the LEGACY RedirectV3 form API (`hash_value` HMAC over concatenated
 *   fields, 12-digit zero-padded minor units). Not ported: this adapter speaks the documented v4 JWT API only, and a
 *   legacy-style callback is refused.
 * - C3: refunds/voids use a separate API with JWE/JWS PS256 keys. Not implemented.
 * - C4: API version 4.3 (OpenAPI, sandbox setup) vs 4.5 (Payment Token / Inquiry pages); both answer on the sandbox.
 *   Default `4.3` (the OpenAPI contract), `apiVersion: '4.5'` switches.
 * - C5: the "process response" recipe verifies a token with the JT01 key that was signed with JT04; the tests pin the
 *   correct key per vector.
 * - C6: the notification sample has `amount` as a STRING ("230.87") and `cardNo` instead of `accountNo`; amounts are
 *   read from numbers and strings alike, and no card field is used.
 * - C7: `transactionDateTime` has 12 or 14 digits depending on the page and no documented timezone: `paidAt` is never
 *   set (no invented timestamps).
 * - C9: the official agent-skills give invented response codes; the dev-docs table is used (2001 = in progress,
 *   2002 = not found, duplicate = 5005/9015).
 * - C10: the token is valid 30 minutes while `paymentExpiry` defaults to 20; see `expiresAt` below.
 *
 * Choices made where the docs are silent (UNCONFIRMED in the spec), each the safe option:
 * - minimum amount: no documented minimum (the plugin only rejects `<= 0`); `minimumAmount` is 100 sen (RM1.00) until
 *   measured. The maximum follows D(12,5): 7 integer digits, 999 999 999 sen;
 * - error responses: our sandbox probe got a PLAIN (unsigned) `{"respCode","respDesc"}`, and whether errors are ever
 *   signed is undocumented. Such answers only ever become a GatewayError quoting respCode/respDesc, never a payment
 *   state; a `payload` whose signature does not verify is refused, never trusted;
 * - Payment Inquiry for a token with no payment attempt: undocumented. `2002` (not found) reads as `pending` with an
 *   empty reference (never paid); an answer without `invoiceNo` for any other code is a GatewayError;
 * - response codes other than the explicit lists in `statusOf` (including `4110` settled and `4120` refunded, whose
 *   appearance in an inquiry is undocumented) read as `unknown`, never `paid`;
 * - `merchantID` in a notification or inquiry answer must equal yours when present (the samples always carry it);
 * - `expiresAt`: the timezone of `paymentExpiry` is undocumented, so it is never sent; 2C2P's documented default
 *   (20 minutes) applies. An `expiresAt` less than 20 minutes away is refused, because this adapter could not keep
 *   it; a later one is honoured early (the page expires at 20 minutes), never late;
 * - `invoiceNo` is AN 50 (max 20 for QR): references must be 1–50 letters and digits, refused otherwise rather than
 *   rewritten (confirmPayment compares them exactly);
 * - `idempotencyKey` is sent as `idempotencyID` (C 100); what 2C2P does with the same key and a different body is
 *   undocumented, so keep one key per order;
 * - notification retries, the expected HTTP reply and source IPs are undocumented: answer 200 (official skill) and
 *   make "mark paid" idempotent; there is no timestamp in the JWT, so replays are stopped by confirmPayment's fresh
 *   inquiry, not by the signature;
 * - customer details are not sent (`uiParams` is not specified field by field); `description` is HTML-encoded as the
 *   docs require and cut to 250 characters.
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

export const HOSTS = {
  sandbox: 'https://sandbox-pgw.2c2p.com',
  production: 'https://pgw.2c2p.com',
} as const

export interface TwoC2PConfig {
  /** Merchant ID from the 2C2P merchant portal (e.g. the public Malaysian demo merchant `JT07`). */
  merchantId: string
  /** The merchant Secret Key ("SHA Key"), the hex string exactly as the portal shows it. */
  secretKey: string
  environment: keyof typeof HOSTS
  /** Path version: `4.3` (OpenAPI, default) or `4.5` (Payment Token page). Both answer on the sandbox. */
  apiVersion?: '4.3' | '4.5'
  /** `paymentChannel`, e.g. `['CC', 'APM']`. Default: not sent (every channel enabled on the account). */
  paymentChannels?: string[]
  /** Override the host (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const NAME = '2c2p'
const INVOICE = /^[A-Za-z0-9]{1,50}$/
const B64URL = /^[A-Za-z0-9_-]+$/
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/
const MAXIMUM_SEN = 999_999_999
const DEFAULT_EXPIRY_MS = 20 * 60_000

export const info: GatewayInfo = {
  name: NAME,
  // UNCONFIRMED: no documented minimum; 100 sen until measured, as for the other adapters.
  minimumAmount: 100,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source:
      'developer.2c2p.com (PGW Payment API v4.x: Payment Token, Payment Inquiry, Backend response, JWT guide)',
  },
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')

/** HMAC-SHA256 over `<header>.<claims>`, keyed with the secret key's TEXT (ASCII bytes, not hex-decoded). */
const mac = (secretKey: string, signingInput: string) =>
  createHmac('sha256', Buffer.from(secretKey, 'utf8')).update(signingInput, 'utf8').digest('base64url')

/** HS256 JWT as 2C2P expects it: `{"alg":"HS256","typ":"JWT"}`, compact JSON claims, base64url without padding. */
export function signJwt(claims: Record<string, unknown>, secretKey: string): string {
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  return `${HEADER}.${body}.${mac(secretKey, `${HEADER}.${body}`)}`
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function decodeJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

/**
 * Verify an HS256 JWT exactly as received and return its claims, or `null`. Refuses any `alg` other than HS256, a
 * `crit` header, a non-canonical signature, and claims that are not a JSON object. Never throws.
 */
export function verifyJwt(token: unknown, secretKey: string): Record<string, unknown> | null {
  try {
    if (typeof token !== 'string' || !secretKey || token.length > 100_000) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [head = '', body = '', signature = ''] = parts
    if (!B64URL.test(head) || !B64URL.test(body) || !SIGNATURE.test(signature)) return null
    const header = decodeJson(head)
    if (!isObject(header) || header.alg !== 'HS256' || 'crit' in header) return null
    if (!timingSafeEqualText(mac(secretKey, `${head}.${body}`), signature)) return null
    const claims = decodeJson(body)
    return isObject(claims) ? claims : null
  } catch {
    return null
  }
}

/** Integer sen → 2C2P's decimal major units, as a JSON number (1050 → 10.5, serialised `10.5`). */
export function toAmount(sen: number): number {
  if (!Number.isInteger(sen) || sen < 0 || sen > MAXIMUM_SEN) {
    throw new RangeError(`amount must be integer sen from 0 to ${MAXIMUM_SEN}, got ${sen}`)
  }
  // sen / 100 is the double nearest the exact decimal, so its shortest text has at most two decimals.
  return sen / 100
}

/**
 * 2C2P's decimal amount (a JSON number like `1000` or a string like `"230.87"` / `"2500.90000"`) → integer sen, read
 * as decimal TEXT. Digits below one sen must be zero: `"10.005"` is `NaN`, not rounded, so it can never match an
 * order. Negative, exponent and empty forms are `NaN` too.
 */
export function parseAmount(value: unknown): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  const m = /^(\d{1,15})(?:\.(\d{1,5}))?$/.exec(text)
  if (!m) return Number.NaN
  const frac = (m[2] ?? '').padEnd(5, '0')
  if (/[1-9]/.test(frac.slice(2))) return Number.NaN
  const sen = Number(m[1]) * 100 + Number(frac.slice(0, 2))
  return Number.isSafeInteger(sen) ? sen : Number.NaN
}

const PENDING = new Set(['0001', '0004', '2001', '2002', '4009'])
const CANCELLED = new Set(['0003', '4080'])
const EXPIRED = new Set(['5009', '5017', '9020'])
/** 4xxx codes that are not a plain decline (approvals, settlement, refund, chargeback…) read as unknown. */
const NOT_A_DECLINE = new Set(['4000', '4008', '4010', '4011', '4016', '4045', '4047'])

/** Payment Response Code → bayarkit status (spec §3). Only `0000` is paid. */
export function statusOf(respCode: unknown): PaymentStatus {
  const code = typeof respCode === 'string' ? respCode : ''
  if (code === '0000') return 'paid'
  if (PENDING.has(code)) return 'pending'
  if (CANCELLED.has(code)) return 'cancelled'
  if (EXPIRED.has(code)) return 'expired'
  if (code === '2003' || code === '9035') return 'failed'
  if (/^40[0-9]{2}$/.test(code) && !NOT_A_DECLINE.has(code)) return 'failed'
  return 'unknown'
}

const HTML: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** HTML-encode (the docs require it for `description`) and cut to 250 characters without splitting an entity. */
export function descriptionOf(text: string): string {
  let out = ''
  for (const ch of text.trim()) {
    const enc = HTML[ch] ?? ch
    if ([...out].length + [...enc].length > 250) break
    out += enc
  }
  return out || 'Payment'
}

/** Only flat values; nested objects are dropped from `raw`. */
function flat(claims: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(claims)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  }
  return out
}

const quote = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : '')

export function twoc2p(config: TwoC2PConfig): Gateway {
  const base = (config.baseUrl ?? HOSTS[config.environment]).replace(/\/+$/, '')
  const version = config.apiVersion ?? '4.3'
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000

  /** POST `{"payload": JWT}` and return the VERIFIED claims of the answer; anything else is a GatewayError. */
  async function call(what: string, endpoint: string, claims: Record<string, unknown>) {
    let res: Response
    try {
      res = await doFetch(`${base}/payment/${version}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ payload: signJwt(claims, config.secretKey) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, NAME, 0)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (typeof json?.payload !== 'string') {
      // Plain (unsigned) error, as the sandbox probe answered. Quoted, never read as a payment state.
      const code = quote(json?.respCode)
      const desc = quote(json?.respDesc)
      throw new GatewayError(
        `${what} HTTP ${res.status}${code ? `: ${code}` : ''}${desc ? ` ${desc}` : ''}`,
        NAME,
        res.status,
        code || undefined,
      )
    }
    const answer = verifyJwt(json.payload, config.secretKey)
    if (!answer) {
      throw new GatewayError(
        `${what}: response signature did not verify (wrong secret key, or another merchant's?)`,
        NAME,
        res.status,
        'BAD_SIGNATURE',
      )
    }
    if (typeof answer.merchantID === 'string' && answer.merchantID !== config.merchantId) {
      throw new GatewayError(`${what}: answer is for another merchant`, NAME, res.status, 'MERCHANT')
    }
    return { res, answer }
  }

  const fail = (what: string, status: number, answer: Record<string, unknown>): never => {
    const code = quote(answer.respCode)
    throw new GatewayError(
      `${what}: ${code || 'no respCode'}${answer.respDesc ? ` ${quote(answer.respDesc)}` : ''}`,
      NAME,
      status,
      code || undefined,
    )
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
      if (!INVOICE.test(input.reference)) {
        throw new GatewayError(
          'reference must be 1–50 letters and digits (2C2P invoiceNo)',
          NAME,
          0,
          'INVALID_REFERENCE',
        )
      }
      if (input.expiresAt && input.expiresAt.getTime() - Date.now() < DEFAULT_EXPIRY_MS) {
        throw new GatewayError(
          'expiresAt under 20 minutes cannot be kept: the paymentExpiry timezone is undocumented, so only the 20-minute default is used',
          NAME,
          0,
          'INVALID_EXPIRY',
        )
      }
      if (
        input.idempotencyKey !== undefined &&
        (!input.idempotencyKey || input.idempotencyKey.length > 100)
      ) {
        throw new GatewayError('idempotencyKey must be 1–100 characters', NAME, 0, 'INVALID_KEY')
      }
      const claims: Record<string, unknown> = {
        merchantID: config.merchantId,
        invoiceNo: input.reference,
        description: descriptionOf(input.description),
        amount: toAmount(input.amount),
        currencyCode: 'MYR',
        frontendReturnUrl: input.returnUrl,
        backendReturnUrl: input.callbackUrl,
        ...(config.paymentChannels?.length ? { paymentChannel: config.paymentChannels } : {}),
        ...(input.idempotencyKey ? { idempotencyID: input.idempotencyKey } : {}),
      }
      const { res, answer } = await call('payment token', 'paymentToken', claims)
      const url = answer.webPaymentUrl
      if (
        answer.respCode !== '0000' ||
        typeof answer.paymentToken !== 'string' ||
        !answer.paymentToken ||
        typeof url !== 'string' ||
        !/^https?:\/\//.test(url)
      ) {
        fail('payment token', res.status, answer)
      }
      return { id: input.reference, url: url as string, raw: answer }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      if (!INVOICE.test(id)) throw new GatewayError('invalid invoiceNo', NAME, 0, 'INVALID_ID')
      const { res, answer } = await call('payment inquiry', 'paymentInquiry', {
        merchantID: config.merchantId,
        invoiceNo: id,
      })
      if (answer.respCode === '2002' && answer.invoiceNo === undefined) {
        // Not found: no payment attempt yet (UNCONFIRMED). Never paid; the gateway named no reference.
        return {
          id,
          reference: '',
          status: 'pending',
          amount: Number.NaN,
          currency: '',
          fee: null,
          raw: answer,
        }
      }
      if (typeof answer.invoiceNo !== 'string') fail('payment inquiry', res.status, answer)
      return {
        id,
        reference: answer.invoiceNo as string,
        status: statusOf(answer.respCode),
        amount: parseAmount(answer.amount),
        currency: typeof answer.currencyCode === 'string' ? answer.currencyCode.toUpperCase() : '',
        // The inquiry reports no fee; transactionDateTime has no documented timezone, so no paidAt (C7).
        fee: null,
        raw: answer,
      }
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        let token: unknown
        const rawBody = typeof cb?.rawBody === 'string' ? cb.rawBody : ''
        if (rawBody) {
          const body = JSON.parse(rawBody) as unknown
          token = isObject(body) ? body.payload : undefined
        } else {
          token = cb?.fields?.payload
        }
        const claims = verifyJwt(token, config.secretKey)
        if (!claims) return null
        const invoiceNo = claims.invoiceNo
        if (typeof invoiceNo !== 'string' || !INVOICE.test(invoiceNo)) return null
        if (claims.merchantID !== undefined && claims.merchantID !== config.merchantId) return null
        return {
          id: invoiceNo,
          reference: invoiceNo,
          claimedStatus: statusOf(claims.respCode),
          raw: flat(claims),
        }
      } catch {
        return null
      }
    },
  }
}
