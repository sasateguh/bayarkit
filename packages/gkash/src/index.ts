/**
 * Gkash adapter: host-to-host checkout (`POST /api/payment/form`, the flow DOC recommends "for new integrations"),
 * transaction query (`POST /api/payment/query`) and the signed server callback / return.
 *
 * Written from the official material only, read 23 October 2026 (`gateways/gkash/spec.md`, a source next to every
 * fact): doc.gkash.my (rendered, it is a Blazor app), the official WooCommerce plugin (woo-gkash v1.3.0) and the
 * gkashmy Android/iOS SDKs. NOT yet measured against the staging host (api-staging.pay.asia): where staging differs
 * from the docs, this adapter will be wrong until someone runs the conformance suite there.
 *
 * - Credentials: Merchant ID (`CID`) and Signature Key. There is no API key header: every request and every callback
 *   is authenticated only by `signature` = lowercase hex SHA-512 of the WHOLE `;`-joined string UPPERCASED (key
 *   included). Request: `key;CID;cartid;AMT;MYR`. Callback, return and checkout response:
 *   `key;CID;POID;cartid;AMT;MYR;status`, with the full status text (`88 - Transferred` → `88 - TRANSFERRED`). AMT is
 *   the ringgit amount with two decimals and the dot removed, leading zero KEPT (0.10 → `010`, not integer sen `10`).
 *   Upper-casing is ASCII-only, like the official plugin's PHP `strtoupper`. All official vectors are in the tests.
 * - Amounts are ringgit strings at Gkash (`"10.50"`), integer sen here; converted at the edge only. An amount with
 *   more than two decimals is unreadable (NaN / refused), never rounded into a match.
 * - Your `reference` is sent as `v_cartid`, the merchant reference Gkash echoes as `cartid` and the key the query
 *   takes. Gkash calls it a "Unique Merchant Reference Number" and the official plugin makes a new one per attempt,
 *   so a new attempt for the same order needs a new reference. Allowed: letters, digits, `-`, `_`, `.` (refused, never
 *   rewritten, otherwise; confirmPayment compares references exactly).
 * - The id is `<cartid>:<amount in sen>`: the query is keyed by cart id but signed over the amount too, and a callback
 *   carries both. `getPayment` needs nothing else.
 * - Query responses are UNSIGNED (DOC lists no signature field): `getPayment` trusts them over TLS from the host you
 *   called only, after checking that `cartid` (and `CID`, when present) are the ones asked for. A return/redirect is
 *   never proof of payment; only `confirmPayment` (signature → query → exact match) is.
 * - Only status code `88` is ever `paid`; `66` → failed, `11` → pending, anything else → unknown. The status is
 *   branched on its numeric prefix (as the plugin does) but signed as the full text.
 *
 * Contradictions in the official material (spec §9) and what this adapter does:
 * - C1 `version`: DOC says `1.5.5`, the plugin and every SDK send `1.5.0`. Default `1.5.0` (what the official
 *   clients ship); `version` in the config overrides it. The query sends `1.3.0` (DOC).
 * - C2 return delivery: DOC says the return is a POST form, the SDKs read it from the URL query. `readCallback` gives
 *   the same fields either way and the same signature is checked; `+` decodes to a space in `status`.
 * - C3 amount normalisation: DOC formats the posted amount to two decimals before removing the dot; this adapter does
 *   the same with decimal text (`100`, `100.0`, `100.00` all sign as `10000`), unlike the Android SDK's raw strip.
 * - C5 terminal/soundbox APIs use another convention (input NOT upper-cased, UPPERCASE hex). Not implemented; a
 *   callback signed that way is refused.
 * - C6 DOC's own callback cURL posts `CID=M161-U-99` with a signature computed for `M161-U-999`: it fails its own
 *   signature, and this adapter refuses it (tested).
 * - C7/C9 refund and recurring examples: not implemented; their unreproducible signatures are not used.
 * - C8 the checkout response's signature has no formula on its own page; it reproduces the callback formula with
 *   `11 - PENDING` (official vector). `createPayment` verifies it and refuses an answer that does not verify.
 * - C10 `callbackurl`/`returnurl` are optional in DOC: both are always sent.
 * - C11 production host `https://api.gkash.my` appears only in the plugin and SDKs, never in DOC; it is used here
 *   because every official client uses it. Staging: `https://api-staging.pay.asia`.
 *
 * Choices made where the docs are silent (UNCONFIRMED in the spec), each the safe option:
 * - minimum amount: none documented (the OpenCart `0.10` is a plugin setting, not a gateway rule); `minimumAmount` is
 *   100 sen (RM1.00) until measured;
 * - expiry: no field and no statement; `expiresAt` is ignored. `idempotencyKey` has no equivalent and is ignored;
 *   what Gkash does with a reused cart id is unknown, so use one reference per attempt;
 * - `v_cartid` maximum length: not documented; nothing is cut (Gkash has the final word, a truncated echo fails
 *   confirmPayment's exact match);
 * - checkout response with `redirect.html` but no `redirect.url`: when Gkash chooses which is undocumented; a URL is
 *   required here, so such an answer is a GatewayError (`REDIRECT_HTML`), never a half-made payment;
 * - error bodies are undocumented: messages quote the response's `status`/`description`/`message` text and the HTTP
 *   status, never a request field (the signature key is never sent anyway);
 * - refunds: a query whose `refundamount` is above zero reads as `unknown` (never `paid`); the meaning of the other
 *   refund fields is undocumented;
 * - no paid-time field exists (`paidAt` is never set; `refunddate` has no documented timezone); no fee (`null`);
 * - callbacks: `CID` must equal yours and `currency` must be `MYR` (Gkash "only supports MYR"); retries and source IPs
 *   are undocumented. Answer a callback with HTTP 200 and the body `OK` (DOC), even for a duplicate;
 * - the mobile SDKs carry the Signature Key inside the app (spec §8). Do not do that: verify on your server only.
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
  sandbox: 'https://api-staging.pay.asia',
  production: 'https://api.gkash.my',
} as const

/** What the official plugin and SDKs send (DOC says `1.5.5`, spec C1). */
export const CHECKOUT_VERSION = '1.5.0'
export const QUERY_VERSION = '1.3.0'

