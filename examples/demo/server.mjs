#!/usr/bin/env node
/**
 * `npm run demo` (after `npm run build`): the demo on http://127.0.0.1:4317, or PORT/HOST. Node's http → the
 * web-standard handler. Hardened for a public host: one bad request is answered, never fatal; bodies are capped; the
 * URL is built on a fixed base, so the Host header decides nothing.
 */
import { createServer } from 'node:http'
import { startDemo } from './app.mjs'

const MAX_BODY = 64 * 1024
const demo = await startDemo()
const port = Number(process.env.PORT ?? 4317)
const host = process.env.HOST ?? '127.0.0.1'

const plain = (res, status, text, close = false) => {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    ...(close ? { connection: 'close' } : {}),
  })
  res.end(text)
}

createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD', 'POST'].includes(req.method ?? '')) return plain(res, 405, 'Method not allowed')
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return plain(res, 400, 'Bad request')
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      // The rest of the body is not read, so this connection cannot carry another request: say so.
      if (size > MAX_BODY) return plain(res, 413, 'Too large', true)
      chunks.push(c)
    }
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    const method = req.method === 'HEAD' ? 'GET' : req.method
    const response = await demo.handle(
      new Request(`http://demo.local${req.url}`, {
        method,
        headers,
        ...(method === 'POST' && chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()))
  } catch (e) {
    console.error('demo:', e instanceof Error ? e.message : e)
    if (!res.headersSent) plain(res, 400, 'Bad request')
    else res.destroy()
  }
}).listen(port, host, () =>
  console.log(`bayarkit demo: http://${host}:${port}/ (${demo.gateways.size} fake gateways)`),
)
