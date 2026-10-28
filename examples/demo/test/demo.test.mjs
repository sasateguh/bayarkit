// The demo end to end, for EVERY gateway: pay → paid; signed callback without payment → not paid; forged → refused;
// another order's paid callback → mismatch.
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
  const payPath = created.headers.get('location')
  const payPage = await (await get(payPath)).text()
  expect(payPage).toContain('RM2.50')
  const paid = await post(payPath, { action })
  expect(paid.status).toBe(303)
  return (await get(paid.headers.get('location'))).text()
}

describe('demo', () => {
  it('lists every adapter from the registry', async () => {
    const html = await (await get('/')).text()
    expect(demo.gateways.size).toBeGreaterThanOrEqual(14)
    for (const id of demo.gateways.keys()) expect(html).toContain(`value="${id}"`)
  })

  it('runs all four scenarios on every gateway and only "pay" ends paid', async () => {
    for (const id of demo.gateways.keys()) {
      const paid = await order(id, 'pay')
      expect(paid, `${id} pay`).toContain('class="status paid"')
      const replay = await order(id, 'decline')
      expect(replay, `${id} decline`).toContain('class="status notPaid"')
      expect(replay).toContain('gateway kata belum dibayar')
      const forged = await order(id, 'forge')
      expect(forged, `${id} forge`).toContain('class="status notPaid"')
      expect(forged).toContain('tandatangan tidak sah')
      const swapped = await order(id, 'swap')
      expect(swapped, `${id} swap`).toContain('class="status notPaid"')
      expect(swapped, `${id} swap`).toContain('rujukan atau jumlahnya tidak sama')
      expect(swapped, `${id} swap`).toContain('class="step fail"')
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
    const ref = created.headers.get('location').split('/').pop()
    await post(`/callback/${ref}`, { billcode: 'x', status_id: '1', order_id: ref, hash: 'f'.repeat(32) })
    expect(await (await get(`/order/${ref}`)).text()).toContain('class="status notPaid"')
  })

  it('serves pages with no script allowed and noindex', async () => {
    const res = await get('/')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('content-security-policy')).not.toContain('script-src')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform')
    expect(await (await get('/healthz')).text()).toBe('ok')
    expect((await get('/order/NOPE')).status).toBe(404)
  })

  it('one choice per order: a second choice cannot turn a forged order into a paid one', async () => {
    const created = await post('/checkout', { gateway: 'toyyibpay', amount: '1.00' })
    const payPath = created.headers.get('location')
    await post(payPath, { action: 'forge' })
    const again = await post(payPath, { action: 'decline' })
    expect(again.status).toBe(303)
    const orderPath = again.headers.get('location')
    expect(await (await get(orderPath)).text()).toContain('tandatangan tidak sah')
    expect((await get(payPath)).headers.get('location')).toBe(orderPath)
  })

  it('redirects are relative (the Host header never decides) and references are unguessable', async () => {
    const created = await demo.handle(
      new Request('http://evil.example/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'evil.example' },
        body: 'gateway=eghl&amount=1.00',
      }),
    )
    const location = created.headers.get('location')
    expect(location).toMatch(/^\/pay\/DEMO[0-9A-F]{16}$/)
  })
})

describe('demo memory stays bounded', () => {
  it('rotates fakes and drops old orders', async () => {
    const small = await startDemo({ perGeneration: 5 })
    for (let i = 0; i < 23; i++) {
      const res = await small.handle(
        new Request('http://demo.test/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'gateway=toyyibpay&amount=1.00',
        }),
      )
      expect(res.status).toBe(303)
    }
    await small.settled()
    // Hard bound under any timing: at most 2 sets, each at most 2 × perGeneration (back-pressure while rotating).
    const { orders, generations } = small.stats()
    expect(generations).toBeLessThanOrEqual(2)
    expect(orders).toBeLessThanOrEqual(2 * 2 * 5)
    await small.close()
  }, 60_000)

  it('when rotation keeps failing it answers 503 instead of growing (and never retries on every request)', async () => {
    const net = await import('node:net')
    const small = await startDemo({ perGeneration: 2 })
    const listen = net.Server.prototype.listen
    net.Server.prototype.listen = () => {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
    }
    const errors = console.error
    let logged = 0
    console.error = () => {
      logged += 1
    }
    try {
      const statuses = []
      for (let i = 0; i < 8; i++) {
        const res = await small.handle(
          new Request('http://demo.test/checkout', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'gateway=toyyibpay&amount=1.00',
          }),
        )
        statuses.push(res.status)
        await small.settled()
      }
      expect(statuses.filter((s) => s === 303).length).toBe(4)
      expect(statuses.slice(4).every((s) => s === 503)).toBe(true)
      expect(small.stats().orders).toBe(4)
      expect(logged).toBe(1) // one failed attempt, then cooling down
    } finally {
      net.Server.prototype.listen = listen
      console.error = errors
    }
    await small.close()
  })

  it('holds the bound under 100 parallel checkouts', async () => {
    const small = await startDemo({ perGeneration: 5 })
    const one = () =>
      small.handle(
        new Request('http://demo.test/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'gateway=toyyibpay&amount=1.00',
        }),
      )
    const statuses = await Promise.all(Array.from({ length: 100 }, one).map((p) => p.then((r) => r.status)))
    expect(statuses.every((s) => s === 303)).toBe(true)
    await small.settled()
    const { orders, generations } = small.stats()
    expect(generations).toBeLessThanOrEqual(2)
    expect(orders).toBeLessThanOrEqual(2 * 2 * 5)
    await small.close()
  }, 120_000)
})