export interface GkashConfig {
  /** Merchant ID, e.g. `M161-U-999`. */
  cid: string
  /** Signature Key issued with the Merchant ID. Never ship it in an app. */
  signatureKey: string
  environment: keyof typeof HOSTS
  /** Checkout `version` field. Default `1.5.0` (official plugin and SDKs); DOC shows `1.5.5`. */
  version?: string
  /** Override the host (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const NAME = 'gkash'
const CART = /^[A-Za-z0-9._-]{1,255}$/
const ID = /^([A-Za-z0-9._-]{1,255}):(\d{1,15})$/
const HEX = /^[0-9a-f]{128}$/

export const info: GatewayInfo = {
  name: NAME,
  // UNCONFIRMED: no gateway minimum is documented; 100 sen until measured, as for the other adapters.
  minimumAmount: 100,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source: 'doc.gkash.my + official WooCommerce plugin (woo-gkash 1.3.0) + gkashmy Android/iOS SDKs',
  },
}

/** ASCII-only upper-casing, like PHP `strtoupper` in the official plugin. */
const upper = (s: string) => s.replace(/[a-z]/g, (c) => c.toUpperCase())

/** Gkash's online signature: SHA-512 of `key;part;part…` upper-cased as a whole, lowercase hex (spec §4.1, §4.2). */
export function gkashSignature(key: string, parts: string[]): string {
  return createHash('sha512')
    .update(upper([key, ...parts].join(';')))
    .digest('hex')
}

const RINGGIT = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/

/**
 * The AMT part of a signature from a ringgit amount as Gkash posts it: two decimals, commas and dot removed, leading
 * zero kept (`"100.00"` → `"10000"`, `"0.10"` → `"010"`, `"100"` → `"10000"`). `null` when it is not such an amount.
 */
export function signingAmount(ringgit: string): string | null {
  const m = RINGGIT.exec(ringgit)
  if (!m) return null
  const whole = (m[1] ?? '').replaceAll(',', '').replace(/^0+(?=\d)/, '')
  return `${whole}${(m[2] ?? '').padEnd(2, '0')}`
}

/** Ringgit text → integer sen; NaN when unreadable or with more than two decimals. */
function senOf(ringgit: unknown): number {
  const a = typeof ringgit === 'string' ? signingAmount(ringgit.trim()) : null
  const n = a === null ? Number.NaN : Number(a)
  return Number.isSafeInteger(n) ? n : Number.NaN
}

/** `"88 - Transferred"` → paid; `66` → failed; `11` → pending; anything else → unknown (never paid). */
export function statusOf(text: unknown): PaymentStatus {
  const code = /^\s*(\d+)/.exec(String(text ?? ''))?.[1]
  if (code === '88') return 'paid'
  if (code === '66') return 'failed'
  if (code === '11') return 'pending'
  return 'unknown'
}

const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

export function gkash(config: GkashConfig): Gateway {
  const base = (config.baseUrl ?? HOSTS[config.environment]).replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const version = config.version ?? CHECKOUT_VERSION

  async function post(path: string, body: Record<string, string>) {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, NAME, 0)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { res, json: json && typeof json === 'object' && !Array.isArray(json) ? json : null }
  }

