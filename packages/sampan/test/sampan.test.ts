import { type CallbackInput, confirmPayment, GatewayError } from '@bayarkit/core'
import {
  type FakeSampan,
  gatewayConformance,
  sampanSignature,
  sampleInput,
  startFakeSampan,
} from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dollars, info, sampan, verifySampanSignature } from '../src/index.js'

const SECRET = `whsec_${Buffer.from('bayarkit sampan adapter test 32b').toString('base64')}`
const MERCHANT = `bitcoincash:z${'q'.repeat(41)}`
const config = { webhookSecret: SECRET, merchantAddress: MERCHANT }

gatewayConformance('sampan', async () => {
  const fake = await startFakeSampan()
  return { fake, gateway: sampan({ ...config, baseUrl: fake.url }) }
})

describe('sampan: Standard Webhooks signatures', () => {
  // The example from the Standard Webhooks specification (and Svix's docs), re-computed with Node crypto.
  // Joined from two halves only so secret scanners do not mistake this published vector for a key.
  const KEY = ['MfKQ9r8GKYqrTwjU', 'PD8ILPZIo2LaLaSw'].join('')
  const v = {
    secret: `whsec_${KEY}`,
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    ts: 1614265330,
    body: '{"test": 2432232314}',
    sig: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  }
  const h = (over: Partial<{ id: string; ts: string; sig: string }> = {}) => ({
    id: v.id,
    timestamp: String(v.ts),
    signature: v.sig,
    ...(over.id === undefined ? {} : { id: over.id }),
    ...(over.ts === undefined ? {} : { timestamp: over.ts }),
    ...(over.sig === undefined ? {} : { signature: over.sig }),
  })
  const at = (s: number) => s * 1000

  it("accepts the specification's own example", () => {
    expect(verifySampanSignature(v.body, h(), v.secret, 300, at(v.ts))).toBe(true)
  })

  it('refuses it when one byte of the body, the id or the timestamp changes', () => {
    expect(verifySampanSignature(v.body.replace('2', '3'), h(), v.secret, 300, at(v.ts))).toBe(false)
    expect(verifySampanSignature(v.body, h({ id: `${v.id}x` }), v.secret, 300, at(v.ts))).toBe(false)
    expect(verifySampanSignature(v.body, h({ ts: String(v.ts + 1) }), v.secret, 300, at(v.ts))).toBe(false)
  })

  it('refuses a timestamp outside the tolerance, older or in the future', () => {
    expect(verifySampanSignature(v.body, h(), v.secret, 300, at(v.ts + 301))).toBe(false)
    expect(verifySampanSignature(v.body, h(), v.secret, 300, at(v.ts - 301))).toBe(false)
    expect(verifySampanSignature(v.body, h(), v.secret, 300, at(v.ts + 300))).toBe(true)
    expect(verifySampanSignature(v.body, h(), v.secret, 300, at(v.ts - 300))).toBe(true)
  })

  it('accepts any of several space-separated signatures (secret rotation), ignores other versions', () => {
    const other = 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    expect(verifySampanSignature(v.body, h({ sig: `${other} ${v.sig}` }), v.secret, 300, at(v.ts))).toBe(true)
    const v1a = v.sig.replace(/^v1,/, 'v1a,')
    expect(verifySampanSignature(v.body, h({ sig: v1a }), v.secret, 300, at(v.ts))).toBe(false)
  })

  it('refuses a missing header, a timestamp that is not a whole number, or a wrong secret', () => {
    expect(verifySampanSignature(v.body, h({ id: '' }), v.secret, 300, at(v.ts))).toBe(false)
    expect(verifySampanSignature(v.body, h({ sig: '' }), v.secret, 300, at(v.ts))).toBe(false)
    expect(verifySampanSignature(v.body, h({ ts: `${v.ts}.0` }), v.secret, 300, at(v.ts))).toBe(false)
    expect(verifySampanSignature(v.body, h({ ts: '9'.repeat(400) }), v.secret, 300, at(v.ts))).toBe(false)
    expect(verifySampanSignature(v.body, h(), SECRET, 300, at(v.ts))).toBe(false)
  })
})

