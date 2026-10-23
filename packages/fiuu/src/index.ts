/**
 * Fiuu adapter (formerly Razer Merchant Services / MOLPay): hosted payment page + requery.
 *
 * Written from the official material only, read 23 October 2026 (`gateways/fiuu/spec.md`, a source next to every
 * fact): the API spec PDF v13.97 (FiuuPayment/Documentation-Fiuu_API_Spec, "SPEC pN"), the official WooCommerce plugin,
 * PHP SDK and cheatsheet. NOT yet measured against the sandbox: where the sandbox differs from the docs, this adapter
 * will be wrong until someone runs the conformance suite with sandbox keys.
 *
 * - Credentials: Merchant ID (`domain`), Verify Key (signs requests: `vcode`, requery `skey`), Secret Key (verifies
 *   what Fiuu sends: payment `skey`, requery `VrfKey`). No token, no OAuth: MD5 hashes only (SPEC p18).
 * - `createPayment` makes NO server call: Fiuu has no create API (SPEC p12, p45). It builds the hosted-page URL
 *   `{pay host}/RMS/pay/{merchantID}/?…` (GET, which SPEC p40 allows) with
 *   `vcode = md5(amount.merchantID.orderid.verify_key)`, or `…verify_key.currency` with `extendedVcode: true` (the
 *   portal option "Use extended format for Verify Payment"; the official PHP SDK always omits the currency, C13). The
 *   amount string in the hash is the one sent (`toRinggit`: always two decimals, never a comma).
 * - Payment ids: Fiuu's own id (`tranID`) first appears in the result, and every requery hashes the AMOUNT. So the id is
 *   `<orderid>:<amount>` from `createPayment` and `<orderid>:<amount>:<tranID>` from a callback; all parts come from
 *   your input or from signed callback fields. `getPayment` asks q_by_tid (exact transaction, 180 days) when the id
 *   has a tranID, else q_by_oid (7 days; the oID "might be duplicated" and which attempt it returns is not stated).
 * - Callbacks (return URL, notification `nbcb=2`, callback `nbcb=1`) are form POSTs. `verifyCallback` checks
 *   `skey = md5(paydate.domain.md5(tranID.orderid.status.domain.amount.currency).appcode.secret_key)` over the field
 *   strings EXACTLY as posted (no number or date reformatting; an empty `appcode` is an empty string), in constant
 *   time, and that `domain` is your merchant ID. A posted currency `RM` (seen by the official plugin, C11) is hashed as
 *   `RM` and then reported as `MYR`; `getPayment` normalises it the same way.
 * - Requery answers are checked: `VrfKey = md5(Amount.secret_key.Domain.TranID|OrderID.StatCode)` in constant time,
 *   and the answer must be for your merchant and for the transaction or order asked about; otherwise GatewayError.
 *
 * Where the docs are silent or contradict themselves (UNCONFIRMED in the spec), this adapter picks the safe side:
 * - minimum amount: most MY channels say "> 1.00" and whether exactly RM1.00 passes is unconfirmed, so
 *   `minimumAmount` is 101 sen (the documented bound, read strictly) until measured;
 * - status: `paid` ONLY for StatCode `00` with StatName `captured` or `settled`. `00` + `authorized` (a pre-auth; this
 *   adapter never sends `tcctype=AUTH`) is `pending`; `00` with any other or no StatName is `unknown`. `22` (pending,
 *   or FPX-B2B "authorized") is `pending`; `11` is `cancelled` for `cancelled`/`canceled` (the spec spells it both
 *   ways) and `failed` otherwise. A callback's `status=22` "account enquiry" after a DuitNow QR scan is never paid;
 * - requery output: `type=2` (JSON) is sent, but `type` is "obsoleted in new API sets" for q_by_tid (SPEC p73), so the
 *   default `Key: value` text answer is parsed too. An amount with a comma (`1,234.00`, C15) is unreadable (NaN), so
 *   `confirmPayment` reports a mismatch, never a payment;
 * - requery errors (PSQ codes Q01…Q99, SPEC p147) have no documented body shape: any answer without a two-digit
 *   StatCode is a GatewayError quoting the answer (keys masked), with the Q code as `code` when one appears;
 * - rate limits contradict each other ("1 query every 5 seconds" vs Q99 "1 request every 5 minutes", C5): `getPayment`
 *   sends exactly one request, never retries and never polls. Do not call it in a loop; Fiuu blocks IPs without notice;
 * - requery validity ("generally within 1 hour", C6, vs 7 and 180 days): an old transaction may answer Q203/Q06, which
 *   is a GatewayError, never `paid`;
 * - hosts: production `pay.fiuu.com` / `api.fiuu.com`; sandbox `sandbox-payment.fiuu.com` / `sandbox-api.fiuu.com`
 *   (SPEC p24 + WooCommerce; SPEC p68 says merchant APIs live on `sandbox-payment.fiuu.com`, C3, and the Postman hosts
 *   do not resolve, C4). Paths use `/RMS/`, not the plugins' `/MOLPay/` alias (C9). `baseUrl` overrides both hosts;
 * - the currency field is `currency` (SPEC p41), not the WooCommerce plugin's `cur` (C10). Only MYR is sent;
 * - `orderid`: 1–32 characters of A–Z, a–z, 0–9 and `-` (the spec says "alphanumeric" yet its own example is
 *   `BH2018-09rev`; q_by_oid takes at most 32 characters while the payment page takes 40). Nothing else is sent, so a
 *   reference is never altered and `confirmPayment`'s reference check holds;
 * - buyer details: `bill_name`, `bill_email`, `bill_mobile` are "mandatory", but `guest_checkout=1` is documented for a
 *   merchant that does not hold them; when any is missing (or too long for its limit) the others are sent with
 *   `guest_checkout=1`. Whether the page then accepts the request is unconfirmed;
 * - `returnurl` is "for selected merchants only… will slow down your payment request"; it is sent anyway, as is
 *   `callbackurl` (domains other than your business site must be registered in the portal, SPEC p23);
 * - `expiresAt` → `PaymentExpirationTime` as an ISO 8601 UTC string (the field is typed "integer" but the example is a
 *   string, C19; non-cash channels only). `idempotencyKey` is ignored: there is no server-side create call, and which
 *   endpoints honour the idempotency header (named two ways, C8) is unconfirmed;
 * - `tranID` is accepted with 1–20 digits ("10-20 digits", "10 digits", "20 digits" and an 8-digit example, C14);
 * - `paydate`/`BillingDate` carry no timezone, so `paidAt` is never set; no fee is reported (`null`);
 * - acknowledging callbacks is the caller's job and the docs disagree on it: `CALLBACK_ACK` (`CBTOKEN:MPSTATOK`, no
 *   space, as the plugins send; one chart shows a space, C2) for the callback URL, and a re-POST to `returnipn.php` for
 *   IPN on the return/notification URLs. Retries are "3" or "4" (C1). Nothing in this adapter depends on either:
 *   `confirmPayment` asks Fiuu again whatever arrives, and is idempotent for duplicates;
 * - refunds/reversal (the reversal key itself is contradictory, C7) are not implemented.
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
  toRinggit,
  type VerifiedCallback,
} from '@bayarkit/core'

export const HOSTS = {
  sandbox: { pay: 'https://sandbox-payment.fiuu.com', api: 'https://sandbox-api.fiuu.com' },
  production: { pay: 'https://pay.fiuu.com', api: 'https://api.fiuu.com' },
} as const

/**
 * The plain-text body to answer a Callback URL (`nbcb=1`) POST with, no HTML (SPEC p58, p66, plugins). SPEC p67 shows
 * it with a space; the plugins and Java sample send none. Notification/return URLs use the IPN re-POST instead.
 */
