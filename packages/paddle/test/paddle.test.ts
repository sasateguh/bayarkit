import { createHmac } from 'node:crypto'
import { type CallbackInput, confirmPayment, GatewayError } from '@bayarkit/core'
import { gatewayConformance, paddleSignature, sampleInput, startFakePaddle } from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PADDLE_VERSION, paddle, parseSignatureHeader, verifyPaddleSignature } from '../src/index.js'

const keys = { apiKey: 'pdl_sdbx_apikey_fake123', webhookSecret: 'pdl_ntfset_fakeSecret' }
const nowS = () => Math.floor(Date.now() / 1000)
const hmac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex')

gatewayConformance('paddle', async () => {
  const fake = await startFakePaddle(keys)
  return { fake, gateway: paddle({ ...keys, baseUrl: fake.url }) }
})

describe('paddle: webhook signatures (docs "verify signatures manually" + paddle-node-sdk)', () => {
  // The vector from paddle-node-sdk's own test suite (spec §4), re-computed with Node crypto.
  const vector = {
    secret: 'VALID_SECRET',
    body: '{"data": ["1", "2"]}',
    ts: 1698796800,
    h1: 'a300428748dce5c70e4da19bffd60769591ea969c99dea3105d0ec9612cf43f9',
  }

  it("accepts the SDK's own test vector", () => {
    expect(
      verifyPaddleSignature(
        vector.body,
        `ts=${vector.ts};h1=${vector.h1}`,
        vector.secret,
        5,
        vector.ts * 1000,
      ),
    ).toBe(true)
  })

  it('refuses the vector when one byte of the body changes, or the HMAC is over "<ts>.<body>"', () => {
    const header = `ts=${vector.ts};h1=${vector.h1}`
    expect(
      verifyPaddleSignature(vector.body.replace('1', '3'), header, vector.secret, 5, vector.ts * 1000),
    ).toBe(false)
    const dotted = `ts=${vector.ts};h1=${hmac(vector.secret, `${vector.ts}.${vector.body}`)}`
    expect(verifyPaddleSignature(vector.body, dotted, vector.secret, 5, vector.ts * 1000)).toBe(false)
  })

  it('refuses a stale ts (older than the tolerance), accepts it inside the tolerance', () => {
    const header = `ts=${vector.ts};h1=${vector.h1}`
    expect(verifyPaddleSignature(vector.body, header, vector.secret, 5, (vector.ts + 6) * 1000)).toBe(false)
    expect(verifyPaddleSignature(vector.body, header, vector.secret, 5, (vector.ts + 5) * 1000)).toBe(true)
  })

  it('accepts when ONE of several h1 values matches (secret rotation), refuses when none does', () => {
    const header = paddleSignature(['pdl_ntfset_old', vector.secret], vector.body, vector.ts)
    expect(parseSignatureHeader(header).signatures).toHaveLength(2)
    expect(verifyPaddleSignature(vector.body, header, vector.secret, 5, vector.ts * 1000)).toBe(true)
    const none = paddleSignature(['pdl_ntfset_old', 'pdl_ntfset_older'], vector.body, vector.ts)
    expect(verifyPaddleSignature(vector.body, none, vector.secret, 5, vector.ts * 1000)).toBe(false)
  })

  it('refuses headers without ts or h1, and an empty secret', () => {
    for (const header of ['', `h1=${vector.h1}`, `ts=${vector.ts}`, `ts=abc;h1=${vector.h1}`]) {
      expect(verifyPaddleSignature(vector.body, header, vector.secret, 5, vector.ts * 1000), header).toBe(
        false,
      )
    }
    expect(
      verifyPaddleSignature(vector.body, `ts=${vector.ts};h1=${vector.h1}`, '', 5, vector.ts * 1000),
    ).toBe(false)
  })

  it('refuses a tolerance of 0 or less when the gateway is created', () => {
    expect(() => paddle({ ...keys, toleranceSeconds: 0 })).toThrow(GatewayError)
  })
})

