// The demo end to end, for EVERY gateway: pay → paid; signed callback without payment → not paid; forged → refused.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startDemo } from '../app.mjs'

let demo
beforeAll(async () => {
  demo = await startDemo()
}, 60_000)
afterAll(() => demo?.close())

const base = 'http://demo.test'
const get = (path) => demo.handle(new Request(base + path))
const post = (path, fields) =>
  demo.handle(
    new Request(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  )

async function order(gateway, action, prefix = '') {
  const created = await post(`${prefix}/checkout`, { gateway, amount: '2.50' })
  expect(created.status, `${gateway} checkout`).toBe(303)
  const payPath = new URL(created.headers.get('location')).pathname
  const payPage = await (await get(payPath)).text()
  expect(payPage).toContain('RM2.50')
  const paid = await post(payPath, { action })
  expect(paid.status).toBe(303)
  return (await get(new URL(paid.headers.get('location')).pathname)).text()
}

describe('demo', () => {
  it('lists every adapter from the registry', async () => {
    const html = await (await get('/')).text()
    expect(demo.gateways.size).toBeGreaterThanOrEqual(14)
    for (const id of demo.gateways.keys()) expect(html).toContain(`value="${id}"`)
  })

  it('runs all three scenarios on every gateway and only "pay" ends paid', async () => {
    for (const id of demo.gateways.keys()) {
      const paid = await order(id, 'pay')
      expect(paid, `${id} pay`).toContain('class="status paid"')
      const replay = await order(id, 'decline')
      expect(replay, `${id} decline`).toContain('class="status notPaid"')
      expect(replay).toContain('gateway kata belum dibayar')
      const forged = await order(id, 'forge')
      expect(forged, `${id} forge`).toContain('class="status notPaid"')
      expect(forged).toContain('tandatangan tidak sah')
    }
  }, 120_000)

  it('speaks English under /en and Malay at /', async () => {
    expect(await (await get('/')).text()).toContain('<html lang="ms"')
    const en = await order('toyyibpay', 'pay', '/en')
    expect(en).toContain('<html lang="en"')
    expect(en).toContain('The order is marked paid because the gateway itself confirmed')
  })

  it('refuses a bad amount or one below the gateway minimum, and escapes what it echoes', async () => {
    const bad = await post('/checkout', { gateway: 'toyyibpay', amount: '"><script>x</script>' })
    expect(bad.status).toBe(400)
    const html = await bad.text()
    expect(html).not.toContain('<script>x')
    expect(html).toContain('&quot;&gt;&lt;script&gt;')
    const low = await post('/checkout', { gateway: 'toyyibpay', amount: '0.50' })
    expect(await low.text()).toContain('RM1.00')
    expect((await post('/checkout', { gateway: 'nope', amount: '1' })).status).toBe(400)
  })

  it('a callback posted by a stranger never marks an order paid', async () => {
    const created = await post('/checkout', { gateway: 'toyyibpay', amount: '1.00' })
    const ref = new URL(created.headers.get('location')).pathname.split('/').pop()
    await post(`/callback/${ref}`, { billcode: 'x', status_id: '1', order_id: ref, hash: 'f'.repeat(32) })
    expect(await (await get(`/order/${ref}`)).text()).toContain('class="status notPaid"')
  })

  it('serves pages with no script allowed and noindex', async () => {
    const res = await get('/')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('content-security-policy')).not.toContain('script-src')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect((await get('/order/NOPE')).status).toBe(404)
  })
})
