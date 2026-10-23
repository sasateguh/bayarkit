/**
 * eGHL adapter (now ADAPTIS e-Commerce by NTT DATA Payment Services; one `payment.aspx` for every operation).
 *
 * eGHL publishes NO API guide: its Merchant Integration Guide is marked confidential and is not used. This adapter is
 * written from the official PUBLIC code only, read 23 October 2026 (`gateways/eghl/spec.md`, a source next to every
 * fact): bitbucket.org/eghl `eghl_hash` (the hash field lists), `merchantapi` (QUERY, TxnStatus codes, response
 * HashValue check), `eghl-omnipay` (response fields, the HashValue/HashValue2 test vector), `paramvalidator` (field
 * limits) and the ADAPTIS WooCommerce plugin. NOT yet measured against the test host (pay.e-ghl.com, public test
 * merchant `SIT`).
 *
 * - Credentials: `ServiceID` (3 characters) + the Merchant Password. The password is never sent; it is only the hash
 *   secret. Hashes are lowercase hex SHA-256 of password + field values concatenated, NO separator, NOT an HMAC;
 *   a missing optional field contributes "".
 * - `createPayment` makes no HTTP call (eGHL has no create API). It returns `url` = `payment.aspx?<fields>`, the GET
 *   redirect the official WooCommerce plugin uses (`$this->payment_url . http_build_query($data)`), and the same
 *   fields in `raw` (`{ action, method: 'POST', fields }`) for an auto-submitting form, which is what Omnipay does.
 *   Request HashValue = sha256(password + ServiceID + PaymentID + MerchantReturnURL + MerchantApprovalURL +
 *   MerchantUnApprovalURL + MerchantCallBackURL + Amount + CurrencyCode + CustIP + PageTimeout + CardNo + Token); the
 *   approval/unapproval URLs, card number and token are never sent, so they hash as "" (the C6 plugin variant that
 *   leaves them out gives the same value). URLs have `&` replaced by `;` before hashing and sending.
 * - Amounts are ringgit strings with exactly two decimals at eGHL (`10.50`); sen ↔ ringgit is converted at the edge.
 * - Your `reference` is sent as BOTH `PaymentID` (unique per attempt, AN20) and `OrderNumber`, because the QUERY answer
 *   carries `PaymentID` but no public source says it carries `OrderNumber`: this way `confirmPayment`'s reference check
 *   reads the gateway's own record. A new attempt for the same order therefore needs a new reference (PaymentID reuse
 *   is UNCONFIRMED; every official plugin generates a fresh one "to avoid duplicate Payment ID").
 * - QUERY must repeat the original Amount and CurrencyCode, so the payment id is `<PaymentID>.<amount in sen>`, plus
 *   `.<PymtMethod>` when it comes from a callback (e.g. `ORDER1.1050.DD`). `getPayment` POSTs `TransactionType=QUERY`
 *   and verifies the answer's 7-field HashValue (TxnID, ServiceID, PaymentID, TxnStatus, Amount, CurrencyCode, AuthCode)
 *   exactly as merchant-api does; an answer that does not verify is a GatewayError, never a status.
 * - Callbacks (`MerchantCallBackURL`, server to server) and returns (`MerchantReturnURL`, browser) carry the same form
 *   fields; both verify with HashValue2 = sha256(password + TxnID + ServiceID + PaymentID + TxnStatus + Amount +
 *   CurrencyCode + AuthCode + OrderNumber + Param6 + Param7), the eGHL_HASH 10-field list, compared in constant time.
 *   The official Omnipay vector is reproduced in the tests. Fields are signed, not bytes, so `callbackFromFields`
 *   works as well as `readCallback`. Answer the server callback with the plain body `CALLBACK_REPLY` (`OK`).
 *
 * Where the public code is silent or contradicts itself (UNCONFIRMED in the spec), this adapter picks the safe side:
 * - C1: the shorter HashValue2 lists of the Magento plugin (no Param7) and the OpenCart plugin (no Param6, Param7) are
 *   NOT accepted. They give the same hash only when Param6/Param7 are empty, and this adapter never sends them;
 * - C2: only HashValue2 is accepted on callbacks (a callback with the legacy 7-field HashValue alone is refused); QUERY
 *   answers are checked with HashValue as merchant-api does, and a HashValue2 in a QUERY answer is ignored;
 * - C3: a response `Amount` is hashed exactly as received (the eGHL_HASH class does not touch it; WHMCS strips commas
 *   first and PrestaShop after). `1,000.00` is read as 100000 sen only after the hash verified. Requests never carry
 *   commas;
 * - C4: `CustIP` up to 45 characters (paramvalidator), sent whole: WooCommerce's cut to 20 would break IPv6;
 *   `OrderNumber` = the reference, at most 20 characters because it is also the PaymentID;
 * - C5: hex case is ignored when comparing (Woo/Magento use `strcasecmp`); the computed hash is lowercase;
 * - every field the eGHL_HASH class marks mandatory (TxnID, ServiceID, PaymentID, TxnStatus, Amount, CurrencyCode,
 *   OrderNumber) must be non-empty, so its silent `sha256(password)`-alone result is never accepted; `ServiceID` must
 *   be yours and `CurrencyCode` MYR. Values are NOT rewritten (WooCommerce's `:` → `=>` replacement is not copied);
 * - status: `paid` ONLY when a verified QUERY answer says `TxnStatus=0` AND `TxnExists=0` (the inverted "exists" flag).
 *   `1` → failed (`cancelled` when TxnMessage is "Buyer cancelled"), `2` → pending, `-1` (no such transaction, e.g.
 *   the page was never submitted) → pending, `9` (reversed) → cancelled, `10` refunded / `15` authorised / `16`
 *   captured / `31` reversal pending / anything else → unknown, `-2` (system error) → GatewayError;
 * - QUERY `PymtMethod`: whether eGHL wants the method sent (`ANY`) or the one paid with (`DD`, the callback's) is
 *   UNCONFIRMED. `getPayment` asks with the method in the id first and, when eGHL answers `-1`, again with
 *   `paymentMethod` from the config. Every answer is verified the same way;
 * - `CustIP` is required by eGHL but not part of `CreatePaymentInput`: pass `customerIp`, or set
 *   `fallbackCustomerIp` in the config; with neither, createPayment refuses (no invented address);
 * - customer name and email are required and refused when missing (email over 60 characters is refused, never cut;
 *   the name is cut to 50). `CustPhone` is required by paramvalidator but optional here: without a phone it is left
 *   out, and whether eGHL then refuses the page is UNCONFIRMED;
 * - `expiresAt` → `PageTimeout` in seconds (≤ 4 digits); later than 9999 s is cut to 9999 s (the page expires
 *   earlier, never later). Without `expiresAt` no PageTimeout is sent (eGHL's default is UNCONFIRMED);
 * - minimum amount: none published (paramvalidator checks the format only); `minimumAmount` is 100 sen until measured;
 * - no paid-time field is published, so `paidAt` is left out; no fee is reported (`null`);
 * - `idempotencyKey` has no eGHL equivalent and is ignored (there is no create call to repeat);
 * - callback retries are UNCONFIRMED (plugins de-duplicate and reply `OK`): make "mark order paid" idempotent;
 * - error messages quote eGHL's answer (TxnMessage, or the first 200 characters of a non-200 body), never the password.
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
  sandbox: 'https://pay.e-ghl.com/IPGSG/payment.aspx',
  production: 'https://securepay.e-ghl.com/IPG/Payment.aspx',
} as const

/** The body to answer eGHL's server-to-server callback with (Omnipay README: `die('OK')`). */
export const CALLBACK_REPLY = 'OK'

