import type { CallbackInput } from '@bayarkit/core'

/** What every fake gateway lets a test do, so one conformance suite can drive any adapter. */
export interface FakeGateway {
  /** Base URL to pass as the adapter's `baseUrl`. */
  url: string
  /** Record a successful payment for the payment created with this id. */
  markPaid(id: string): void
  /**
   * The callback exactly as the gateway would deliver it for this payment, correctly signed. It claims success even
   * before `markPaid` (a replayed or forged-with-a-leaked-key callback); `override` changes fields BEFORE signing.
   */
  callbackFor(id: string, override?: Record<string, string>): CallbackInput
  /** The same callback with its signature altered (wherever this gateway keeps it: a field or a header). */
  tamper(callback: CallbackInput): CallbackInput
  close(): Promise<void>
}

/** Flip the first character of a hex/base64 signature. */
export const flip = (s: string): string => s.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
