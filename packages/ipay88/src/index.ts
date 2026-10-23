/**
 * iPay88 Malaysia adapter (Online Payment Switching Gateway, now NTT DATA Payment Services Malaysia / ADAPTIS
 * e-Commerce).
 *
 * iPay88 publishes NO developer documentation: the Technical Specification is handed to merchants by support. This
 * adapter is written from the official public artefacts on the gateway host only, read 23 October 2026
 * (`gateways/ipay88/spec.md`, a source next to every fact): the Signature Testing tool
 * (payment.ipay88.com.my/epayment/testing/TestSignatureIpay88.asp), the gateway's own HMAC helper
 * (/epayment/Security/hmac-sha512.js), the legacy SHA-256 / SHA-1 tools, and live probes of /epayment/enquiry.asp.
 * Everything else rests on "OPSG Technical Specification 1.6.4.4" (iPay88-authored, but the only copy found is in a
 * third-party repository) and is marked UNCONFIRMED below. NOT measured: no sandbox is documented.
 *
 * - Signature = lowercase hex HMAC-SHA512 keyed with the MerchantKey (UTF-8), where the MerchantKey is ALSO the start
 *   of the message: request `MerchantKey+MerchantCode+RefNo+Amount+Currency`, response/callback
 *   `MerchantKey+MerchantCode+PaymentId+RefNo+Amount+Currency+Status`, no separators, Amount with "." and ","
 *   removed (`1,278.99` → `127899`). The official tool's three HMAC vectors are reproduced in the tests. The response
 *   formula is UNCONFIRMED (SPEC only); its vector V3 was reproduced with the gateway's own JS.
 * - Amount stripping (C2): the SPEC says remove "." and ","; the official tool uses JS `.replace(".", "")
 *   .replace(",", "")`, which removes only the FIRST of each (`1,000,000.00` → `1000,00000`). This adapter removes ALL
 *   of them (`100000000`). It never sends a thousands separator, so its own requests sign the same under both readings;
 *   a callback of RM1,000,000.00 or more (two commas) signed the tool's way would fail verification (refused, never
 *   accepted).
 * - Amounts are ringgit with two decimals at iPay88 (`10.50`); this adapter converts sen ↔ ringgit at the edge only.
 * - `createPayment` makes NO request: iPay88 starts a payment with a browser form POST to `entry.asp` (SPEC; a GET is
 *   undocumented). It returns `url` (the form action) plus `form` (method, action, fields) and `html` (a page that
 *   posts the form). Serve `html`, or render `form`; redirecting to `url` alone shows an iPay88 error page.
 * - Payment ids: iPay88 has no id before the customer pays and its re-query needs RefNo AND Amount, so the id is
 *   `<RefNo>:<amount in sen>`, built the same way from a verified callback.
 * - `getPayment` = `POST enquiry.asp` (`MerchantCode`, `RefNo`, `Amount`). It answers a bare `text/html` body with
 *   HTTP 200 for every outcome (live). Only the exact text `00` is `paid`; `Payment fail` and `M88Admin` are
 *   `failed`; `Record not found` is `pending` (the customer may not have submitted the form yet); `Incorrect amount`
 *   and anything else are `unknown` (never paid); `Invalid parameters` throws. `Record not found` / `Invalid
 *   parameters` are confirmed live, the other values are UNCONFIRMED (SPEC only).
 * - The enquiry reply carries no reference, amount or currency, so the record reports the RefNo and amount that were
 *   asked (from a signed callback) and MYR: `00` means iPay88 has a paid record for that RefNo at that amount, because
 *   a different amount answers `Incorrect amount` (UNCONFIRMED, SPEC only). A callback whose Currency is not MYR is
 *   refused, since only MYR payments are created.
 * - Callbacks: form POSTs to ResponseURL (browser) and BackendURL (server). `verifyCallback` checks the Signature over
 *   the posted FIELDS (iPay88 signs values, not bytes), in constant time, requires your MerchantCode, and returns null
 *   for anything else. The backend page must answer exactly `RECEIVEOK` (export `BACKEND_ACK`, see `backendAck()`),
 *   or iPay88 retries (up to 3 times, SPEC only).
 *
 * Where the sources are silent or contradict each other (UNCONFIRMED in the spec), the safe choice:
 * - minimum amount: none published (test with MYR 1.00 only); `minimumAmount` is 100 sen;
 * - Xfield1 (C1): the SPEC signs it in the request, the official tool does not. It is always sent EMPTY, where both
 *   agree; `requestSignature` takes it for the SPEC's vector only;
 * - algorithm (C3): only `HMACSHA512` is sent and accepted; a callback signed with the legacy SHA-256 or SHA-1 schemes,
 *   or with iPay88 Indonesia's `||`-separated SHA-256 (C7), is refused;
 * - callback status: `1` → paid, `0` → failed, `6` → pending (SOAP re-query codes, SPEC only), anything else
 *   (including `20` authorised) → unknown. A callback without a Signature (iPay88 omits it "when the transaction is
 *   in error", SPEC only) is refused;
 * - the SOAP re-query (`TxDetailsInquiryCardInfo`) is NOT used: how its `Signature` is computed is undocumented (C4),
 *   it names the RefNo `ReferenceNo` (C6) and its paid-time format is unclear (C5). No `paidAt` is reported (enquiry
 *   gives none) and no fee (`null`);
 * - the Amount sent to enquiry.asp has two decimals and no thousands separator (whether it accepts `1,278.99` is
 *   UNCONFIRMED);
 * - references: 1–30 characters of A–Z, a–z, 0–9, `.`, `_`, `-` (the SPEC gives the length only). A RefNo that was
 *   paid cannot be reused ("Duplicate reference number"); a failed one may be retried;
 * - customer: name and email are required (SPEC: UserName and UserEmail mandatory, ≤100 characters; an over-long email
 *   is refused, not cut). UserContact is also mandatory in the SPEC: without `customer.phone` it is sent EMPTY
 *   (UNCONFIRMED whether entry.asp accepts that — pass a phone). ProdDesc and UserName are cut to 100 characters;
 *   ResponseURL / BackendURL over 200 characters are refused;
 * - optional fields (PaymentId, Remark, Lang, Optional, Appdeeplink, Xfield1) are sent empty except `Lang` = `UTF-8`
 *   (the signature is computed over UTF-8); "the parameter must exist" (SPEC legend);
 * - the sandbox host (`sandbox.ipay88.com.my`) answers but is undocumented: `environment: 'sandbox'` targets it with
 *   no guarantee. The SPEC says to test on production with MYR 1.00 from the Request URL registered with iPay88;
 * - `expiresAt` and `idempotencyKey` have no iPay88 equivalent (no expiry is published) and are ignored; the RefNo is
 *   the only dedupe handle. The SPEC's HTTP_REFERER check on the response page is not done: `confirmPayment` asking
 *   iPay88 again is the protection;
 * - errors quote the enquiry reply only; the MerchantKey never reaches a message.
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
  type VerifiedCallback,
} from '@bayarkit/core'

export const HOSTS = {
  production: 'https://payment.ipay88.com.my/epayment',
  /** UNCONFIRMED: answers, but no public material documents it. */
  sandbox: 'https://sandbox.ipay88.com.my/epayment',
} as const