describe('paddle: against the fake', () => {
  let fake: Awaited<ReturnType<typeof startFakePaddle>>
  let gw: ReturnType<typeof paddle>
  beforeAll(async () => {
    fake = await startFakePaddle(keys)
    gw = paddle({ ...keys, baseUrl: fake.url })
  })
  afterAll(() => fake.close())

  it('pins Paddle-Version and sends an inclusive (tax_mode internal) non-catalog price as a string', async () => {
    const input = sampleInput({ amount: 1999 })
    const created = await gw.createPayment(input)
    const sent = fake.requests.at(-1)
    expect(sent?.headers['paddle-version']).toBe(PADDLE_VERSION)
    const body = sent?.body as {
      items: { quantity: number; price: Record<string, unknown> }[]
      custom_data: Record<string, unknown>
    }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.quantity).toBe(1)
    expect(body.items[0]?.price).toMatchObject({
      tax_mode: 'internal',
      unit_price: { amount: '1999', currency_code: 'USD' },
    })
    expect(body.custom_data).toEqual({ reference: input.reference })
    expect(created.url).toBe(`https://shop.example/pay?_ptxn=${created.id}`)
    expect(created.id).toMatch(/^txn_[a-z\d]{26}$/)
  })

  it('declares the currency it charges in, and refuses MYR (Paddle has none) before calling Paddle', async () => {
    expect(gw.info.currency).toBe('USD')
    const before = fake.requests.length
    await expect(gw.createPayment(sampleInput({ currency: 'MYR' }))).rejects.toMatchObject({
      code: 'CURRENCY',
    })
    expect(fake.requests.length).toBe(before)
    expect(() => paddle({ ...keys, currency: 'MYR' })).toThrow(GatewayError)
    const eur = paddle({ ...keys, baseUrl: fake.url, currency: 'EUR' })
    expect(eur.info.currency).toBe('EUR')
    expect(eur.info.minimumAmount).toBe(65)
    const created = await eur.createPayment(sampleInput())
    expect(fake.transaction(created.id)?.currency_code).toBe('EUR')
  })

  it('an order confirmed without a currency is compared against the adapter currency, never MYR', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    fake.markPaid(created.id)
    const cb = fake.callbackFor(created.id)
    expect(await confirmPayment(gw, cb, input)).toMatchObject({ ok: true, payment: { currency: 'USD' } })
    expect(await confirmPayment(gw, cb, { ...input, currency: 'MYR' })).toMatchObject({ reason: 'mismatch' })
  })

  it('reads the amount from details.totals.grand_total (what the buyer pays), not the subtotal', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    fake.markPaid(created.id)
    const t = fake.transaction(created.id)
    if (!t) throw new Error('no transaction')
    // As if Paddle had added tax on top: the subtotal still says what we asked for, the buyer paid more.
    t.details.totals.grand_total = String(input.amount + 105)
    const result = await confirmPayment(gw, fake.callbackFor(created.id), input)
    expect(result).toMatchObject({ ok: false, reason: 'mismatch' })
  })

  it('a draft, a declined card and a canceled transaction are never paid', async () => {
    const created = await gw.createPayment(sampleInput())
    expect((await gw.getPayment(created.id)).status).toBe('pending')
    fake.decline(created.id)
    expect((await gw.getPayment(created.id)).status).toBe('pending')
    const t = fake.transaction(created.id)
    if (!t) throw new Error('no transaction')
    t.status = 'canceled'
    expect((await gw.getPayment(created.id)).status).toBe('failed')
    t.status = 'paid'
    expect((await gw.getPayment(created.id)).status).toBe('paid')
    t.status = 'something_new'
    expect((await gw.getPayment(created.id)).status).toBe('unknown')
  })

  it('a payment_failed notification claims failed; a notification of another kind is refused', async () => {
    const created = await gw.createPayment(sampleInput())
    const failed = await gw.verifyCallback(
      fake.callbackFor(created.id, { event_type: 'transaction.payment_failed', status: 'ready' }),
    )
    expect(failed).toMatchObject({ id: created.id, claimedStatus: 'failed' })
    expect(gw.verifyCallback(fake.callbackFor(created.id, { event_type: 'adjustment.created' }))).toBeNull()
  })

  it('refuses a correctly signed notification older than five seconds (the SDK default)', async () => {
    const created = await gw.createPayment(sampleInput())
    const cb = fake.callbackFor(created.id)
    const resign = (ts: number) => ({
      ...cb,
      headers: { ...cb.headers, 'paddle-signature': paddleSignature(keys.webhookSecret, cb.rawBody, ts) },
    })
    expect(gw.verifyCallback(resign(nowS() - 10))).toBeNull()
    expect(gw.verifyCallback(resign(nowS()))).toMatchObject({ id: created.id })
  })

  it('refunds: full sends type full, partial names the line item; both start pending until approval', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    fake.markPaid(created.id)
    const full = await gw.refundPayment({ paymentId: created.id, amount: input.amount, reason: 'duplicate' })
    expect(fake.requests.at(-1)?.body).toMatchObject({
      action: 'refund',
      type: 'full',
      transaction_id: created.id,
      reason: 'duplicate',
    })
    expect(full).toMatchObject({ status: 'pending', amount: input.amount, currency: 'USD' })
    fake.approveRefunds()

    const other = sampleInput()
    const second = await gw.createPayment(other)
    fake.markPaid(second.id)
    const part = await gw.refundPayment({ paymentId: second.id, amount: 300 })
    const itemId = fake.transaction(second.id)?.details.line_items[0]?.id
    expect(fake.requests.at(-1)?.body).toMatchObject({
      type: 'partial',
      items: [{ item_id: itemId, type: 'partial', amount: '300' }],
    })
    expect(part.status).toBe('pending')
    // Paddle allows no new refund while one awaits approval: its own error is quoted.
    await expect(gw.refundPayment({ paymentId: second.id, amount: 100 })).rejects.toMatchObject({
      code: 'adjustment_pending_refund_request',
    })
    fake.approveRefunds()
    // The approved partial refund lowered what is left: more than that is refused before Paddle is asked.
    const before = fake.requests.length
    await expect(
      gw.refundPayment({ paymentId: second.id, amount: other.amount - 299 }),
    ).rejects.toBeInstanceOf(GatewayError)
    expect(fake.requests.slice(before).map((r) => r.method)).toEqual(['GET'])
    const rest = await gw.refundPayment({ paymentId: second.id, amount: other.amount - 300 })
    expect(rest.amount).toBe(other.amount - 300)
  })

  it("quotes Paddle's error, never the API key", async () => {
    const wrong = paddle({ ...keys, apiKey: 'pdl_sdbx_apikey_wrong', baseUrl: fake.url })
    const err = await wrong.createPayment(sampleInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).toMatchObject({ status: 403, code: 'invalid_token' })
    expect(String((err as Error).message)).not.toContain('apikey_wrong')
  })

  it('refuses an id that is not a Paddle transaction id before calling Paddle', async () => {
    const before = fake.requests.length
    await expect(gw.getPayment('../adjustments')).rejects.toBeInstanceOf(GatewayError)
    expect(fake.requests.length).toBe(before)
  })
})

