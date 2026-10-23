/**
 * toyyibPay adapter.
 *
 * Written from the official API reference (toyyibpay.com/apireference) and then MEASURED against the sandbox
 * (dev.toyyibpay.com, 10 October 2026, including a real test-bank FPX payment). Where the two disagree, this adapter
 * follows what the sandbox actually did:
 *
 * | Thing                          | Docs                         | Measured                                                |
 * |--------------------------------|------------------------------|---------------------------------------------------------|
 * | Response body                  | JSON                         | prefixed with `\t\t\t\t`, sent as `text/html`             |
 * | Bill with no transactions      | `[]`                         | the text `No data found!`                               |
 * | `getCategoryDetails`           | `[{categoryName}]`           | `{CategoryName}` (an object, capital C)                 |
 * | createBill errors              | (not documented)             | `[KEY-DID-NOT-EXIST-OR-USER-IS-NOT-ACTIVE]`, `[CATEGORY-NOT-MATCH]`, or JSON `{"status":"error","msg":…}` |
 * | `billExpiryDate`               | format only                  | read in Malaysia time (UTC+8)                           |
 * | Minimum amount                 | "more than RM1.00"           | 100 sen accepted, 99 rejected (inclusive)               |
 * | `billPayorInfo=1`              | email required               | confirmed: empty email rejected                         |
 * | Callback body                  | form post                    | `multipart/form-data`; the documented hash formula holds |
 * | `billPaymentDate`              | `dd-mm-yyyy HH:MM:SS`        | confirmed, Malaysia time                                |
 */
import { createHash } from 'node:crypto'
import {
  type CreatedPayment,
  type CreatePaymentInput,
  type Gateway,
  GatewayError,
  type GatewayInfo,
  type PaymentRecord,
  type PaymentStatus,
  timingSafeEqualText,
  toSen,
  type VerifiedCallback,
} from '@bayarkit/core'

export const HOSTS = { sandbox: 'https://dev.toyyibpay.com', production: 'https://toyyibpay.com' } as const