describe('sampan: the adapter against the fake', () => {
  let fake: FakeSampan
  let clock = Date.now
  beforeAll(async () => {
    fake = await startFakeSampan({ satsPerUsd: 200_000 })
  })
  afterAll(() => fake.close())
  const gw = (over: Record<string, unknown> = {}) =>
    sampan({ ...config, baseUrl: fake.url, now: () => clock(), ...over })
  const lastBody = () => JSON.parse(fake.requests.at(-1)?.body ?? '{}') as Record<string, unknown>

  it('sends the amount as a JSON number of dollars, the reference as orderId, and the one merchant secret', async () => {
    const input = sampleInput({ amount: 20 })
    const created = await gw().createPayment(input)
    // The live schema types usd as a number (a string only passes by coercion, measured 16 Nov 2026).
    expect(fake.requests.at(-1)?.body).toContain('"usd":0.2,')
    expect(lastBody()).toEqual({
      usd: 0.2,
      merchantAddress: MERCHANT,
      orderId: input.reference,
      webhookUrl: input.callbackUrl,
      webhookSecret: SECRET,
      returnUrl: input.returnUrl,
    })
    expect(created.url).toBe(`${fake.url}/pay/i/${created.id}`)
    expect(JSON.stringify(created.raw)).not.toContain('whsec_')
    expect((created.raw as { bip21: string }).bip21).toMatch(/^bitcoincash:p/)
  })

  it('turns cents into dollars exactly', () => {
    expect([1, 10, 99, 100, 1050, 123456].map(dollars)).toEqual([
      '0.01',
      '0.10',
      '0.99',
      '1.00',
      '10.50',
      '1234.56',
    ])
  })

  it('charges USD only, refused before calling Sampan', async () => {
    const before = fake.requests.length
    for (const currency of ['MYR', 'usd', 'BCH']) {
      await expect(gw().createPayment(sampleInput({ currency }))).rejects.toMatchObject({ code: 'CURRENCY' })
    }
    expect(fake.requests.length).toBe(before)
    expect(gw().info.currency).toBe('USD')
    expect(info.evidence.kind).toBe('docs')
  })

  it('reads the invoice: reference, amount in cents, USD, the invoice address in raw', async () => {
    const input = sampleInput({ amount: 1050 })
    const created = await gw().createPayment(input)
    const record = await gw().getPayment(created.id)
    expect(record).toMatchObject({ id: created.id, reference: input.reference, status: 'pending' })
    expect(record.amount).toBe(1050)
    expect(record.currency).toBe('USD')
    expect((record.raw as { address: string }).address).toMatch(/^bitcoincash:p/)
  })

  const invoice = async (amount = 1050) => {
    const input = sampleInput({ amount })
    const created = await gw().createPayment(input)
    const raw = created.raw as { requiredSats: number }
    return { input, id: created.id, sats: raw.requiredSats }
  }

  it('an underpaid invoice is pending, never paid, and confirmPayment refuses it', async () => {
    const { input, id, sats } = await invoice()
    // Short by more than Sampan's 50 bps tolerance.
    fake.pay(id, Math.floor(sats * 0.99))
    expect((await gw().getPayment(id)).status).toBe('pending')
    expect((await gw().getPayment(id)).raw).toMatchObject({ status: 'underpaid' })
    expect(await confirmPayment(gw(), fake.callbackFor(id), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
    })
  })

  it('a payment Sampan has seen but not yet converted to PUSD is pending', async () => {
    const { input, id, sats } = await invoice()
    fake.pay(id, sats, { converted: false })
    expect((await gw().getPayment(id)).status).toBe('pending')
    expect(await confirmPayment(gw(), fake.callbackFor(id), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
    })
  })

  it('an overpaid invoice is paid for the invoice amount', async () => {
    const { input, id, sats } = await invoice()
    fake.pay(id, sats * 2)
    const result = await confirmPayment(gw(), fake.callbackFor(id, { type: 'overpaid' }), input)
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.payment.amount).toBe(input.amount)
  })

  it('a payment after expiry (paid_late) is paid: the PUSD reached the merchant', async () => {
    const { input, id } = await invoice()
    fake.expire(id)
    fake.markPaid(id)
    expect((await gw().getPayment(id)).raw).toMatchObject({ status: 'paid_late' })
    expect(await confirmPayment(gw(), fake.callbackFor(id, { type: 'paid_late' }), input)).toMatchObject({
      ok: true,
    })
  })

  it('a SHORT payment after expiry is paid_late at Sampan, but pending here: paid_late ignores the amount', async () => {
    const { input, id, sats } = await invoice()
    fake.expire(id)
    fake.pay(id, Math.floor(sats / 2))
    const record = await gw().getPayment(id)
    expect(record.raw).toMatchObject({ status: 'paid_late' })
    expect(record.status).toBe('pending')
    expect(await confirmPayment(gw(), fake.callbackFor(id, { type: 'paid_late' }), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
    })
  })

  it('an unpaid invoice past its time is expired', async () => {
    const { id } = await invoice()
    fake.expire(id)
    expect((await gw().getPayment(id)).status).toBe('expired')
  })

  it('two payments add up to paid, but only one is converted yet: pending until both are', async () => {
    const { input, id, sats } = await invoice()
    fake.pay(id, Math.floor(sats / 2))
    fake.pay(id, Math.ceil(sats / 2), { converted: false })
    const record = await gw().getPayment(id)
    expect(record.raw).toMatchObject({ status: 'paid' })
    expect(record.status).toBe('pending')
    expect(await confirmPayment(gw(), fake.callbackFor(id), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
    })
  })

  it('the smallest invoice is the live minimum, USD 0.20, refused before calling Sampan', async () => {
    expect(info.minimumAmount).toBe(20)
    expect(gw().info.minimumAmount).toBe(20)
    const before = fake.requests.length
    await expect(gw().createPayment(sampleInput({ amount: 19 }))).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    })
    expect(fake.requests.length).toBe(before)
    await expect(gw().createPayment(sampleInput({ amount: 20 }))).resolves.toMatchObject({
      id: expect.any(String),
    })
  })

  it('"paid" without a PUSD conversion on record is not paid', async () => {
    const { id } = await invoice()
    fake.markPaid(id)
    const fetchNoConvert: typeof fetch = async (url, init) => {
      const res = await fetch(url, init)
      const json = (await res.json()) as Record<string, unknown>
      return new Response(JSON.stringify({ ...json, convert: [] }), { status: res.status })
    }
    expect((await gw({ fetch: fetchNoConvert }).getPayment(id)).status).toBe('pending')
  })

  it('refuses a webhook older than the tolerance, and one with a byte of the body changed', async () => {
    const { id } = await invoice()
    const cb = fake.callbackFor(id)
    expect(gw().verifyCallback(cb)).not.toBeNull()
    clock = () => Date.now() + 301_000
    try {
      expect(gw().verifyCallback(cb)).toBeNull()
      expect(gw({ toleranceSeconds: 400 }).verifyCallback(cb)).not.toBeNull()
    } finally {
      clock = Date.now
    }
    const flipped = `${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}`
    const changed: CallbackInput = { ...cb, rawBody: cb.rawBody.replace(id, flipped) }
    expect(changed.rawBody).not.toBe(cb.rawBody)
    expect(gw().verifyCallback(changed)).toBeNull()
  })

  it('reads the webhook: invoice id, orderId, the claimed status, the webhook id in raw', async () => {
    const { input, id } = await invoice()
    const cb = fake.callbackFor(id, { type: 'underpaid' })
    const lower = Object.fromEntries(Object.entries(cb.headers).map(([k, x]) => [k.toUpperCase(), x]))
    const verified = gw().verifyCallback({ ...cb, headers: lower })
    expect(verified).toMatchObject({ id, reference: input.reference, claimedStatus: 'pending' })
    expect(verified?.raw).toMatchObject({ webhook_id: cb.headers['webhook-id'], type: 'invoice.underpaid' })
  })

  it("refuses a webhook signed with another merchant's secret", async () => {
    const { id } = await invoice()
    const cb = fake.callbackFor(id, { type: 'paid' })
    const other = gw({
      webhookSecret: `whsec_${Buffer.from('another secret, another merchant').toString('base64')}`,
    })
    expect(other.verifyCallback(cb)).toBeNull()
  })

  it('refuses a correctly signed event that is not about an invoice', async () => {
    const { id } = await invoice()
    const ts = Math.floor(Date.now() / 1000)
    for (const event of [
      { type: 'payout.sent', timestamp: new Date().toISOString(), data: { id, status: 'paid' } },
      { type: 'invoice.paid', timestamp: new Date().toISOString(), data: { id: '../x', status: 'paid' } },
    ]) {
      const rawBody = JSON.stringify(event)
      const headers = {
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(ts),
        'webhook-signature': sampanSignature(SECRET, 'msg_1', ts, rawBody),
      }
      expect(gw().verifyCallback({ fields: {}, rawBody, headers })).toBeNull()
    }
  })

  it('refuses a webhook secret that is not whsec_<base64>, without quoting it', () => {
    // Sampan refuses a key shorter than 24 bytes (measured), so the adapter does at start-up.
    const short = `whsec_${Buffer.alloc(23, 9).toString('base64')}`
    for (const webhookSecret of ['', 'hunter2-plain-secret', 'whsec_', 'whsec_!!!!not-base64!!!!', short]) {
      let err: unknown
      try {
        sampan({ ...config, webhookSecret })
      } catch (e) {
        err = e
      }
      expect(err, webhookSecret).toBeInstanceOf(GatewayError)
      expect((err as GatewayError).code).toBe('CONFIG')
      if (webhookSecret.length > 6) expect((err as Error).message).not.toContain(webhookSecret)
    }
    expect(() => sampan({ ...config, merchantAddress: '' })).toThrow(GatewayError)
  })

  it("quotes Sampan's error, never the secret", async () => {
    const bad = gw({ merchantAddress: 'bitcoincash:qnot-a-token-address' })
    const err = await bad.createPayment(sampleInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).toMatchObject({ status: 400, code: 'bad_request' })
    expect((err as Error).message).toContain('token-aware')
    expect((err as Error).message).not.toContain(SECRET.slice(6, 20))
  })

  it('masks a secret Sampan would echo in an error message', async () => {
    const echo: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: 'bad_request', message: `body/webhookSecret ${SECRET} refused` }),
        {
          status: 400,
        },
      )
    const err = (await gw({ fetch: echo })
      .createPayment(sampleInput())
      .catch((e: unknown) => e)) as Error
    expect(err.message).toContain('[redacted]')
    expect(err.message).not.toContain(SECRET.slice(6))
  })

  it('reports the closed pay flag (404 not_found) as an error with its code', async () => {
    const closed = await startFakeSampan({ pay: false })
    try {
      const err = await sampan({ ...config, baseUrl: closed.url })
        .createPayment(sampleInput())
        .catch((e: unknown) => e)
      expect(err).toMatchObject({ status: 404, code: 'not_found' })
    } finally {
      await closed.close()
    }
  })

  it('refuses an invoice id that could leave the path, before calling Sampan', async () => {
    const before = fake.requests.length
    // Live ids are 32 lowercase hex digits; anything else is refused here, not by Sampan's schema.
    for (const id of [
      '../health',
      'a/b',
      '',
      'x'.repeat(200),
      'A'.repeat(32),
      'a'.repeat(31),
      'z'.repeat(32),
    ]) {
      await expect(gw().getPayment(id)).rejects.toMatchObject({ code: 'INVALID_ID' })
    }
    expect(fake.requests.length).toBe(before)
  })
})