export const CALLBACK_ACK = 'CBTOKEN:MPSTATOK'

export interface FiuuConfig {
  /** Merchant ID (`domain`); sandbox ones are typically `SB_…`. */
  merchantId: string
  /** Verify Key: signs the payment request (`vcode`) and requery requests. */
  verifyKey: string
  /** Secret Key: verifies callbacks (`skey`) and requery answers (`VrfKey`). */
  secretKey: string
  environment: keyof typeof HOSTS
  /** The portal option "Use extended format for Verify Payment" (compulsory for multi-currency). Default false. */
  extendedVcode?: boolean
  /** Override BOTH the payment and the API host (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const NAME = 'fiuu'
const MERCHANT = /^[A-Za-z0-9_-]{1,32}$/
/** Our references: the payment page allows 40 characters, q_by_oid only 32. */
const REFERENCE = /^[A-Za-z0-9-]{1,32}$/
const ORDER_ID = /^[A-Za-z0-9-]{1,40}$/
const TRAN_ID = /^\d{1,20}$/
/** "integer or up to 2 decimal points", no comma. */
const RINGGIT = /^\d{1,9}(\.\d{1,2})?$/
const PAYMENT_ID = /^([A-Za-z0-9-]{1,40}):(\d{1,9}\.\d{2})(?::(\d{1,20}))?$/

export const info: GatewayInfo = {
  name: NAME,
  // SPEC p26–p32: payable range "> 1.00" for most MY channels; whether exactly 1.00 passes is UNCONFIRMED → 1.01.
  minimumAmount: 101,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source:
      'Fiuu API Spec for Merchant v13.97 (github.com/FiuuPayment/Documentation-Fiuu_API_Spec) + official plugins/SDK',
  },
}

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex')

