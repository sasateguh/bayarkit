import type { CallbackInput } from './types.js'

/**
 * Read a gateway callback from a standard `Request` (Next.js route handlers, Hono, Bun, Deno, Cloudflare Workers).
 * The body is read ONCE as text (header-signed gateways need the exact bytes), then parsed as JSON,
 * `application/x-www-form-urlencoded` or `multipart/form-data` — toyyibPay's real callbacks are multipart (measured), so
 * code that only parses URL-encoded bodies silently sees nothing. Without a body, the query string is used (return URLs).
 * Non-text values are dropped; a broken body gives empty fields, never an exception.
 */
export async function readCallback(request: Request): Promise<CallbackInput> {
  const headers: Record<string, string> = {}
  request.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v
  })
  const type = headers['content-type'] ?? ''
  const rawBody = request.body ? await request.text().catch(() => '') : ''
  const fields: Record<string, string> = {}
  if (type.includes('application/json')) {
    let json: unknown = null
    try {
      json = JSON.parse(rawBody)
    } catch {}
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      for (const [k, v] of Object.entries(json)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') fields[k] = String(v)
      }
    }
  } else if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
    const form = await new Response(rawBody, { headers: { 'content-type': type } })
      .formData()
      .catch(() => null)
    form?.forEach((v, k) => {
      if (typeof v === 'string') fields[k] = v
    })
  }
  if (!rawBody) {
    new URL(request.url).searchParams.forEach((v, k) => {
      fields[k] = v
    })
  }
  return { fields, rawBody, headers }
}

/** For frameworks that already parsed the body (e.g. Express `urlencoded`). Header-signed gateways need `readCallback`. */
export function callbackFromFields(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): CallbackInput {
  return { fields: { ...fields }, rawBody: '', headers }
}
