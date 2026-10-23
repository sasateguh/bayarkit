/**
 * The contract every gateway adapter implements. Amounts are always integer **sen** (minor units) so no adapter
 * ever compares floating-point ringgit.
 */

export type Currency = 'MYR'

/** Normalised payment states. `unknown` means the gateway answered with something this adapter has not seen. */
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'unknown'

export interface Customer {
  name?: string
  email?: string
  phone?: string
}

export interface CreatePaymentInput {
  /** Your own order or invoice reference. Echoed back by the gateway and checked by `confirmPayment`. */
  reference: string
  /** Amount in sen (RM 10.50 = 1050). */
  amount: number
  currency?: Currency
  /** Short text shown on the gateway's payment page. Adapters trim it to the gateway's limits. */
  description: string
  customer?: Customer
  /** Where the customer's browser lands after paying. Never treat this visit as proof of payment. */
  returnUrl: string
  /** Server-to-server notification URL. */
  callbackUrl: string
  expiresAt?: Date
  /** Lets a retried call return the same payment instead of creating a second one (where the gateway supports it). */
  idempotencyKey?: string
}

export interface CreatedPayment {
  /** The id to pass to `getPayment`, and the id a callback will carry. */
  id: string
  /** Redirect the customer here. */
  url: string
  raw: unknown
}

export interface PaymentRecord {
  id: string
  reference: string
  status: PaymentStatus
  amount: number
  currency: Currency | string
  paidAt?: Date
  /** Gateway fee in sen when the gateway reports one; `null` when it reports none or an unreadable value. */
  fee?: number | null
  raw: unknown
}

/** A callback whose signature checked out. It is still only a claim until `getPayment` agrees. */
export interface VerifiedCallback {
  id: string
  reference: string
  claimedStatus: PaymentStatus
  raw: Record<string, string>
}

/** What an adapter declares about itself; the conformance suite and docs read this. */
export interface GatewayInfo {
  name: string
  /** Smallest amount the gateway accepts, in sen. */
  minimumAmount: number
  /**
   * Where the adapter's behaviour comes from. `measured` = checked against the gateway's sandbox on `date`;
   * `docs` = written from official documentation only.
   */
  evidence: { kind: 'measured' | 'docs'; date: string; source: string }
}

export interface Gateway {
  readonly info: GatewayInfo
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>
  /** Ask the gateway for the current state. This, not the callback body, is the source of truth. */
  getPayment(id: string): Promise<PaymentRecord>
  /** Check a callback's signature. Returns `null` when it is not authentic; never throws on bad input. */
  verifyCallback(body: Record<string, string>): VerifiedCallback | null
}
