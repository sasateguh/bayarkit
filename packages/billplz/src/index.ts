/**
 * Billplz adapter (API V3 Bills; Bills exist only in V3).
 *
 * Written from the official documentation (support.billplz.com/api, read 23 October 2026) and the official WooCommerce
 * plugin's signing code (Billplz/Billplz-for-WooCommerce, includes/helpers/billplz_wpconnect.php). Every fact used here
 * has its source in gateways/billplz/spec.md. NOT yet measured against the sandbox (www.billplz-sandbox.com): where the
 * sandbox differs from the docs, this adapter will be wrong until someone runs the conformance suite with sandbox keys.
 *
 * - auth = HTTP Basic, API secret key as the username and an EMPTY password (`base64("<key>:")`);
 * - amounts are integer sen everywhere (create, get, callback), so nothing is converted;
 * - X Signature = HMAC-SHA256(X Signature key, `key+value` strings of every parameter except `x_signature`, the STRINGS
 *   sorted ascending case-insensitively, joined with `|`), lowercase hex. Docs vs reality: the Security section says
 *   "sort keys", but the official test vectors and plugin sort the concatenated strings (`paid_amount100` before
 *   `paidtrue`); sorting by key gives a different HMAC. All three official vectors are reproduced in the tests;
 * - redirect parameters are nested (`billplz[id]`) and signed with the parent key prepended (`billplzid…`), decoded.
 *
 * Choices made where the docs are silent (UNCONFIRMED in the spec), each the safe option:
 * - minimum amount: the docs only say "positive integer"; `minimumAmount` is 100 sen (RM1.00) until measured;
 * - `paid_at` in Get-a-Bill: absent from the examples and of unknown format; `paidAt` is set only when it parses in the
 *   callback format (`2018-09-27 15:15:09 +0800`), otherwise left out;
 * - error bodies other than 429 "vary by endpoint": messages quote `error.message` / `error.type` when present, else
 *   the HTTP status. Nothing branches on the shape;
 * - unknown bill states with `paid: false` are reported as `pending` (never `paid`); `paid: true` wins over any state
 *   because a deleted bill comes back when a payment in flight completes;
 * - redirect query: only `billplz[…]` parameters are signed. Whether Billplz also signs query parameters that were
 *   already in your `redirect_url` is not documented, so those are ignored rather than trusted;
 * - accounts on the old "Basic" (unsigned) variant: every unsigned callback is refused. Enable X Signature in
 *   Settings → Keys & Integration;
 * - `mobile` must carry a country code (`60123456789`); a local number (`0123456789`) is not rewritten. With an email
 *   it is left out (email is enough), without one createPayment refuses;
 * - `expiresAt` and `idempotencyKey` have no Billplz equivalent (`due_at` is informational, bills expire after 30 days);
 *   they are ignored. Use `deleteBill` to end a payment window early.
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
  sandbox: 'https://www.billplz-sandbox.com/api',
  production: 'https://www.billplz.com/api',
} as const

export interface BillplzConfig {
  /** API Secret Key (Dashboard → Settings → Keys & Integration). Sandbox and production keys are separate. */
  secretKey: string
  /** X Signature key, used to verify callbacks and redirects. */
  xSignatureKey: string
  /** The Collection every bill is created in. */
  collectionId: string
  environment: keyof typeof HOSTS
  /** Override the host, up to and including `/api` (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const NAME = 'billplz'
const ID = /^[A-Za-z0-9_-]{1,64}$/

export const info: GatewayInfo = {
  name: NAME,
  // UNCONFIRMED: the docs give no minimum ("positive integer"); 100 sen until measured, as for the other adapters.
  minimumAmount: 100,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source: 'support.billplz.com/api + official WooCommerce plugin',
  },
}

/** The string X Signature signs: `key+value` per parameter (nested keys flattened), sorted case-insensitively, `|`. */
export function signingSource(fields: Record<string, string>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    const flat = key.replace(/[[\]]/g, '')
    if (flat === 'x_signature' || key.endsWith('[x_signature]')) continue
    parts.push(`${flat}${value ?? ''}`)
  }
  return parts
    .sort((a, b) => {
      const x = a.toLowerCase()
      const y = b.toLowerCase()
      if (x !== y) return x < y ? -1 : 1
      return a < b ? -1 : a > b ? 1 : 0
    })
    .join('|')
}

/** X Signature over every parameter except `x_signature` (spec §5.1), lowercase hex. */
export function xSignature(key: string, fields: Record<string, string>): string {
  return createHmac('sha256', key).update(signingSource(fields)).digest('hex')
}

function statusOf(paid: unknown, state: unknown): PaymentStatus {
  if (paid === true || paid === 'true') return 'paid'
  if (state === 'deleted') return 'cancelled'
  return 'pending'
}