/** What the BackendURL page must answer, exactly (no HTML), or iPay88 retries the notification. */
export const BACKEND_ACK = 'RECEIVEOK'

export interface IPay88Config {
  /** Merchant Code from iPay88 (public; posted in the form). */
  merchantCode: string
  /** Merchant Key from iPay88: the HMAC key. Never sent anywhere. */
  merchantKey: string
  environment: keyof typeof HOSTS
  /** Override the host, up to and including `/epayment` (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface IPay88Form {
  method: 'POST'
  action: string
  fields: Record<string, string>
}

export interface IPay88Payment extends CreatedPayment {
  /** The browser form that starts the payment. iPay88 takes a POST, not a redirect. */
  form: IPay88Form
  /** A small HTML page that posts `form` (with a visible button when scripts are blocked). Serve it as the response. */
  html: string
}

export interface IPay88Gateway extends Gateway {
  createPayment(input: CreatePaymentInput): Promise<IPay88Payment>
}

const NAME = 'ipay88'
const REFERENCE = /^[A-Za-z0-9._-]{1,30}$/
/** RefNo as it may come back in a callback: 1–30 printable characters. */
const REFNO_BACK = /^[^\s\p{Cc}]{1,30}$/u
const AMOUNT = /^(\d{1,3}(,\d{3})+|\d+)\.\d{2}$/
const SIGNATURE = /^[0-9a-f]{128}$/