/** `vcode` for the payment request (SPEC p19–p20). `currency` is appended only in extended mode. */
export function vcode(parts: {
  amount: string
  merchantId: string
  orderid: string
  verifyKey: string
  currency?: string
  extended?: boolean
}): string {
  return md5(
    `${parts.amount}${parts.merchantId}${parts.orderid}${parts.verifyKey}${parts.extended ? (parts.currency ?? '') : ''}`,
  )
}

/** The payment-result `skey` (SPEC p21), over the strings exactly as posted. */
export function paymentSkey(
  f: {
    tranID: string
    orderid: string
    status: string
    domain: string
    amount: string
    currency: string
    paydate: string
    appcode: string
  },
  secretKey: string,
): string {
  const pre = md5(`${f.tranID}${f.orderid}${f.status}${f.domain}${f.amount}${f.currency}`)
  return md5(`${f.paydate}${f.domain}${pre}${f.appcode}${secretKey}`)
}

/** Requery request `skey = md5(txID|oID . domain . verify_key . amount)` (SPEC p70, p74, p77). */
export function querySkey(id: string, domain: string, verifyKey: string, amount: string): string {
  return md5(`${id}${domain}${verifyKey}${amount}`)
}

/** Requery answer `VrfKey = md5(Amount . secret_key . Domain . TranID|OrderID . StatCode)` (SPEC p70, p74, p77). */
export function queryVrfKey(
  amount: string,
  secretKey: string,
  domain: string,
  id: string,
  statCode: string,
): string {
  return md5(`${amount}${secretKey}${domain}${id}${statCode}`)
}

/** Ringgit string ("27.60", "500") → integer sen; NaN for commas, more than two decimals or anything else. */
export function senOf(ringgit: unknown): number {
  if (typeof ringgit !== 'string' || !RINGGIT.test(ringgit)) return Number.NaN
  return Math.round(Number(ringgit) * 100)
}

/** `RM` → `MYR` (the official WooCommerce plugin does this for callbacks); anything else unchanged. */
export const normaliseCurrency = (c: string) => (c.trim().toUpperCase() === 'RM' ? 'MYR' : c)

/** `<orderid>:<amount>` or `<orderid>:<amount>:<tranID>`. */
export function paymentId(orderid: string, sen: number, tranID?: string): string {
  return `${orderid}:${toRinggit(sen)}${tranID ? `:${tranID}` : ''}`
}

export function parsePaymentId(id: string): { orderid: string; amount: string; tranID?: string } | null {
  const m = typeof id === 'string' ? PAYMENT_ID.exec(id) : null
  if (!m?.[1] || !m[2]) return null
  return { orderid: m[1], amount: m[2], ...(m[3] ? { tranID: m[3] } : {}) }
}

/** Requery StatCode + StatName → status; `paid` only for a captured or settled success. */
export function statusOf(statCode: string, statName: string): PaymentStatus {
  const name = statName.trim().toLowerCase()
  if (statCode === '00') {
    if (name === 'captured' || name === 'settled') return 'paid'
    return name === 'authorized' ? 'pending' : 'unknown'
  }
  if (statCode === '11') return name === 'cancelled' || name === 'canceled' ? 'cancelled' : 'failed'
  if (statCode === '22') return 'pending'
  return 'unknown'
}