describe('paddle: hosts and config', () => {
  const capture = () => {
    const urls: string[] = []
    const fetch = (async (url: string | URL) => {
      urls.push(String(url))
      return new Response(
        JSON.stringify({ error: { type: 'request_error', code: 'not_found', detail: 'x' } }),
        {
          status: 404,
        },
      )
    }) as typeof globalThis.fetch
    return { urls, fetch }
  }
  const id = `txn_${'a'.repeat(26)}`

  it('the key decides the host: pdl_sdbx_ = sandbox, pdl_live_ = live', async () => {
    const sandbox = capture()
    await paddle({ ...keys, fetch: sandbox.fetch })
      .getPayment(id)
      .catch(() => {})
    expect(new URL(sandbox.urls[0] ?? '').host).toBe('sandbox-api.paddle.com')
    const live = capture()
    await paddle({ ...keys, apiKey: 'pdl_live_apikey_x', fetch: live.fetch })
      .getPayment(id)
      .catch(() => {})
    expect(new URL(live.urls[0] ?? '').host).toBe('api.paddle.com')
    expect(new URL(live.urls[0] ?? '').protocol).toBe('https:')
  })

  it('refuses a key that says neither sandbox nor live unless a baseUrl is given', () => {
    expect(() => paddle({ ...keys, apiKey: 'sk_test_x' })).toThrow(GatewayError)
    expect(() => paddle({ ...keys, apiKey: 'sk_test_x', baseUrl: 'http://127.0.0.1:1' })).not.toThrow()
  })

  it('verifies with the configured tolerance and clock', () => {
    const body = JSON.stringify({
      event_type: 'transaction.completed',
      data: { id, status: 'completed', custom_data: { reference: 'R1' } },
    })
    const ts = 1_700_000_000
    const cb: CallbackInput = {
      fields: {},
      rawBody: body,
      headers: { 'paddle-signature': `ts=${ts};h1=${hmac(keys.webhookSecret, `${ts}:${body}`)}` },
    }
    const at = (s: number) => paddle({ ...keys, toleranceSeconds: 60, now: () => s * 1000 })
    expect(at(ts + 60).verifyCallback(cb)).toMatchObject({ id, reference: 'R1', claimedStatus: 'paid' })
    expect(at(ts + 61).verifyCallback(cb)).toBeNull()
  })
})
