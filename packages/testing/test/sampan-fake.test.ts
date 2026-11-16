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
      usd: 10.5,
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

  it('creates an invoice: 200 with a BCH address, BIP21, status page and the sats it needs', async () => {
    const { status, json } = await create()
    expect(status).toBe(200)
    expect(json.id).toMatch(/^[0-9a-f]{32}$/)
    expect(json.address).toMatch(/^bitcoincash:p/)
    // Measured on the live API (16 Nov 2026): sats as a decimal string, the dollars echoed with two decimals.
    expect(json.requiredSats).toBe(String(10.5 * RATE))
    expect(json.usd).toBe('10.50')
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
      returnUrl: null,
      requiredSats: String(10.5 * RATE),
      paidSats: '0',
      bip21: json.bip21,
      expiresAt: json.expiresAt,
      payments: [],
      convert: [],
      webhook: { state: 'pending', attempts: 0 },
    })
    expect(Date.parse(String(inv.createdAt))).not.toBeNaN()
    // The live GET answer does not echo the merchant address.
    expect(inv).not.toHaveProperty('merchantAddress')
  })

  it('without a webhook URL, orderId is null and the webhook state is none', async () => {
    const { json } = await create({ webhookUrl: undefined, webhookSecret: undefined, orderId: undefined })
    expect(json.webhookSecret).toBeUndefined()
    expect(await read(String(json.id))).toMatchObject({
      orderId: null,
      webhook: { state: 'none', attempts: 0 },
    })
  })

  it('takes usd as a JSON number, or a numeric string the server coerces (both measured)', async () => {
    expect((await create({ usd: '0.20' })).json).toMatchObject({
      usd: '0.20',
      requiredSats: String(0.2 * RATE),
    })
    expect((await create({ usd: 3 })).json.usd).toBe('3.00')
  })

  it('default limits are the live site: USD 0.20 to 250', async () => {
    const t = await startFakeSampan()
    try {
      const post = async (usd: unknown) => {
        const r = await fetch(`${t.url}/api/pay/invoice`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ usd, merchantAddress: MERCHANT }),
        })
        return [r.status, ((await r.json()) as Json).error]
      }
      expect(await post(0.19)).toEqual([400, 'below_min'])
      expect(await post(250.01)).toEqual([400, 'above_max'])
      expect((await post(0.2))[0]).toBe(200)
      expect((await post(250))[0]).toBe(200)
    } finally {
      await t.close()
    }
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

  // Error words as the live API answered them (16 Nov 2026). Schema failures come from the web framework:
  // `{statusCode, code: 'FST_ERR_VALIDATION', error: 'Bad Request', message}`; Sampan's own checks: `{error, message}`.
  const SCHEMA = 'Bad Request'
  it.each([
    [{ usd: 'ten' }, SCHEMA],
    [{ usd: 10.505 }, 'bad_request'],
    [{ usd: 0.05 }, 'below_min'],
    [{ usd: '0.05' }, 'below_min'],
    [{ usd: 500.01 }, 'above_max'],
    [{ merchantAddress: 'bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' }, 'bad_request'],
    [{ merchantAddress: undefined }, SCHEMA],
    [{ webhookUrl: 'http://shop.example/hook' }, 'bad_request'],
    [{ webhookUrl: 'https://127.0.0.1/hook' }, 'bad_request'],
    [{ webhookUrl: 'https://169.254.169.254/latest' }, 'bad_request'],
    [{ webhookSecret: 'plain-secret' }, 'bad_request'],
    [{ webhookSecret: `whsec_${Buffer.alloc(16, 7).toString('base64')}` }, 'bad_request'],
    [{ webhookUrl: undefined }, 'bad_request'],
    [{ returnUrl: 'http://shop.example/done' }, 'bad_request'],
    [{ orderId: 'has space' }, SCHEMA],
    [{ amountCents: 1050 }, SCHEMA],
  ])('refuses %j with 400 %s', async (extra, error) => {
    const { status, json } = await create(extra)
    expect(status).toBe(400)
    expect(json.error).toBe(error)
    expect(typeof json.message).toBe('string')
    if (error === SCHEMA) expect(json).toMatchObject({ statusCode: 400, code: 'FST_ERR_VALIDATION' })
  })

  it('refuses a body that is not JSON', async () => {
    expect((await call('POST', '/api/pay/invoice', 'usd=1')).status).toBe(400)
  })

  it('answers 404 not_found for an unknown invoice, and 400 for an id that is not 32 hex digits', async () => {
    const { status, json } = await call('GET', `/api/pay/invoice/${'0'.repeat(32)}`)
    expect(status).toBe(404)
    expect(json).toEqual({ error: 'not_found', message: 'unknown invoice' })
    const bad = await call('GET', '/api/pay/invoice/XYZ')
    expect(bad.status).toBe(400)
    expect(bad.json).toMatchObject({ code: 'FST_ERR_VALIDATION', error: 'Bad Request' })
  })

  it('markPaid: one BCH payment of the required sats, converted to the invoice USD in PUSD', async () => {
    const id = String((await create()).json.id)
    fake.markPaid(id)
    const inv = await read(id)
    expect(inv.status).toBe('paid')
    expect(inv.paidSats).toBe(String(10.5 * RATE))
    expect(inv.payments).toEqual([
      { txid: expect.stringMatching(/^[0-9a-f]{64}$/), sats: String(10.5 * RATE) },
    ])
    expect(inv.convert).toEqual([{ txid: expect.stringMatching(/^[0-9a-f]{64}$/), pusd: '10.50' }])
  })

  it('a payment counts as soon as it is seen: paid before the conversion, convert still empty', async () => {
    const id = String((await create()).json.id)
    fake.pay(id, 10.5 * RATE, { converted: false })
    const inv = await read(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments).toHaveLength(1)
    expect(inv.convert).toEqual([])
  })

  it('two payments add up to paid while only the first is converted', async () => {
    const id = String((await create()).json.id)
    fake.pay(id, 5 * RATE)
    fake.pay(id, 5.5 * RATE, { converted: false })
    const inv = await read(id)
    expect(inv.status).toBe('paid')
    expect(inv.payments).toHaveLength(2)
    expect(inv.convert).toHaveLength(1)
  })

  it('default tolerances are the live config: 50 bps under, 100 bps over', async () => {
    const t = await startFakeSampan({ satsPerUsd: RATE })
    try {
      const make = async () => {
        const r = await fetch(`${t.url}/api/pay/invoice`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ usd: 1, merchantAddress: MERCHANT }),
        })
        return String(((await r.json()) as Json).id)
      }
      const status = async (id: string) =>
        ((await (await fetch(`${t.url}/api/pay/invoice/${id}`)).json()) as SampanInvoice).status
      const cases: [number, string][] = [
        [0.9949, 'underpaid'],
        [0.995, 'paid'],
        [1.01, 'paid'],
        [1.0101, 'overpaid'],
      ]
      for (const [usd, want] of cases) {
        const id = await make()
        t.pay(id, usd * RATE)
        expect(await status(id)).toBe(want)
      }
    } finally {
      await t.close()
    }
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
    // Late counts from the first payment seen, whatever its size.
    const short = String((await create()).json.id)
    fake.expire(short)
    fake.pay(short, RATE)
    expect((await read(short)).status).toBe('paid_late')
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
    // The delivery state is not part of the event.
    expect(event.data).not.toHaveProperty('webhook')
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

  it('pay: off = every /api/pay route answers 404 not_found', async () => {
    const off = await startFakeSampan({ pay: false })
    try {
      const r = await fetch(`${off.url}/api/pay/invoice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usd: '1.00', merchantAddress: MERCHANT }),
      })
      expect(r.status).toBe(404)
      expect(await r.json()).toEqual({ error: 'not_found', message: 'not found' })
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
      expect((await post()).status).toBe(200)
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