export interface ToyyibPayConfig {
  /** `userSecretKey` from the toyyibPay dashboard. */
  secretKey: string
  categoryCode: string
  environment: keyof typeof HOSTS
  /**
   * `fpx` (default) avoids card chargebacks; `card` and `both` follow toyyibPay's `billPaymentChannel` 1 and 2.
   */
  channel?: 'fpx' | 'card' | 'both'
  /**
   * Charge toyyibPay's FPX fee to the customer (`billChargeToCustomer=0`; not available for cards). Off by default
   * (blank = the bill owner pays): when on, the paid amount can exceed what you charged and `confirmPayment`
   * (exact amount match) will refuse the payment.
   */
  chargeFeeToCustomer?: boolean
  /** Override the host (tests point this at the fake from `@bayarkit/testing`). */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const MINIMUM_SEN = 100
const CHANNEL = { fpx: '0', card: '1', both: '2' } as const
const STATUS: Record<string, PaymentStatus> = { '1': 'paid', '2': 'pending', '3': 'failed', '4': 'pending' }

export const info: GatewayInfo = {
  name: 'toyyibpay',
  minimumAmount: MINIMUM_SEN,
  evidence: {
    kind: 'measured',
    date: '2026-10-10',
    source: 'dev.toyyibpay.com sandbox, incl. one test-bank FPX payment',
  },
}

export function toyyibpay(config: ToyyibPayConfig): Gateway & {
  /** Close a bill so it can no longer be paid. `alreadyInactive` when it was closed before. */
  deactivate(billCode: string): Promise<{ alreadyInactive: boolean }>
  /** Check the secret key and category without creating a bill. */
  checkConnection(): Promise<{ categoryName: string }>
} {
  const host = (config.baseUrl ?? HOSTS[config.environment]).replace(/\/+$/, '')
  const doFetch = config.fetch ?? fetch
  const timeoutMs = config.timeoutMs ?? 15_000

  async function call(path: string, fields: Record<string, string>) {
    let res: Response
    try {
      res = await doFetch(`${host}/index.php/api/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new GatewayError(`unreachable (${e instanceof Error ? e.name : 'error'})`, 'toyyibpay', 0)
    }
    const text = (await res.text().catch(() => '')).trim() // measured: leading tabs
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {}
    return { status: res.status, json, text: text.slice(0, 300) }
  }

  // Error text quotes the RESPONSE only; the secret travels in the request body and never reaches a message.
  function fail(r: { status: number; json: unknown; text: string }): never {
    const j = r.json as { status?: string; msg?: string } | null
    if (j && !Array.isArray(j) && j.status === 'error' && j.msg) {
      throw new GatewayError(`refused: ${String(j.msg).slice(0, 200)}`, 'toyyibpay', r.status, String(j.msg))
    }
    const code = /^\[([A-Z-]+)\]$/.exec(r.text)?.[1]
    throw new GatewayError(
      r.text || 'empty response (wrong secret key or category?)',
      'toyyibpay',
      r.status,
      code,
    )
  }

  return {
    info,

    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (!Number.isInteger(input.amount) || input.amount <= 0) {
        throw new GatewayError(
          `amount must be positive integer sen, got ${input.amount}`,
          'toyyibpay',
          0,
          'INVALID_AMOUNT',
        )
      }
      if (input.amount < MINIMUM_SEN) {
        throw new GatewayError('amount below the RM1.00 minimum', 'toyyibpay', 0, 'BELOW_MINIMUM')
      }
      if ((input.currency ?? 'MYR') !== 'MYR')
        throw new GatewayError('only MYR is supported', 'toyyibpay', 0, 'CURRENCY')
      const email = input.customer?.email?.trim() ?? ''
      const r = await call('createBill', {
        userSecretKey: config.secretKey,
        categoryCode: config.categoryCode,
        billName: clean(input.description, 30) || 'Payment',
        billDescription: clean(input.description, 100) || 'Payment',
        billPriceSetting: '1',
        // Measured: payorInfo=1 requires an email; payorInfo=0 makes the customer type name/email/phone on the bill page.
        billPayorInfo: email ? '1' : '0',
        billAmount: String(input.amount),
        billReturnUrl: input.returnUrl,
        billCallbackUrl: input.callbackUrl,
        billExternalReferenceNo: input.reference,
        billTo: (input.customer?.name ?? '').slice(0, 80),
        billEmail: email,
        billPhone: input.customer?.phone ?? '',
        billPaymentChannel: CHANNEL[config.channel ?? 'fpx'],
        billChargeToCustomer: config.chargeFeeToCustomer ? '0' : '',
        ...(input.expiresAt ? { billExpiryDate: malaysiaTime(input.expiresAt) } : {}),
      })
      const code = Array.isArray(r.json)
        ? (r.json[0] as { BillCode?: unknown } | undefined)?.BillCode
        : undefined
      if (r.status === 200 && typeof code === 'string' && /^[A-Za-z0-9]{4,40}$/.test(code)) {
        return { id: code, url: `${host}/${code}`, raw: r.json }
      }
      fail(r)
    },

    async getPayment(billCode: string): Promise<PaymentRecord> {
      const r = await call('getBillTransactions', { billCode })
      if (r.status !== 200) fail(r)
      // Measured: a bill with no transactions answers this exact text, not `[]`.
      if (r.text === 'No data found!') {
        return { id: billCode, reference: '', status: 'pending', amount: 0, currency: 'MYR', raw: [] }
      }
      if (!Array.isArray(r.json)) fail(r)
      const txs = r.json as Record<string, unknown>[]
      const pick =
        txs.find((t) => String(t.billpaymentStatus) === '1') ??
        txs.find((t) => STATUS[String(t.billpaymentStatus)] === 'pending') ??
        txs[txs.length - 1]
      if (!pick)
        return { id: billCode, reference: '', status: 'pending', amount: 0, currency: 'MYR', raw: txs }
      const paidAt = parseMalaysiaTime(String(pick.billPaymentDate ?? ''))
      const fee =
        pick.transactionCharge == null || String(pick.transactionCharge).trim() === ''
          ? null
          : toSen(pick.transactionCharge)
      return {
        id: billCode,
        reference: String(pick.billExternalReferenceNo ?? ''),
        status: STATUS[String(pick.billpaymentStatus)] ?? 'unknown',
        amount: toSen(pick.billpaymentAmount),
        currency: 'MYR',
        ...(paidAt ? { paidAt } : {}),
        fee: Number.isNaN(fee) ? null : fee,
        raw: txs,
      }
    },

    verifyCallback(body: Record<string, string>): VerifiedCallback | null {
      const given = String(body.hash ?? '').toLowerCase()
      if (!/^[0-9a-f]{32}$/.test(given) || !body.billcode) return null
      const expected = createHash('md5')
        .update(`${config.secretKey}${body.status ?? ''}${body.order_id ?? ''}${body.refno ?? ''}ok`)
        .digest('hex')
      if (!timingSafeEqualText(given, expected)) return null
      return {
        id: String(body.billcode),
        reference: String(body.order_id ?? ''),
        claimedStatus: STATUS[String(body.status)] ?? 'unknown',
        raw: { ...body },
      }
    },

    async deactivate(billCode: string) {
      // The parameter is `secretKey`, not `userSecretKey` (inactiveBill docs).
      const r = await call('inactiveBill', { secretKey: config.secretKey, billCode })
      const j = r.json as { status?: string; result?: string } | null
      if (r.status === 200 && j?.status === 'success') return { alreadyInactive: false }
      if (r.status === 200 && j?.status === 'failed' && j.result === 'Bill is inactive')
        return { alreadyInactive: true }
      // Measured: {status:"error", result:"Invalid Secret Key!"} for a wrong key AND for a bill that does not exist.
      throw new GatewayError(String(j?.result ?? r.text).slice(0, 200), 'toyyibpay', r.status, j?.status)
    },

    async checkConnection() {
      const r = await call('getCategoryDetails', {
        userSecretKey: config.secretKey,
        categoryCode: config.categoryCode,
      })
      // Docs: [{categoryName}]; sandbox: {CategoryName}. Accept both.
      const row = (Array.isArray(r.json) ? r.json[0] : r.json) as Record<string, unknown> | null
      const name = row && typeof row === 'object' ? (row.CategoryName ?? row.categoryName) : undefined
      if (r.status === 200 && typeof name === 'string') return { categoryName: name }
      fail(r)
    },
  }
}

/** toyyibPay accepts only letters, digits, spaces and `_` in billName/billDescription. */
export function clean(text: string, max: number): string {
  return text
    .replace(/[^A-Za-z0-9 _]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
}

const MY_OFFSET_MS = 8 * 3600_000

/** Date → "dd-mm-yyyy HH:MM:SS" in Malaysia time (measured for billExpiryDate). */
export function malaysiaTime(date: Date): string {
  const d = new Date(date.getTime() + MY_OFFSET_MS)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}

/** "02-03-2021 16:24:25" (Malaysia time) → Date; `undefined` for any other shape or an impossible date. */
export function parseMalaysiaTime(text: string): Date | undefined {
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(text.trim())
  if (!m) return undefined
  const [, dd, mm, yyyy, hh, mi, ss] = m.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const t = Date.UTC(yyyy, mm - 1, dd, hh, mi, ss) - MY_OFFSET_MS
  const back = new Date(t + MY_OFFSET_MS)
  return back.getUTCDate() === dd && back.getUTCMonth() === mm - 1 ? new Date(t) : undefined
}
