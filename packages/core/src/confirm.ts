import { GatewayError } from './errors.js'
import type {
  CallbackInput,
  Currency,
  Gateway,
  PaymentRecord,
  VerifiedCallback,
  VerifyResult,
} from './types.js'

const errorName = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e)

export interface Expected {
  reference: string
  /** Amount in sen that you charged for this order. */
  amount: number
  /** Default: the adapter's `info.currency`, else `MYR`. */
  currency?: Currency
}

export type ConfirmResult =
  | { ok: true; payment: PaymentRecord }
  | {
      ok: false
      reason: 'invalid_signature' | 'not_paid' | 'mismatch' | 'gateway_error'
      detail: string
      payment?: PaymentRecord
    }

/**
 * The only safe way to mark an order paid from a callback:
 *
 * 1. the callback signature must verify (cheap filter, rejects forgeries; awaited, as some gateways verify via their API);
 * 2. the gateway is asked again with `getPayment` (a valid signature can still be replayed or describe another order);
 * 3. the gateway's own record must say `paid`, for this reference, this exact amount and currency.
 *
 * Callers should make step "mark order paid" idempotent: gateways retry callbacks.
 */
export async function confirmPayment(
  gateway: Gateway<VerifyResult>,
  callback: CallbackInput,
  expected: Expected,
): Promise<ConfirmResult> {
  let cb: VerifiedCallback | null
  try {
    cb = await gateway.verifyCallback(callback)
  } catch (e) {
    // The contract says it never throws on bad input; when an adapter does, that is a bug, a misconfiguration (a broken
    // key) or a failed verify call to the gateway, not a forgery, so it is reported as such. A GatewayError quotes the
    // gateway's answer only; anything else is named by class: messages of unknown errors may carry details.
    const detail =
      e instanceof GatewayError ? e.message : `${gateway.info.name}: verifyCallback threw ${errorName(e)}`
    return { ok: false, reason: 'gateway_error', detail }
  }
  if (!cb)
    return {
      ok: false,
      reason: 'invalid_signature',
      detail: `${gateway.info.name}: callback signature did not verify`,
    }
  if (cb.reference && cb.reference !== expected.reference) {
    return {
      ok: false,
      reason: 'mismatch',
      detail: `callback is for reference ${cb.reference}, expected ${expected.reference}`,
    }
  }
  let payment: PaymentRecord
  try {
    payment = await gateway.getPayment(cb.id)
  } catch (e) {
    // GatewayError messages quote the gateway's answer only (never a secret); anything else is named, not quoted.
    const detail =
      e instanceof GatewayError ? e.message : `${gateway.info.name}: getPayment threw ${errorName(e)}`
    return { ok: false, reason: 'gateway_error', detail }
  }
  if (payment.status !== 'paid') {
    return { ok: false, reason: 'not_paid', detail: `gateway reports ${payment.status}`, payment }
  }
  const currency = expected.currency ?? gateway.info.currency ?? 'MYR'
  const problems = [
    payment.reference !== expected.reference && `reference ${payment.reference} ≠ ${expected.reference}`,
    payment.amount !== expected.amount && `amount ${payment.amount} sen ≠ ${expected.amount} sen`,
    payment.currency !== currency && `currency ${payment.currency} ≠ ${currency}`,
  ].filter(Boolean)
  if (problems.length) return { ok: false, reason: 'mismatch', detail: problems.join('; '), payment }
  return { ok: true, payment }
}
