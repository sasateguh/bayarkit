/** What every fake gateway lets a test do, so one conformance suite can drive any adapter. */
export interface FakeGateway {
  /** Base URL to pass as the adapter's `baseUrl`. */
  url: string
  /** Record a successful payment for the payment created with this id. */
  markPaid(id: string): void
  /**
   * A callback body exactly as the gateway would post it for this payment, correctly signed. It claims success even
   * before `markPaid` (a replayed or forged-with-a-leaked-key callback); `override` changes fields BEFORE signing,
   * except `checksum`/`hash`, which replace the signature.
   */
  callbackFor(id: string, override?: Record<string, string>): Record<string, string>
  close(): Promise<void>
}