export const info: GatewayInfo = {
  name: NAME,
  // UNCONFIRMED: no minimum is published (the SPEC only says to test with MYR 1.00); 100 sen until measured.
  minimumAmount: 100,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source:
      'payment.ipay88.com.my/epayment/testing/TestSignatureIpay88.asp + Security/hmac-sha512.js + enquiry.asp (live)',
  },
}

/** Remove EVERY "." and "," (`1,000,000.00` → `100000000`). The official tool removes only the first of each (C2). */
export function amountForSignature(amount: string): string {
  return amount.replaceAll('.', '').replaceAll(',', '')
}

/** Lowercase hex HMAC-SHA512 of `message` keyed with the MerchantKey (both UTF-8). */
export function hmacSha512(merchantKey: string, message: string): string {
  return createHmac('sha512', merchantKey).update(message, 'utf8').digest('hex')
}

/**
 * The request string: `MerchantKey+MerchantCode+RefNo+Amount+Currency`, plus `Xfield1` per the SPEC (C1; the official
 * tool leaves it out, and the two agree when it is empty, which is all this adapter sends).
 */
export function requestSigningString(p: {
  merchantKey: string
  merchantCode: string
  refNo: string
  amount: string
  currency: string
  xfield1?: string
}): string {
  return `${p.merchantKey}${p.merchantCode}${p.refNo}${amountForSignature(p.amount)}${p.currency}${p.xfield1 ?? ''}`
}

/** The response/callback string: `MerchantKey+MerchantCode+PaymentId+RefNo+Amount+Currency+Status`. */
export function responseSigningString(p: {
  merchantKey: string
  merchantCode: string
  paymentId: string
  refNo: string
  amount: string
  currency: string
  status: string
}): string {
  return `${p.merchantKey}${p.merchantCode}${p.paymentId}${p.refNo}${amountForSignature(p.amount)}${p.currency}${p.status}`
}

export function requestSignature(p: Parameters<typeof requestSigningString>[0]): string {
  return hmacSha512(p.merchantKey, requestSigningString(p))
}

export function responseSignature(p: Parameters<typeof responseSigningString>[0]): string {
  return hmacSha512(p.merchantKey, responseSigningString(p))
}

/** iPay88 ringgit (`1,278.99` or `1278.99`) → integer sen; NaN for anything else. */
export function senOf(amount: string): number {
  if (!AMOUNT.test(amount)) return Number.NaN
  const sen = Number(amountForSignature(amount))
  return Number.isSafeInteger(sen) ? sen : Number.NaN
}

/** `<RefNo>:<sen>` → parts, or null. */
export function parsePaymentId(id: unknown): { refNo: string; amount: number } | null {
  if (typeof id !== 'string') return null
  const at = id.lastIndexOf(':')
  const refNo = id.slice(0, at)
  const sen = id.slice(at + 1)
  if (at < 1 || !REFNO_BACK.test(refNo) || !/^\d{1,15}$/.test(sen)) return null
  return { refNo, amount: Number(sen) }
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )

