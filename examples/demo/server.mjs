#!/usr/bin/env node
/** `npm run demo` (after `npm run build`): the demo on http://127.0.0.1:4317, or PORT. Node's http → web-standard handler. */
import { createServer } from 'node:http'
import { startDemo } from './app.mjs'

const demo = await startDemo()
const port = Number(process.env.PORT ?? 4317)
const host = process.env.HOST ?? '127.0.0.1'
createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? Buffer.concat(chunks) : undefined
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
  const response = await demo.handle(
    new Request(`http://${req.headers.host ?? `${host}:${port}`}${req.url}`, {
      method: req.method,
      headers,
      ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
    }),
  )
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}).listen(port, host, () =>
  console.log(`bayarkit demo: http://${host}:${port}/ (${demo.gateways.size} fake gateways)`),
)