/** A callback's `status` (SPEC p45). Still only a claim: `confirmPayment` asks Fiuu again. */
function claimedStatusOf(status: string): PaymentStatus {
  if (status === '00') return 'paid'
  if (status === '11') return 'failed'
  if (status === '22') return 'pending'
  return 'unknown'
}

/** A requery answer: JSON (`type=2`) or the default `Key: value` lines. Values are strings ('' for null). */
export function parseQueryAnswer(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const text = body.trim()
  if (text.startsWith('{')) {
    try {
      const json: unknown = JSON.parse(text)
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        for (const [k, v] of Object.entries(json)) {
          if (typeof v === 'string' || typeof v === 'number') out[k] = String(v)
          else if (v === null) out[k] = ''
        }
      }
    } catch {}
    return out
  }
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

const chars = (value: string, max: number) => [...value].slice(0, max).join('')
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export function fiuu(config: FiuuConfig): Gateway {
  const hosts = HOSTS[config.environment]
  const override = config.baseUrl?.replace(/\/+$/, '')
  const payBase = override ?? hosts?.pay
  const apiBase = override ?? hosts?.api
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  if (!config.verifyKey || !config.secretKey || !payBase || !apiBase) {
    throw new GatewayError('merchantId, verifyKey, secretKey and environment are required', NAME, 0, 'CONFIG')
  }
  if (!MERCHANT.test(config.merchantId ?? '')) {
    throw new GatewayError('merchantId must be 1–32 letters, digits, "_" or "-"', NAME, 0, 'CONFIG')
  }
  const secrets = [config.verifyKey, config.secretKey].filter((s) => s.length >= 4)
  const mask = (message: string) => secrets.reduce((m, s) => m.split(s).join('[redacted]'), message)

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
      if (typeof reference !== 'string' || !REFERENCE.test(reference)) {
        throw new GatewayError(
          'reference must be 1–32 characters of A–Z, a–z, 0–9 and "-"',
          NAME,
          0,
          'INVALID_REFERENCE',
        )
      }
      let expiry = ''
      if (input.expiresAt) {
        const ms = input.expiresAt.getTime()
        if (!Number.isFinite(ms) || ms <= Date.now())
          throw new GatewayError('expiresAt must be in the future', NAME, 0, 'INVALID_EXPIRY')
        expiry = isoSeconds(ms)
      }
      const amount = toRinggit(input.amount)
      const name = chars(input.customer?.name?.trim() ?? '', 128)
      const emailRaw = input.customer?.email?.trim() ?? ''
      const email = emailRaw.length <= 128 ? emailRaw : ''
      const phoneRaw = (input.customer?.phone ?? '').replace(/[\s()-]/g, '')
      const mobile = /^\+?\d{6,31}$/.test(phoneRaw) ? phoneRaw : ''
      const params: Record<string, string> = {
        amount,
        orderid: reference,
        ...(name ? { bill_name: name } : {}),
        ...(email ? { bill_email: email } : {}),
        ...(mobile ? { bill_mobile: mobile } : {}),
        ...(name && email && mobile ? {} : { guest_checkout: '1' }),
        bill_desc: chars(input.description?.trim() ?? '', 255) || reference,
        currency: 'MYR',
        vcode: vcode({
          amount,
          merchantId: config.merchantId,
          orderid: reference,
          verifyKey: config.verifyKey,
          currency: 'MYR',
          extended: config.extendedVcode === true,
        }),
        returnurl: input.returnUrl,
        callbackurl: input.callbackUrl,
        ...(expiry ? { PaymentExpirationTime: expiry } : {}),
      }
      const url = `${payBase}/RMS/pay/${config.merchantId}/?${new URLSearchParams(params).toString()}`
      return { id: paymentId(reference, input.amount), url, raw: params }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      const parsed = parsePaymentId(id)
      if (!parsed || (!parsed.tranID && parsed.orderid.length > 32))
        throw new GatewayError('invalid payment id', NAME, 0, 'INVALID_ID')
      const byTid = parsed.tranID !== undefined
      const key = parsed.tranID ?? parsed.orderid
      const path = byTid ? '/RMS/q_by_tid.php' : '/RMS/query/q_by_oid.php'
      const form: Record<string, string> = {
        amount: parsed.amount,
        [byTid ? 'txID' : 'oID']: key,
        domain: config.merchantId,
        skey: querySkey(key, config.merchantId, config.verifyKey, parsed.amount),
        type: '2',
      }
      let res: Response
      let body: string
      try {
        // One request, no retry: Fiuu blocks IPs that query too often (C5).
        res = await doFetch(`${apiBase}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json, text/plain',
          },
          body: new URLSearchParams(form).toString(),
          signal: AbortSignal.timeout(timeoutMs),
        })
        body = await res.text()
      } catch (e) {
        throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, NAME, 0)
      }
      const what = byTid ? 'q_by_tid' : 'q_by_oid'
      const answer = parseQueryAnswer(body)
      const statCode = answer.StatCode ?? ''
      if (!res.ok || !/^\d{2}$/.test(statCode)) {
        const code = answer.ErrorCode || /\bQ\d{2,5}\b/.exec(body)?.[0] || undefined
        const desc = answer.ErrorDesc || body.trim()
        throw new GatewayError(
          mask(`${what} HTTP ${res.status}${code ? ` ${code}` : ''}${desc ? `: ${desc.slice(0, 300)}` : ''}`),
          NAME,
          res.status,
          code,
        )
      }
      const amountText = answer.Amount ?? ''
      const domain = answer.Domain ?? ''
      const answeredId = byTid ? (answer.TranID ?? '') : (answer.OrderID ?? '')
      const expectedVrf = queryVrfKey(amountText, config.secretKey, domain, answeredId, statCode)
      if (!timingSafeEqualText(expectedVrf, (answer.VrfKey ?? '').toLowerCase())) {
        throw new GatewayError(`${what}: answer VrfKey did not verify`, NAME, res.status, 'VRFKEY')
      }
      if (domain !== config.merchantId || answeredId !== key) {
        throw new GatewayError(
          `${what}: answer is for another merchant or transaction`,
          NAME,
          res.status,
          'MISMATCH',
        )
      }
      return {
        id,
        reference: answer.OrderID ?? '',
        status: statusOf(statCode, answer.StatName ?? ''),
        amount: senOf(amountText),
        currency: normaliseCurrency(answer.Currency ?? ''),
        // Fiuu's dates carry no timezone (UNCONFIRMED) and requery reports no fee.
        fee: null,
        raw: answer,
      }
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        let fields: Record<string, unknown> = cb?.fields ?? {}
        // Frameworks that hand over only the raw form body: parse it the way readCallback would.
        if (
          typeof fields.skey !== 'string' &&
          typeof cb?.rawBody === 'string' &&
          /(^|&)skey=/.test(cb.rawBody)
        ) {
          fields = Object.fromEntries(new URLSearchParams(cb.rawBody))
        }
        const s = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : '')
        const given = s('skey').toLowerCase()
        const posted = {
          tranID: s('tranID'),
          orderid: s('orderid'),
          status: s('status'),
          domain: s('domain'),
          amount: s('amount'),
          currency: s('currency'),
          paydate: s('paydate'),
          appcode: s('appcode'),
        }
        if (!/^[0-9a-f]{32}$/.test(given) || posted.domain !== config.merchantId) return null
        if (!TRAN_ID.test(posted.tranID) || !ORDER_ID.test(posted.orderid) || !/^\d{2}$/.test(posted.status))
          return null
        // The strings exactly as posted: no amount or date reformatting, `RM` stays `RM` here.
        if (!timingSafeEqualText(paymentSkey(posted, config.secretKey), given)) return null
        const sen = senOf(posted.amount)
        if (!Number.isFinite(sen)) return null
        const raw: Record<string, string> = {}
        for (const [k, v] of Object.entries(fields)) if (typeof v === 'string') raw[k] = v
        raw.currency = normaliseCurrency(posted.currency)
        return {
          id: paymentId(posted.orderid, sen, posted.tranID),
          reference: posted.orderid,
          claimedStatus: claimedStatusOf(posted.status),
          raw,
        }
      } catch {
        return null
      }
    },
  }
}