/** eGHL_HASH field lists, in hash order. */
export const SALE_HASH_FIELDS = [
  'ServiceID',
  'PaymentID',
  'MerchantReturnURL',
  'MerchantApprovalURL',
  'MerchantUnApprovalURL',
  'MerchantCallBackURL',
  'Amount',
  'CurrencyCode',
  'CustIP',
  'PageTimeout',
  'CardNo',
  'Token',
] as const
export const QUERY_HASH_FIELDS = ['ServiceID', 'PaymentID', 'Amount', 'CurrencyCode'] as const
/** Legacy response HashValue (merchant-api checks it on QUERY answers). */
export const HASHVALUE_FIELDS = [
  'TxnID',
  'ServiceID',
  'PaymentID',
  'TxnStatus',
  'Amount',
  'CurrencyCode',
  'AuthCode',
] as const
/** Response HashValue2, the 10-field list of the eGHL_HASH class (callbacks and returns). */
export const HASHVALUE2_FIELDS = [...HASHVALUE_FIELDS, 'OrderNumber', 'Param6', 'Param7'] as const
/** Fields the eGHL_HASH class marks mandatory for HashValue2. */
const MANDATORY = ['TxnID', 'ServiceID', 'PaymentID', 'TxnStatus', 'Amount', 'CurrencyCode', 'OrderNumber']

