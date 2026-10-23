import { GatewayError } from './errors.js'
import type { CallbackInput, Currency, Gateway, PaymentRecord } from './types.js'

const errorName = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e)

export interface Expected {
  reference: string
  /** Amount in sen that you charged for this order. */
  amount: number
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
 * 1. the callback signature must verify (cheap filter, rejects forgeries);
 * 2. the gateway is asked again with `getPayment` (a valid signature can still be replayed or describe another order);
 * 3. the gateway's own record must say `paid`, for this reference, this exact amount and currency.
 *
 * Callers should make step "mark order paid" idempotent: gateways retry callbacks.
 */
export async function confirmPayment(
  gateway: Gateway,
  callback: CallbackInput,
  expected: Expected,
): Promise<ConfirmResult> {
  let cb: ReturnType<Gateway['verifyCallback']>
  try {
    cb = gateway.verifyCallback(callback)
  } catch (e) {
    // The contract says it never throws; when an adapter does, that is a bug or a misconfiguration (a broken key),
    // not a forgery, so it is reported as such. The class name only: messages of unknown errors may carry details.
    return {
      ok: false,
      reason: 'gateway_error',
      detail: `${gateway.info.name}: verifyCallback threw ${errorName(e)}`,
    }
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
  const currency = expected.currency ?? 'MYR'
  const problems = [
    payment.reference !== expected.reference && `reference ${payment.reference} ≠ ${expected.reference}`,
    payment.amount !== expected.amount && `amount ${payment.amount} sen ≠ ${expected.amount} sen`,
    payment.currency !== currency && `currency ${payment.currency} ≠ ${currency}`,
  ].filter(Boolean)
  if (problems.length) return { ok: false, reason: 'mismatch', detail: problems.join('; '), payment }
  return { ok: true, payment }
}