/** "2018-09-27 15:15:09 +0800" → Date; anything else → undefined. */
export function parsePaidAt(text: unknown): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
    String(text ?? '').trim(),
  )
  if (!m) return undefined
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}${m[8]}:${m[9]}`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** Billplz wants a country code and no separators (`60123456789`); anything else is not sent. */
function mobileOf(phone: string | undefined): string {
  const p = (phone ?? '').replace(/[\s()-]/g, '')
  return /^\+?[1-9]\d{7,14}$/.test(p) ? p : ''
}

const chars = (text: string, max: number) => [...text].slice(0, max).join('')

export function billplz(config: BillplzConfig): Gateway & {
  /**
   * Delete a due bill so it can no longer be paid (payment time limits). Billplz refuses paid bills (422). A payment
   * already in flight can still complete and bring the bill back as paid, so keep handling its callback.
   */
  deleteBill(id: string): Promise<void>
} {
  const base = (config.baseUrl ?? HOSTS[config.environment]).replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const authorization = `Basic ${Buffer.from(`${config.secretKey}:`).toString('base64')}`

  async function request(method: string, path: string, form?: Record<string, string>) {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization,
          accept: 'application/json',
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, NAME, 0)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { res, json }
  }

  // Quotes the RESPONSE only; the secret key travels in the Authorization header and never reaches a message.
  function fail(what: string, res: Response, json: Record<string, unknown> | null): never {
    const err = (json?.error ?? null) as { type?: unknown; message?: unknown } | null
    const msg = Array.isArray(err?.message) ? err.message.map(String).join('; ') : err?.message
    const type = typeof err?.type === 'string' ? err.type : undefined
    const hint = res.status === 401 ? ' (wrong secret key, or a sandbox key on production?)' : ''
    throw new GatewayError(
      `${what} HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 300)}` : type ? `: ${type}` : ''}${hint}`,
      NAME,
      res.status,
      type,
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
      const email = input.customer?.email?.trim() ?? ''
      const mobile = mobileOf(input.customer?.phone)
      if (!email && !mobile) {
        throw new GatewayError(
          'an email or a mobile number with country code (e.g. 60123456789) is required',
          NAME,
          0,
          'CONTACT_REQUIRED',
        )
      }
      const name = input.customer?.name?.trim() ?? ''
      if (!name) throw new GatewayError('customer name is required', NAME, 0, 'NAME_REQUIRED')
      // Sent as given: reference_1 is at most 120 characters, and trimming or truncating it would make
      // confirmPayment's reference check fail later.
      const reference = input.reference
      if (!reference.trim() || [...reference].length > 120) {
        throw new GatewayError('reference must be 1–120 characters', NAME, 0, 'INVALID_REFERENCE')
      }
      const form: Record<string, string> = {
        collection_id: config.collectionId,
        name: chars(name, 255),
        amount: String(input.amount),
        description: chars(input.description.trim(), 200) || 'Payment',
        callback_url: input.callbackUrl,
        redirect_url: input.returnUrl,
        reference_1_label: 'Reference',
        reference_1: reference,
        ...(email ? { email } : {}),
        ...(mobile ? { mobile } : {}),
      }
      const { res, json } = await request('POST', '/v3/bills', form)
      const id = json?.id
      const url = json?.url
      if (
        !res.ok ||
        typeof id !== 'string' ||
        !ID.test(id) ||
        typeof url !== 'string' ||
        !/^https?:\/\//.test(url)
      ) {
        fail('create bill', res, json)
      }
      return { id, url, raw: json }
    },

    async getPayment(id: string): Promise<PaymentRecord> {
      if (!ID.test(id)) throw new GatewayError('invalid bill id', NAME, 0, 'INVALID_ID')
      const { res, json } = await request('GET', `/v3/bills/${id}`)
      if (!res.ok || !json || typeof json !== 'object') fail('get bill', res, json)
      // The X Signature key is account-wide, so a signed callback/redirect can name a bill from ANOTHER collection of
      // the same account (another shop, same order numbers). Only this collection's bills are ours.
      if (json.collection_id !== config.collectionId) {
        throw new GatewayError('bill belongs to another collection', NAME, res.status, 'FOREIGN_COLLECTION')
      }
      // Once paid, what counts is the money received (`paid_amount`), not what the bill asked for (`amount`).
      const amount = Number(statusOf(json.paid, json.state) === 'paid' ? json.paid_amount : json.amount)
      const paidAt = parsePaidAt(json.paid_at)
      return {
        id: String(json.id ?? id),
        reference: json.reference_1 == null ? '' : String(json.reference_1),
        status: statusOf(json.paid, json.state),
        amount: Number.isInteger(amount) ? amount : Number.NaN,
        currency: 'MYR',
        ...(paidAt ? { paidAt } : {}),
        // Bills report no fee.
        fee: null,
        raw: json,
      }
    },

    verifyCallback({ fields }: CallbackInput): VerifiedCallback | null {
      try {
        const redirect = fields['billplz[id]'] !== undefined
        const signed: Record<string, string> = redirect
          ? Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith('billplz[')))
          : { ...fields }
        const given = String(
          (redirect ? fields['billplz[x_signature]'] : fields.x_signature) ?? '',
        ).toLowerCase()
        const id = String((redirect ? fields['billplz[id]'] : fields.id) ?? '')
        if (!config.xSignatureKey || !/^[0-9a-f]{64}$/.test(given) || !ID.test(id)) return null
        if (!timingSafeEqualText(xSignature(config.xSignatureKey, signed), given)) return null
        const paid = redirect ? fields['billplz[paid]'] : fields.paid
        const state = redirect ? undefined : fields.state
        return {
          id,
          reference: String((redirect ? undefined : fields.reference_1) ?? ''),
          claimedStatus: statusOf(paid, state),
          raw: { ...fields },
        }
      } catch {
        return null
      }
    },

    async deleteBill(id: string): Promise<void> {
      if (!ID.test(id)) throw new GatewayError('invalid bill id', NAME, 0, 'INVALID_ID')
      const { res, json } = await request('DELETE', `/v3/bills/${id}`)
      if (!res.ok) fail('delete bill', res, json)
    },
  }
}
