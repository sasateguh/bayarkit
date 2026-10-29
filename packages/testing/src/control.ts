/**
 * A tiny HTTP control API in front of any fake gateway, so tests written in other languages (PHP/Laravel, Python, Go)
 * can drive it: mark a payment paid, and fetch the exact signed callback the real gateway would send.
 *
 *   GET  /health                   → { ok, gateway, url }
 *   POST /paid/<id>                → 204 (markPaid)
 *   POST /approve/<id>             → 204 (the buyer approves, nothing captured; PayPal only, 404 elsewhere)
 *   GET  /callback/<id>            → CallbackInput JSON { fields, rawBody, headers }
 *   GET  /callback/<id>/tampered   → the same callback with its signature altered
 *
 * Deliver the callback to your app as-is: POST `rawBody` with `headers` when `rawBody` is set (Stripe, CHIP), otherwise
 * POST `fields` as a form.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { FakeGateway } from './fakes/types.js'

export async function startControlServer(
  gateway: string,
  fake: FakeGateway,
  port = 0,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '')
    try {
      if (req.method === 'GET' && path === '/health') return send(200, { ok: true, gateway, url: fake.url })
      const paid = /^\/paid\/([^/]+)$/.exec(path)
      if (req.method === 'POST' && paid?.[1]) {
        fake.markPaid(paid[1])
        return send(204)
      }
      const approve = /^\/approve\/([^/]+)$/.exec(path)
      const approver = (fake as { approve?: unknown }).approve
      if (req.method === 'POST' && approve?.[1] && typeof approver === 'function') {
        approver.call(fake, approve[1])
        return send(204)
      }
      const cb = /^\/callback\/([^/]+)(\/tampered)?$/.exec(path)
      if (req.method === 'GET' && cb?.[1]) {
        const callback = fake.callbackFor(cb[1])
        return send(200, cb[2] ? fake.tamper(callback) : callback)
      }
      send(404, { error: 'unknown control route' })
    } catch (e) {
      send(404, { error: e instanceof Error ? e.message : String(e) })
    }
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
