// The README promise, checked: the same two handlers from checkout.ts work for every gateway, with only the adapter
// changed. Each gateway's fake + adapter comes from scripts/smoke/<id>.mjs (the packed-tarball smoke uses the same files).
import { readdirSync } from 'node:fs'
import type { CallbackInput } from '@bayarkit/core'
import * as testing from '@bayarkit/testing'
import { describe, expect, it } from 'vitest'
import { type Order, paymentRoutes } from '../checkout.js'

const smoke = new URL('../../../scripts/smoke/', import.meta.url)
const gateways = readdirSync(smoke)
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => f.slice(0, -4))

// A callback as the gateway would POST it. Fakes of form-posting gateways give fields only; send those url-encoded.
const post = (path: string, cb: CallbackInput) =>
  cb.rawBody
    ? new Request(`https://shop.example${path}`, { method: 'POST', headers: cb.headers, body: cb.rawBody })
    : new Request(`https://shop.example${path}`, { method: 'POST', body: new URLSearchParams(cb.fields) })

describe.each(gateways)('examples/web-standard with %s', (id) => {
  it('checks out, refuses a forged and an early callback, then confirms the paid one', async () => {
    const { default: setup } = await import(new URL(`${id}.mjs`, smoke).href)
    const { fake, gateway } = await setup(testing)
    try {
      const orders = new Map<string, Order>()
      const routes = paymentRoutes(gateway, orders)
      const sent = await routes.checkout(
        new Request('https://shop.example/checkout', {
          method: 'POST',
          body: JSON.stringify({ amount: 1500, name: 'Ali', email: 'ali@example.com' }),
        }),
      )
      expect([200, 303]).toContain(sent.status)
      const [order] = [...orders.values()]
      expect(order?.paymentId).toBeTruthy()
      const paymentId = order?.paymentId ?? ''

      expect((await routes.callback(post('/cb', fake.tamper(fake.callbackFor(paymentId))))).status).toBe(404)
      await routes.callback(post('/cb', fake.callbackFor(paymentId)))
      expect(order?.status).toBe('unpaid')

      fake.markPaid(paymentId)
      expect((await routes.callback(post('/cb', fake.callbackFor(paymentId)))).status).toBe(200)
      expect(order?.status).toBe('paid')
    } finally {
      await fake.close()
    }
  })
})