/** A page that posts `form` to iPay88; `label` is the visible button for browsers that block the script. */
export function autoPostHtml(form: IPay88Form, label = 'Continue to payment'): string {
  const inputs = Object.entries(form.fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>iPay88</title></head><body><form id="ipay88" method="post" action="${escapeHtml(form.action)}" accept-charset="UTF-8">${inputs}<button type="submit">${escapeHtml(label)}</button></form><script>document.getElementById('ipay88').submit()</script></body></html>`
}

/** The response the BackendURL page must give. */
export function backendAck(): Response {
  return new Response(BACKEND_ACK, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

function enquiryStatus(answer: string): PaymentStatus {
  switch (answer) {
    case '00':
      return 'paid'
    case 'Payment fail':
    case 'M88Admin':
      return 'failed'
    case 'Record not found':
      return 'pending'
    default:
      return 'unknown'
  }
}

function callbackStatus(status: string): PaymentStatus {
  if (status === '1') return 'paid'
  if (status === '0') return 'failed'
  if (status === '6') return 'pending'
  return 'unknown'
}

const chars = (text: string, max: number) => [...text].slice(0, max).join('')

export function ipay88(config: IPay88Config): IPay88Gateway {
  const base = (config.baseUrl ?? HOSTS[config.environment] ?? '').replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  if (!config.merchantCode || !config.merchantKey || !base) {
    throw new GatewayError('merchantCode, merchantKey and environment are required', NAME, 0, 'CONFIG')
  }

  return {
    info,

    async createPayment(input: CreatePaymentInput): Promise<IPay88Payment> {
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
      // Sent as given: trimming or cutting it would make confirmPayment's reference check fail later.
      const reference = input.reference
      if (typeof reference !== 'string' || !REFERENCE.test(reference)) {
        throw new GatewayError(
          'reference must be 1–30 characters of A–Z, a–z, 0–9, ".", "_" and "-"',
          NAME,
          0,
          'INVALID_REFERENCE',
        )
      }
      const name = chars(input.customer?.name?.trim() ?? '', 100)
      const email = input.customer?.email?.trim() ?? ''
      if (!name || !email || [...email].length > 100) {
        throw new GatewayError(
          'customer name and email (at most 100 characters) are required',
          NAME,
          0,
          'CUSTOMER_REQUIRED',
        )
      }
      const phone = (input.customer?.phone ?? '').replace(/[\s()-]/g, '')
      for (const url of [input.returnUrl, input.callbackUrl]) {
        if (!/^https?:\/\//.test(url ?? '') || url.length > 200) {
          throw new GatewayError(
            'returnUrl and callbackUrl must be http(s) URLs of at most 200 characters',
            NAME,
            0,
            'URL',
          )
        }
      }
      const amount = toRinggit(input.amount)
      const fields: Record<string, string> = {
        MerchantCode: config.merchantCode,
        PaymentId: '',
        RefNo: reference,
        Amount: amount,
        Currency: 'MYR',
        ProdDesc: chars(input.description.trim(), 100) || reference,
        UserName: name,
        UserEmail: email,
        UserContact: /^\+?\d{1,20}$/.test(phone) && phone.length <= 20 ? phone : '',
        Remark: '',
        Lang: 'UTF-8',
        SignatureType: 'HMACSHA512',
        Signature: requestSignature({
          merchantKey: config.merchantKey,
          merchantCode: config.merchantCode,
          refNo: reference,
          amount,
          currency: 'MYR',
        }),
        ResponseURL: input.returnUrl,
        BackendURL: input.callbackUrl,
        Optional: '',
        Appdeeplink: '',
        Xfield1: '',
      }
      const form: IPay88Form = { method: 'POST', action: `${base}/entry.asp`, fields }
      return {
        id: `${reference}:${input.amount}`,
        url: form.action,
        form,
        html: autoPostHtml(form),
        raw: { form },
      }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      const parsed = parsePaymentId(id)
      if (!parsed)
        throw new GatewayError('invalid payment id (expected <RefNo>:<sen>)', NAME, 0, 'INVALID_ID')
      const query = {
        MerchantCode: config.merchantCode,
        RefNo: parsed.refNo,
        Amount: toRinggit(parsed.amount),
      }
      let res: Response
      try {
        res = await doFetch(`${base}/enquiry.asp`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(query).toString(),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, NAME, 0)
      }
      const answer = (await res.text().catch(() => '')).trim()
      if (!res.ok) {
        throw new GatewayError(`enquiry HTTP ${res.status}: ${answer.slice(0, 200)}`, NAME, res.status)
      }
      if (answer === 'Invalid parameters') {
        throw new GatewayError(`enquiry: ${answer}`, NAME, res.status, answer)
      }
      return {
        id,
        reference: parsed.refNo,
        status: enquiryStatus(answer),
        amount: parsed.amount,
        currency: 'MYR',
        // enquiry.asp reports no fee and no paid-at time.
        fee: null,
        raw: { ...query, answer: answer.slice(0, 500) },
      }
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        const f = cb?.fields ?? {}
        const s = (k: string) => (typeof f[k] === 'string' ? f[k] : '')
        const given = s('Signature').toLowerCase()
        const refNo = s('RefNo')
        const amount = s('Amount')
        const sen = senOf(amount)
        if (
          !SIGNATURE.test(given) ||
          s('MerchantCode') !== config.merchantCode ||
          !REFNO_BACK.test(refNo) ||
          !Number.isFinite(sen) ||
          s('Currency') !== 'MYR'
        )
          return null
        const expected = responseSignature({
          merchantKey: config.merchantKey,
          merchantCode: s('MerchantCode'),
          paymentId: s('PaymentId'),
          refNo,
          amount,
          currency: s('Currency'),
          status: s('Status'),
        })
        if (!timingSafeEqualText(expected, given)) return null
        return {
          id: `${refNo}:${sen}`,
          reference: refNo,
          claimedStatus: callbackStatus(s('Status')),
          raw: { ...f },
        }
      } catch {
        return null
      }
    },
  }
}