  // Quotes the RESPONSE only. The signature key is never sent, so it cannot be echoed back.
  function fail(what: string, res: Response, json: Record<string, unknown> | null, code?: string): never {
    const said = ['status', 'description', 'message']
      .map((k) => text(json?.[k]).trim())
      .filter(Boolean)
      .join('; ')
    throw new GatewayError(
      `${what} HTTP ${res.status}${said ? `: ${said.slice(0, 300)}` : ''}`,
      NAME,
      res.status,
      code ?? (text(json?.status) || undefined),
    )
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
      const cartid = input.reference
      if (!CART.test(cartid)) {
        throw new GatewayError(
          'reference must be 1–255 letters, digits, "-", "_" or "."',
          NAME,
          0,
          'INVALID_REFERENCE',
        )
      }
      const amount = toRinggit(input.amount)
      const AMT = amount.replace('.', '')
      const name = input.customer?.name?.trim() ?? ''
      const email = input.customer?.email?.trim() ?? ''
      const description = input.description.trim()
      const body: Record<string, string> = {
        version,
        CID: config.cid,
        v_cartid: cartid,
        v_currency: 'MYR',
        v_amount: amount,
        signature: gkashSignature(config.signatureKey, [config.cid, cartid, AMT, 'MYR']),
        returnurl: input.returnUrl,
        callbackurl: input.callbackUrl,
        ...(name ? { v_firstname: name } : {}),
        ...(email ? { v_billemail: email } : {}),
        ...(description ? { v_productdesc: description } : {}),
      }
      const { res, json } = await post('/api/payment/form', body)
      if (!res.ok || !json) fail('create checkout', res, json)
      // The checkout response is signed with the callback formula (spec C8); refuse it unless it verifies and echoes
      // this exact cart id and amount.
      const status = text(json.status)
      const poId = text(json.poId)
      const echoed = signingAmount(text(json.amount))
      const expected = gkashSignature(config.signatureKey, [
        text(json.cid),
        poId,
        text(json.cartId),
        echoed ?? '',
        text(json.currency),
        status,
      ])
      if (
        text(json.cid) !== config.cid ||
        text(json.cartId) !== cartid ||
        echoed !== AMT ||
        text(json.currency) !== 'MYR' ||
        !timingSafeEqualText(expected, text(json.signature).toLowerCase())
      ) {
        fail('create checkout (answer did not verify)', res, json, 'RESPONSE_SIGNATURE')
      }
      const redirect = (json.redirect ?? null) as { url?: unknown; html?: unknown } | null
      const url = text(redirect?.url)
      if (!/^https?:\/\//.test(url)) {
        fail(
          typeof redirect?.html === 'string'
            ? 'create checkout: Gkash answered with redirect.html only, which this adapter does not render'
            : 'create checkout: no redirect URL',
          res,
          json,
          typeof redirect?.html === 'string' ? 'REDIRECT_HTML' : 'NO_REDIRECT',
        )
      }
      return { id: `${cartid}:${input.amount}`, url, raw: json }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      const m = ID.exec(id)
      const sen = Number(m?.[2])
      if (!m || !Number.isSafeInteger(sen))
        throw new GatewayError('invalid payment id', NAME, 0, 'INVALID_ID')
      const cartid = m[1] ?? ''
      const amount = toRinggit(sen)
      const { res, json } = await post('/api/payment/query', {
        version: QUERY_VERSION,
        CID: config.cid,
        cartid,
        currency: 'MYR',
        amount,
        signature: gkashSignature(config.signatureKey, [config.cid, cartid, amount.replace('.', ''), 'MYR']),
      })
      if (!res.ok || !json) fail('query', res, json)
      // Unsigned answer (spec §3): it must at least be about the cart id we asked for, for our merchant.
      if (
        text(json.cartid) !== cartid ||
        (json.CID !== undefined && text(json.CID) !== config.cid) ||
        !text(json.status)
      ) {
        fail('query (answer is not for this cart id)', res, json, 'QUERY_MISMATCH')
      }
      const refunded = senOf(text(json.refundamount)) > 0
      return {
        id,
        reference: cartid,
        status: refunded ? 'unknown' : statusOf(json.status),
        amount: senOf(text(json.amount)),
        currency: text(json.currency),
        fee: null,
        raw: json,
      }
    },

    verifyCallback({ fields }: CallbackInput): VerifiedCallback | null {
      try {
        const f = (k: string) => (typeof fields[k] === 'string' ? fields[k] : '')
        const [cid, poid, cartid, amount, currency, status] = [
          f('CID'),
          f('POID'),
          f('cartid'),
          f('amount'),
          f('currency'),
          f('status'),
        ]
        const given = f('signature').toLowerCase()
        const AMT = signingAmount(amount)
        if (!config.signatureKey || !HEX.test(given) || AMT === null) return null
        if (cid !== config.cid || currency !== 'MYR' || !poid || !status || !CART.test(cartid)) return null
        const expected = gkashSignature(config.signatureKey, [cid, poid, cartid, AMT, currency, status])
        if (!timingSafeEqualText(expected, given)) return null
        const sen = Number(AMT)
        if (!Number.isSafeInteger(sen)) return null
        return {
          id: `${cartid}:${sen}`,
          reference: cartid,
          claimedStatus: statusOf(status),
          raw: { ...fields },
        }
      } catch {
        return null
      }
    },
  }
}