/** Lowercase hex SHA-256 of `password` followed by `values` (missing = ""), no separator, no HMAC. */
export function eghlHash(password: string, values: readonly (string | undefined)[]): string {
  return createHash('sha256')
    .update(password + values.map((v) => v ?? '').join(''), 'utf8')
    .digest('hex')
}

/** eGHL hash of `fields` over the named field list. */
export function eghlHashOf(
  password: string,
  names: readonly string[],
  fields: Record<string, string | undefined>,
): string {
  return eghlHash(
    password,
    names.map((n) => fields[n]),
  )
}

export interface EghlConfig {
  /** Merchant `ServiceID` (3 characters, e.g. the public test merchant `SIT`). */
  serviceId: string
  /** Merchant Password ("merchant key"): the hash secret. Never sent. */
  merchantPassword: string
  environment: keyof typeof HOSTS
  /** `PymtMethod` sent with every payment: `ANY` (default, the buyer chooses), `CC`, `DD`, `WA`… */
  paymentMethod?: string
  /** `CustIP` when createPayment gets no `customerIp` (eGHL requires the field). */
  fallbackCustomerIp?: string
  /** Clock in milliseconds since the epoch (tests). Default `Date.now`. */
  now?: () => number
  /** Override the full `payment.aspx` URL (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface EghlPaymentInput extends CreatePaymentInput {
  /** The customer's IP address (`CustIP`, required by eGHL, at most 45 characters). */
  customerIp?: string
}

export interface EghlCreatedPayment extends CreatedPayment {
  raw: { action: string; method: 'POST'; fields: Record<string, string> }
}

const NAME = 'eghl'
const REFERENCE = /^[A-Za-z0-9_-]{1,20}$/
const METHOD = /^[A-Z]{2,3}$/
const ID = /^([A-Za-z0-9_-]{1,20})\.(\d{1,13})(?:\.([A-Z]{2,3}))?$/
const IP = /^[0-9A-Fa-f:.]{2,45}$/

export const info: GatewayInfo = {
  name: NAME,
  // UNCONFIRMED: no official public source states a minimum; 100 sen until measured.
  minimumAmount: 100,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source:
      'official eGHL public code: bitbucket.org/eghl (eghl_hash, merchantapi, eghl-omnipay, paramvalidator)',
  },
}

/** eGHL ringgit (`10.50`, or `1,000.00` after its hash verified) → integer sen; NaN for anything else. */
export function senOf(value: unknown): number {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^(\d+|\d{1,3}(,\d{3})+)\.\d{2}$/.test(text)) return Number.NaN
  const sen = Number(text.replace(/[,.]/g, ''))
  return Number.isSafeInteger(sen) ? sen : Number.NaN
}

