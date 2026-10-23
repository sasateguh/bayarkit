/**
 * Bayarcash API v3 adapter (BCL.my runs on Bayarcash too).
 *
 * Written from the official documentation (api.webimpian.support/bayarcash) and the official PHP SDK
 * (webimpian/bayarcash-php-sdk: ChecksumGenerator, CallbackVerifications). NOT yet measured against the sandbox:
 * where the sandbox differs from the docs (toyyibPay did, in nine places), this adapter will be wrong until someone
 * runs the conformance suite with sandbox keys.
 *
 * - checksum = HMAC-SHA256(API secret key, values sorted by field NAME, joined with `|`);
 * - amount = ringgit with two decimals ("25.00"), the same string in the JSON body and in the checksum;
 * - `payment_channel` may be a list; in the checksum it is joined with `,` (SDK test: [1, 2] → "1,2");
 * - transaction callbacks are signed over 13 fields, pre-transaction callbacks over 3, return-URL parameters over 9.
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
  sandbox: 'https://api.console.bayarcash-sandbox.com/v3',
  production: 'https://api.console.bayar.cash/v3',
} as const

export interface BayarcashConfig {
  /** Personal Access Token (Bearer). */
  token: string
  /** API secret key, used for checksums. */
  secretKey: string
  portalKey: string
  environment: keyof typeof HOSTS
  /** Bayarcash payment channel ids; default `[1]` (FPX). */
  channels?: number[]
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

// Official transaction statuses: 0 New · 1 Pending · 2 Failed · 3 Success · 4 Cancelled.
const STATUS: Record<string, PaymentStatus> = {
  '0': 'pending',
  '1': 'pending',
  '2': 'failed',
  '3': 'paid',
  '4': 'cancelled',
}

export const info: GatewayInfo = {
  name: 'bayarcash',
  // The docs state no minimum; 100 sen is used until measured, so one value works across adapters.
  minimumAmount: 100,
  evidence: {
    kind: 'docs',
    date: '2026-10-23',
    source: 'api.webimpian.support/bayarcash + webimpian/bayarcash-php-sdk',
  },
}

const TRANSACTION_FIELDS = [
  'record_type',
  'transaction_id',
  'exchange_reference_number',
  'exchange_transaction_id',
  'order_number',
  'currency',
  'amount',
  'payer_name',
  'payer_email',
  'payer_bank_name',
  'status',
  'status_description',
  'datetime',
] as const
const RETURN_FIELDS = [
  'transaction_id',
  'exchange_reference_number',
  'exchange_transaction_id',
  'order_number',
  'currency',
  'amount',
  'payer_bank_name',
  'status',
  'status_description',
] as const

export function checksum(secretKey: string, fields: Record<string, string>): string {
  return createHmac('sha256', secretKey)
    .update(
      Object.keys(fields)
        .sort()
        .map((k) => fields[k] ?? '')
        .join('|'),
    )
    .digest('hex')
}

/**
 * Verify a transaction callback or return-URL parameters. A JSON body may carry `amount` as a number (25, not "25.00"),
 * so the two-decimal form is tried too; both still need a valid HMAC.
 */
export function verifyChecksum(
  secretKey: string,
  data: Record<string, string>,
  kind: 'transaction' | 'return',
): boolean {
  const given = String(data.checksum ?? '').toLowerCase()
  if (!secretKey || !/^[0-9a-f]{64}$/.test(given)) return false
  const names = kind === 'transaction' ? TRANSACTION_FIELDS : RETURN_FIELDS
  const fields = Object.fromEntries(names.map((k) => [k, String(data[k] ?? '').trim()]))
  if (timingSafeEqualText(checksum(secretKey, fields), given)) return true
  const amount = fields.amount
  if (amount && !amount.includes('.') && Number.isFinite(Number(amount))) {
    return timingSafeEqualText(checksum(secretKey, { ...fields, amount: Number(amount).toFixed(2) }), given)
  }
  return false
}

