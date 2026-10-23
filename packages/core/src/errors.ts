/**
 * Thrown by adapters when the gateway refuses or cannot be reached. `message` never contains secrets: adapters only
 * quote the gateway's response body, and secrets travel only in requests.
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly gateway: string,
    /** HTTP status, or 0 when the gateway could not be reached. */
    readonly status: number,
    /** The gateway's own error code or text when it gave one. */
    readonly code?: string,
  ) {
    super(`${gateway}: ${message}`)
    this.name = 'GatewayError'
  }
}
