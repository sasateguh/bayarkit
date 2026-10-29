import { GatewayError } from './errors.js'
import type { RefundInput } from './types.js'

/**
 * The checks every adapter makes before it asks the gateway for a refund: a payment id, a whole number of sen above
 * zero, and no more than `paid` (the amount the gateway's own record says was paid). Throws `GatewayError` (status 0).
 */
export function checkRefundAmount(gateway: string, input: RefundInput, paid: number): void {
  if (typeof input.paymentId !== 'string' || input.paymentId === '') {
    throw new GatewayError('refund needs the payment id', gateway, 0)
  }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new GatewayError(
      `refund amount must be a whole number of sen above 0, got ${input.amount}`,
      gateway,
      0,
    )
  }
  if (input.amount > paid) {
    throw new GatewayError(`refund of ${input.amount} sen exceeds the ${paid} sen paid`, gateway, 0)
  }
}
