/**
 * Read a gateway callback from a standard `Request` (Next.js route handlers, Hono, Bun, Deno, Cloudflare Workers).
 * Handles JSON, `application/x-www-form-urlencoded` and `multipart/form-data` — toyyibPay's real callbacks are
 * multipart (measured), so code that only parses URL-encoded bodies silently sees nothing. Non-text values are dropped.
 */
export async function readCallbackBody(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? ''
  const out: Record<string, string> = {}
  if (type.includes('application/json')) {
    const json = (await request.json().catch(() => null)) as Record<string, unknown> | null
    for (const [k, v] of Object.entries(json ?? {})) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
    }
    return out
  }
  if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await request.formData().catch(() => null)
    form?.forEach((v, k) => {
      if (typeof v === 'string') out[k] = v
    })
    return out
  }
  // Return URLs carry their parameters in the query string.
  new URL(request.url).searchParams.forEach((v, k) => {
    out[k] = v
  })
  return out
}
