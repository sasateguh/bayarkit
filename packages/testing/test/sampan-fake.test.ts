import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import cli from '../src/cli/sampan.js'
import { startControlServer } from '../src/control.js'
import { type FakeSampan, type SampanInvoice, sampanSignature, startFakeSampan } from '../src/fakes/sampan.js'

const SECRET = `whsec_${Buffer.from('fake sampan merchant secret 32b!').toString('base64')}`
const MERCHANT = `bitcoincash:z${'q'.repeat(41)}`
const RATE = 200_000 // sats per USD in the fake

type Json = Record<string, unknown>

/** Standard Webhooks verification written from the spec, independently of the fake's signer. */
function standardVerify(secret: string, headers: Record<string, string>, body: string): boolean {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key)
    .update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`)
    .digest('base64')
  return (headers['webhook-signature'] ?? '').split(' ').some((s) => s === `v1,${expected}`)
}

describe('fake Sampan Pay (invoice API, Standard Webhooks)', () => {
  let fake: FakeSampan
  beforeAll(async () => {
    fake = await startFakeSampan({ satsPerUsd: RATE, minUsd: '0.10', maxUsd: '500.00', validMinutes: 30 })
  })
  afterAll(() => fake.close())

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${fake.url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
          }),
    })
    return { status: res.status, json: (await res.json()) as Json }
  }
  const create = async (extra: Json = {}) => {
    const r = await call('POST', '/api/pay/invoice', {
      usd: '10.50',
      merchantAddress: MERCHANT,
      webhookUrl: 'https://shop.example/hook',
      webhookSecret: SECRET,
      orderId: 'ORDER-1',
      ...extra,
    })
    return r
  }
  const read = async (id: string) =>
    (await call('GET', `/api/pay/invoice/${id}`)).json as unknown as SampanInvoice

  it('creates an invoice: 201 with a BCH address, BIP21, status page and the sats it needs', async () => {
    const { status, json } = await create()
    expect(status).toBe(201)
    expect(json.id).toMatch(/^[0-9a-f]{32}$/)
    expect(json.address).toMatch(/^bitcoincash:p/)
    expect(json.requiredSats).toBe(10.5 * RATE)
    expect(json.bip21).toBe(`${json.address}?amount=0.021`)
    expect(json.statusUrl).toBe(`${fake.url}/pay/i/${json.id}`)
    expect(json.qrSvgUrl).toBe(`${fake.url}/api/pay/invoice/${json.id}/qr.svg`)
    expect(Date.parse(String(json.expiresAt)) - Date.now()).toBeGreaterThan(29 * 60_000)
    // The merchant sent its own secret, so Sampan does not answer one.
    expect(json.webhookSecret).toBeUndefined()
    const inv = await read(String(json.id))
    expect(inv).toMatchObject({
      id: json.id,
      status: 'open',
      usd: '10.50',
      orderId: 'ORDER-1',
      payments: [],
      convert: [],
    })
    expect(inv.merchantAddress).toBe(MERCHANT)
  })

  it('every invoice gets its own address', async () => {
    const a = (await create()).json
    const b = (await create()).json
    expect(a.address).not.toBe(b.address)
    expect(a.id).not.toBe(b.id)
  })

  it('generates a whsec_ secret, answered once, when a webhook URL comes without one', async () => {
    const { json } = await create({ webhookSecret: undefined })
    expect(json.webhookSecret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/)
    expect(await read(String(json.id))).not.toHaveProperty('webhookSecret')
    const cb = fake.callbackFor(String(json.id))
    expect(standardVerify(String(json.webhookSecret), cb.headers, cb.rawBody)).toBe(true)
  })

  it.each([
    [{ usd: 10.5 }, 'bad_request'],
    [{ usd: '10.505' }, 'bad_request'],
    [{ usd: '0.05' }, 'amount_out_of_range'],
    [{ usd: '500.01' }, 'amount_out_of_range'],
    [{ merchantAddress: 'bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' }, 'bad_address'],
    [{ merchantAddress: undefined }, 'bad_request'],
    [{ webhookUrl: 'http://shop.example/hook' }, 'bad_webhook_url'],
    [{ webhookUrl: 'https://127.0.0.1/hook' }, 'bad_webhook_url'],
    [{ webhookUrl: 'https://169.254.169.254/latest' }, 'bad_webhook_url'],
    [{ webhookSecret: 'plain-secret' }, 'bad_request'],
    [{ amountCents: 1050 }, 'bad_request'],
  ])('refuses %j with 400 %s', async (extra, error) => {
    const { status, json } = await create(extra)
    expect(status).toBe(400)
    expect(json.error).toBe(error)
    expect(typeof json.message).toBe('string')
  })

  it('refuses a body that is not JSON', async () => {
    expect((await call('POST', '/api/pay/invoice', 'usd=1')).status).toBe(400)
  })

  it('answers 404 not_found for an unknown invoice', async () => {
    const { status, json } = await call('GET', `/api/pay/invoice/${'0'.repeat(32)}`)
    expect(status).toBe(404)
    expect(json.error).toBe('not_found')
  })

  it('markPaid: one BCH payment of the required sats, converted to the invoice USD in PUSD', async () => {
    const id = String((await create()).json.id)
    fake.markPaid(id)
    const inv = await read(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments).toEqual([{ txid: expect.stringMatching(/^[0-9a-f]{64}$/), sats: 10.5 * RATE }])
    expect(inv.convert).toEqual([{ txid: expect.stringMatching(/^[0-9a-f]{64}$/), pusd: '10.50' }])
  })

  it('a payment not converted yet leaves the invoice open', async () => {
    const id = String((await create()).json.id)
    fake.pay(id, 10.5 * RATE, { converted: false })
    const inv = await read(id)
    expect(inv.status).toBe('open')
    expect(inv.payments).toHaveLength(1)
    expect(inv.convert).toEqual([])
  })

  it('short of the tolerance = underpaid; over it = overpaid; within it = paid; payments add up', async () => {
    const t = await startFakeSampan({ satsPerUsd: RATE, underToleranceBps: 100, overToleranceBps: 100 })
    try {
      const make = async () => {
        const r = await fetch(`${t.url}/api/pay/invoice`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ usd: '1.00', merchantAddress: MERCHANT }),
        })
        return String(((await r.json()) as Json).id)
      }
      const status = async (id: string) =>
        ((await (await fetch(`${t.url}/api/pay/invoice/${id}`)).json()) as SampanInvoice).status
      const under = await make()
      t.pay(under, 0.98 * RATE)
      expect(await status(under)).toBe('underpaid')
      t.pay(under, 0.02 * RATE)
      expect(await status(under)).toBe('paid')
      const within = await make()
      t.pay(within, 0.995 * RATE)
      expect(await status(within)).toBe('paid')
      const over = await make()
      t.pay(over, 1.02 * RATE)
      expect(await status(over)).toBe('overpaid')
      const read2 = (await (await fetch(`${t.url}/api/pay/invoice/${over}`)).json()) as SampanInvoice
      expect(read2.convert[0]?.pusd).toBe('1.02')
    } finally {
      await t.close()
    }
  })

  it('expire: unpaid = expired; a payment after expiresAt = paid_late', async () => {
    const id = String((await create()).json.id)
    fake.expire(id)
    expect((await read(id)).status).toBe('expired')
    fake.markPaid(id)
    expect((await read(id)).status).toBe('paid_late')
  })

  it('callbackFor: a Standard Webhooks invoice.paid event over the exact body, even before markPaid', async () => {
    const id = String((await create()).json.id)
    const cb = fake.callbackFor(id)
    expect(cb.fields).toEqual({})
    expect(cb.headers['webhook-id']).toMatch(/^msg_[0-9a-f]+$/)
    expect(Number(cb.headers['webhook-timestamp'])).toBeCloseTo(Date.now() / 1000, -1)
    expect(cb.headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/)
    expect(standardVerify(SECRET, cb.headers, cb.rawBody)).toBe(true)
    const event = JSON.parse(cb.rawBody) as { type: string; timestamp: string; data: SampanInvoice }
    expect(event.type).toBe('invoice.paid')
    expect(event.data).toMatchObject({ id, status: 'paid', usd: '10.50', orderId: 'ORDER-1' })
    expect(Date.parse(event.timestamp)).not.toBeNaN()
    // The fake's own record is untouched.
    expect((await read(id)).status).toBe('open')
    // Indented, so a handler that re-serialises the parsed JSON gets different bytes.
    expect(cb.rawBody).toContain('\n  ')
  })

  it('callbackFor override: type changes the event, other keys change data before signing', async () => {
    const id = String((await create()).json.id)
    const cb = fake.callbackFor(id, { type: 'underpaid', usd: '0.01' })
    const event = JSON.parse(cb.rawBody) as { type: string; data: SampanInvoice }
    expect(event.type).toBe('invoice.underpaid')
    expect(event.data).toMatchObject({ status: 'underpaid', usd: '0.01' })
    expect(standardVerify(SECRET, cb.headers, cb.rawBody)).toBe(true)
  })

  it('tamper breaks the signature and nothing else; the same id signs the same message on a retry', async () => {
    const id = String((await create()).json.id)
    const cb = fake.callbackFor(id)
    const bad = fake.tamper(cb)
    expect(bad.rawBody).toBe(cb.rawBody)
    expect(bad.headers['webhook-id']).toBe(cb.headers['webhook-id'])
    expect(standardVerify(SECRET, bad.headers, bad.rawBody)).toBe(false)
    expect(fake.callbackFor(id).headers['webhook-id']).toBe(cb.headers['webhook-id'])
  })

  it('sampanSignature matches an HMAC computed by hand from the spec', () => {
    const key = Buffer.from(SECRET.slice(6), 'base64')
    const hand = createHmac('sha256', key).update('msg_1.1700000000.{"a":1}').digest('base64')
    expect(sampanSignature(SECRET, 'msg_1', 1700000000, '{"a":1}')).toBe(`v1,${hand}`)
  })

  it('records every request', async () => {
    const before = fake.requests.length
    await create()
    expect(fake.requests.slice(before)).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/api/pay/invoice',
        body: expect.stringContaining('"usd"'),
      }),
    ])
  })

  it('pay: off = every /api/pay route answers 404 flow_closed', async () => {
    const off = await startFakeSampan({ pay: false })
    try {
      const r = await fetch(`${off.url}/api/pay/invoice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usd: '1.00', merchantAddress: MERCHANT }),
      })
      expect(r.status).toBe(404)
      expect(((await r.json()) as Json).error).toBe('flow_closed')
    } finally {
      await off.close()
    }
  })

  it('invoicesPerHour: the next invoice is 429 rate_limited', async () => {
    const t = await startFakeSampan({ invoicesPerHour: 1 })
    try {
      const post = () =>
        fetch(`${t.url}/api/pay/invoice`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ usd: '1.00', merchantAddress: MERCHANT }),
        })
      expect((await post()).status).toBe(201)
      const r = await post()
      expect(r.status).toBe(429)
      expect(((await r.json()) as Json).error).toBe('rate_limited')
    } finally {
      await t.close()
    }
  })
})