function statusOf(txnStatus: string, txnMessage: string): PaymentStatus {
  switch (txnStatus) {
    case '0':
      return 'paid'
    case '1':
      return txnMessage === 'Buyer cancelled' ? 'cancelled' : 'failed'
    case '2':
    case '-1':
      return 'pending'
    case '9':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

const chars = (value: string, max: number) => [...value].slice(0, max).join('')

function merchantUrl(url: string, what: string): string {
  const value = url.trim().replaceAll('&', ';')
  if (!/^https?:\/\/[^\s]+$/.test(value) || value.length > 255) {
    throw new GatewayError(`${what} must be an http(s) URL of at most 255 characters`, NAME, 0, 'INVALID_URL')
  }
  return value
}

/** A `Gateway` whose createPayment also takes `customerIp` and returns the form fields in `raw`. */
export type EghlGateway = Omit<Gateway, 'createPayment'> & {
  createPayment(input: EghlPaymentInput): Promise<EghlCreatedPayment>
}

export function eghl(config: EghlConfig): EghlGateway {
  const endpoint = config.baseUrl ?? HOSTS[config.environment] ?? ''
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const now = config.now ?? Date.now
  const paymentMethod = config.paymentMethod ?? 'ANY'
  if (!/^[A-Za-z0-9]{3}$/.test(config.serviceId ?? '') || !config.merchantPassword || !endpoint) {
    throw new GatewayError(
      'serviceId (3 characters), merchantPassword and environment are required',
      NAME,
      0,
      'CONFIG',
    )
  }
  if (!METHOD.test(paymentMethod))
    throw new GatewayError('paymentMethod must be 2–3 capital letters', NAME, 0, 'CONFIG')
  const password = config.merchantPassword
  const mask = (message: string) =>
    password.length >= 4 ? message.split(password).join('[redacted]') : message

  async function query(paymentId: string, amount: string, method: string): Promise<Record<string, string>> {
    const form: Record<string, string> = {
      TransactionType: 'QUERY',
      PymtMethod: method,
      ServiceID: config.serviceId,
      PaymentID: paymentId,
      Amount: amount,
      CurrencyCode: 'MYR',
    }
    form.HashValue = eghlHashOf(password, QUERY_HASH_FIELDS, form)
    let res: Response
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, NAME, 0)
    }
    const body = await res.text().catch(() => '')
    if (!res.ok) {
      throw new GatewayError(mask(`QUERY HTTP ${res.status}: ${body.slice(0, 200)}`), NAME, res.status)
    }
    const answer = Object.fromEntries(new URLSearchParams(body))
    const given = (answer.HashValue ?? '').toLowerCase()
    if (
      !answer.TxnStatus ||
      !/^[0-9a-f]{64}$/.test(given) ||
      !timingSafeEqualText(eghlHashOf(password, HASHVALUE_FIELDS, answer), given)
    ) {
      throw new GatewayError(
        mask(
          `QUERY answer did not verify (HashValue)${answer.TxnMessage ? `: ${answer.TxnMessage.slice(0, 200)}` : ''}`,
        ),
        NAME,
        res.status,
        'RESPONSE_SIGNATURE',
      )
    }
    if (answer.TxnStatus === '-2') {
      throw new GatewayError(
        mask(`QUERY system error${answer.TxnMessage ? `: ${answer.TxnMessage.slice(0, 200)}` : ''}`),
        NAME,
        res.status,
        '-2',
      )
    }
    if (answer.PaymentID && answer.PaymentID !== paymentId) {
      throw new GatewayError(
        `QUERY answered for another PaymentID (${answer.PaymentID.slice(0, 40)})`,
        NAME,
        res.status,
      )
    }
    return answer
  }

  return {
    info,

    async createPayment(input: EghlPaymentInput): Promise<EghlCreatedPayment> {
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
          'reference must be 1–20 characters of A–Z, a–z, 0–9, "-" and "_" (it is also the eGHL PaymentID)',
          NAME,
          0,
          'INVALID_REFERENCE',
        )
      }
      const name = chars(input.customer?.name?.trim() ?? '', 50)
      const email = input.customer?.email?.trim() ?? ''
      const phone = input.customer?.phone?.trim() ?? ''
      if (!name) throw new GatewayError('customer name is required', NAME, 0, 'NAME_REQUIRED')
      if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 60) {
        throw new GatewayError(
          'a customer email of at most 60 characters is required',
          NAME,
          0,
          'EMAIL_REQUIRED',
        )
      }
      if ([...phone].length > 25)
        throw new GatewayError('customer phone is over 25 characters', NAME, 0, 'PHONE')
      const ip = (input.customerIp ?? config.fallbackCustomerIp ?? '').trim()
      if (!IP.test(ip)) {
        throw new GatewayError(
          'customerIp (or fallbackCustomerIp in the config) is required: an IP address, at most 45 characters',
          NAME,
          0,
          'CUSTOMER_IP',
        )
      }
      let pageTimeout = ''
      if (input.expiresAt) {
        const seconds = Math.ceil((input.expiresAt.getTime() - now()) / 1000)
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new GatewayError('expiresAt must be in the future', NAME, 0, 'INVALID_EXPIRY')
        }
        pageTimeout = String(Math.min(seconds, 9999))
      }
      const fields: Record<string, string> = {
        TransactionType: 'SALE',
        PymtMethod: paymentMethod,
        ServiceID: config.serviceId,
        PaymentID: reference,
        OrderNumber: reference,
        PaymentDesc: chars(input.description.trim(), 100) || reference,
        MerchantReturnURL: merchantUrl(input.returnUrl, 'returnUrl'),
        MerchantCallBackURL: merchantUrl(input.callbackUrl, 'callbackUrl'),
        Amount: toRinggit(input.amount),
        CurrencyCode: 'MYR',
        CustIP: ip,
        CustName: name,
        CustEmail: email,
        ...(phone ? { CustPhone: phone } : {}),
        ...(pageTimeout ? { PageTimeout: pageTimeout } : {}),
      }
      fields.HashValue = eghlHashOf(password, SALE_HASH_FIELDS, fields)
      return {
        id: `${reference}.${input.amount}`,
        url: `${endpoint}?${new URLSearchParams(fields).toString()}`,
        raw: { action: endpoint, method: 'POST', fields },
      }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      const m = typeof id === 'string' ? ID.exec(id) : null
      const paymentId = m?.[1]
      const sen = Number(m?.[2])
      if (!paymentId || !Number.isSafeInteger(sen)) {
        throw new GatewayError(
          'invalid payment id (expected <PaymentID>.<amount in sen>)',
          NAME,
          0,
          'INVALID_ID',
        )
      }
      const amount = toRinggit(sen)
      const methods = [...new Set([m?.[3] ?? paymentMethod, paymentMethod])]
      let answer: Record<string, string> = {}
      for (const method of methods) {
        answer = await query(paymentId, amount, method)
        if (answer.TxnStatus !== '-1') break
      }
      const txnStatus = answer.TxnStatus ?? ''
      let status = statusOf(txnStatus, answer.TxnMessage ?? '')
      // TxnExists is inverted: '0' means the transaction EXISTS. Without it, a success is not believed.
      if (status === 'paid' && answer.TxnExists !== '0') status = 'unknown'
      return {
        id,
        reference: answer.PaymentID ?? '',
        status,
        amount: senOf(answer.Amount),
        currency: answer.CurrencyCode ?? '',
        // eGHL publishes no paid-time field and no fee.
        fee: null,
        raw: answer,
      }
    },

    verifyCallback(cb: CallbackInput): VerifiedCallback | null {
      try {
        const fields = cb?.fields
        if (!fields || typeof fields !== 'object') return null
        const f = (k: string) => (typeof fields[k] === 'string' ? fields[k] : '')
        const given = f('HashValue2').toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(given)) return null
        if (MANDATORY.some((k) => !f(k))) return null
        if (f('ServiceID') !== config.serviceId) return null
        const values: Record<string, string> = {}
        for (const k of HASHVALUE2_FIELDS) values[k] = f(k)
        if (!timingSafeEqualText(eghlHashOf(password, HASHVALUE2_FIELDS, values), given)) return null
        // Only after the signature checked out:
        const paymentId = f('PaymentID')
        const sen = senOf(f('Amount'))
        if (!REFERENCE.test(paymentId) || !Number.isSafeInteger(sen) || f('CurrencyCode') !== 'MYR')
          return null
        const method = f('PymtMethod')
        return {
          id: `${paymentId}.${sen}${METHOD.test(method) ? `.${method}` : ''}`,
          reference: f('OrderNumber'),
          claimedStatus: statusOf(f('TxnStatus'), f('TxnMessage')),
          raw: Object.fromEntries(Object.entries(fields).filter(([, v]) => typeof v === 'string')),
        }
      } catch {
        return null
      }
    },
  }
}