export function bayarcash(config: BayarcashConfig): Gateway & {
  /** Check the token and list portals with their enabled channels. */
  listPortals(): Promise<{ portalKey: string; name: string; channels: { id: number; name: string }[] }[]>
} {
  const base = (config.baseUrl ?? HOSTS[config.environment]).replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000
  const channels = config.channels?.length ? config.channels : [1]
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${config.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...extra,
  })

  async function request(path: string, init: RequestInit) {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, 'bayarcash', 0)
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    return { res, json }
  }

  return {
    info,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (!Number.isInteger(input.amount) || input.amount < info.minimumAmount) {
        throw new GatewayError(
          `amount must be integer sen ≥ ${info.minimumAmount}`,
          'bayarcash',
          0,
          'INVALID_AMOUNT',
        )
      }
      if ((input.currency ?? 'MYR') !== 'MYR')
        throw new GatewayError('only MYR is supported', 'bayarcash', 0, 'CURRENCY')
      const name = input.customer?.name?.trim() ?? ''
      const email = input.customer?.email?.trim() ?? ''
      // Both are part of the signed payload (official SDK checksum fields), so both are required.
      if (!name || !email) {
        throw new GatewayError('payer name and email are required', 'bayarcash', 0, 'PAYER_REQUIRED')
      }
      const amount = toRinggit(input.amount)
      const body = {
        payment_channel: channels,
        portal_key: config.portalKey,
        order_number: input.reference,
        amount,
        payer_name: name,
        payer_email: email,
        return_url: input.returnUrl,
        callback_url: input.callbackUrl,
        checksum: checksum(config.secretKey, {
          payment_channel: channels.join(','),
          order_number: input.reference,
          amount,
          payer_name: name,
          payer_email: email,
        }),
      }
      const { res, json } = await request('/payment-intents', {
        method: 'POST',
        headers: headers({ 'idempotency-key': input.idempotencyKey ?? input.reference }),
        body: JSON.stringify(body),
      })
      const url = json?.url
      if (!res.ok || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        throw new GatewayError(
          String(json?.message ?? `payment intent HTTP ${res.status}`),
          'bayarcash',
          res.status,
        )
      }
      return { id: String(json?.id ?? ''), url, raw: json }
    },

    async getPayment(transactionId: string): Promise<PaymentRecord> {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(transactionId)) {
        throw new GatewayError('invalid transaction id', 'bayarcash', 0, 'INVALID_ID')
      }
      const { res, json } = await request(`/transactions/${transactionId}`, { headers: headers() })
      if (!res.ok || !json) throw new GatewayError(`transaction HTTP ${res.status}`, 'bayarcash', res.status)
      return {
        id: String(json.id ?? transactionId),
        reference: String(json.order_number ?? ''),
        status: STATUS[String(json.status)] ?? 'unknown',
        amount: toSen(json.amount),
        currency: String(json.currency ?? ''),
        raw: json,
      }
    },

    verifyCallback({ fields: body }: CallbackInput): VerifiedCallback | null {
      // Pre-transaction callbacks (record_type "pre_transaction") carry no transaction id: nothing to confirm yet.
      if (body.record_type === 'pre_transaction' || !body.transaction_id) return null
      const kind = body.record_type === 'transaction' ? 'transaction' : 'return'
      if (!verifyChecksum(config.secretKey, body, kind)) return null
      return {
        id: String(body.transaction_id),
        reference: String(body.order_number ?? ''),
        claimedStatus: STATUS[String(body.status)] ?? 'unknown',
        raw: { ...body },
      }
    },

    async listPortals() {
      const { res, json } = await request('/portals', { headers: headers() })
      const data = json?.data
      if (!res.ok || !Array.isArray(data))
        throw new GatewayError(`portals HTTP ${res.status}`, 'bayarcash', res.status)
      return (data as Record<string, unknown>[]).map((p) => ({
        portalKey: String(p.portal_key),
        name: String(p.portal_name),
        channels: ((p.payment_channels as { id: number; name: string }[] | undefined) ?? []).map((c) => ({
          id: Number(c.id),
          name: String(c.name),
        })),
      }))
    },
  }
}