describe('bayarkit-fake sampan (control API)', () => {
  it('serves the fake with test defaults; the control API marks paid and hands out the signed callback', async () => {
    const fake = await cli.start({ ...cli.defaults })
    const control = await startControlServer('sampan', fake)
    try {
      expect(await (await fetch(`${control.url}/health`)).json()).toMatchObject({
        ok: true,
        gateway: 'sampan',
      })
      const r = await fetch(`${fake.url}/api/pay/invoice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          usd: '1.00',
          merchantAddress: MERCHANT,
          webhookUrl: 'https://shop.example/hook',
        }),
      })
      const created = (await r.json()) as Json
      // No secret sent: the fake answers the CLI's, so a test in any language knows it in advance.
      expect(created.webhookSecret).toBe(cli.defaults.webhookSecret)
      expect((await fetch(`${control.url}/paid/${created.id}`, { method: 'POST' })).status).toBe(204)
      const inv = (await (await fetch(`${fake.url}/api/pay/invoice/${created.id}`)).json()) as SampanInvoice
      expect(inv.status).toBe('paid')
      const cb = (await (await fetch(`${control.url}/callback/${created.id}`)).json()) as {
        rawBody: string
        headers: Record<string, string>
      }
      expect(standardVerify(String(cli.defaults.webhookSecret), cb.headers, cb.rawBody)).toBe(true)
    } finally {
      await control.close()
      await fake.close()
    }
  })
})
