import { createHash, createHmac } from 'node:crypto'
import { type CallbackInput, confirmPayment, GatewayError } from '@bayarkit/core'
import {
  dokuSignature as fakeSignature,
  gatewayConformance,
  sampleInput,
  startFakeSenangPay,
} from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  API_VERSION,
  dokuDigest,
  dokuSignature,
  senangpay,
  senOf,
  signingString,
  verifyDokuSignature,
} from '../src/index.js'

const keys = {
  clientId: 'BRN-0001-1234567890',
  secretKey: 'fake-secret-key',
  apiKey: 'fake-api-key-123',
  notificationPath: '/payments/doku',
}
const b64hmac = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('base64')
const make = (url: string, extra: Partial<Parameters<typeof senangpay>[0]> = {}) =>
  senangpay({ ...keys, environment: 'sandbox', baseUrl: url, ...extra })

gatewayConformance('senangpay', async () => {
  const fake = await startFakeSenangPay(keys)
  return { fake, gateway: make(fake.url) }
})

describe('senangpay: official test vectors (spec §A4.1 and §B4)', () => {
  it('builds the DOKU published signing string byte for byte (generating-signature page)', () => {
    const published =
      'BRN-0239-1709018494325\n2026-08-11T06:39:29Z\n/v3/payments\nkouJDoOZUOcxBcR2TFN5ehxSDcjiPydf8V4uJBywFJ0='
    expect(
      signingString({
        clientId: 'BRN-0239-1709018494325',
        timestamp: '2026-08-11T06:39:29Z',
        path: '/v3/payments',
        digest: 'kouJDoOZUOcxBcR2TFN5ehxSDcjiPydf8V4uJBywFJ0=',
      }),
    ).toBe(published)
  })

  it('produces a header of the published shape; the published HMAC has no published key (not a usable vector)', () => {
    // DOKU publishes HMACSHA256=X78G… without its secret key. The spec tried these keys; none reproduces it. If one
    // ever does, this test fails and the vector becomes a real one.
    const published = 'HMACSHA256=X78G6dJOsfFS5KjPbN9Y0iQ8ZMkadT0UZFzGwHTACHE=' // gitleaks:allow (DOKU docs example output, no key)
    const string =
      'BRN-0239-1709018494325\n2026-08-11T06:39:29Z\n/v3/payments\nkouJDoOZUOcxBcR2TFN5ehxSDcjiPydf8V4uJBywFJ0='
    const shape = /^HMACSHA256=[A-Za-z0-9+/]{43}=$/
    expect(published).toMatch(shape)
    expect(Buffer.from(published.slice('HMACSHA256='.length), 'base64')).toHaveLength(32)
    for (const key of [
      'secret-key-from-DOKU-back-office',
      'secret-key-from-jokul-back-office',
      'secret',
      '',
    ]) {
      const ours = dokuSignature(key, string)
      expect(ours).toMatch(shape)
      expect(ours).not.toBe(published)
    }
  })

  it('digest = base64(SHA-256(raw body)), the Java sample generateDigest', () => {
    const body = '{"order":{"invoice_number":"INV-20210124-0001","amount":150000}}'
    expect(dokuDigest(body)).toBe(createHash('sha256').update(body, 'utf8').digest('base64'))
    expect(dokuDigest(body)).toMatch(/^[A-Za-z0-9+/]{43}=$/)
  })

  // Legacy senangPay (app.senangpay.my): NOT implemented, kept as documentation of the old scheme only. Each vector is
  // recomputed with node:crypto here so the spec's claim "checked locally, all match" stays checked.
  const md5 = (s: string) => createHash('md5').update(s).digest('hex')
  const hmacHex = (k: string, s: string) => createHmac('sha256', k).update(s).digest('hex')
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
  it.each([
    ['L1', md5('53-784Shopping_cart_id_3024.5056'), '0bde51ff340f110ab7331a902aa969e7'],
    [
      'L2',
      hmacHex('53-784', '53-784Shopping_cart_id_3024.5056'),
      '74422328b44d30bf150fffbae89bbb42b885f9ac0960e2a3ddccc0cf9aa48e39',
    ],
    ['L3', md5('53-78415614363538840Payment_was_successful'), '69686562c29ad3f7955b1843a5c275ca'],
    [
      'L4',
      hmacHex('53-784', '53-78415614363538840Payment_was_successful'),
      '4ca7837c6c4ddb5f6ba573ea701235b2d04bc6400d32787539e07aaf319eb70f',
    ],
    ['R1', sha256('21245-957123412'), 'a8167dd09f01ebed0b18e67b2cc2424a0d058ccc83d94803482ecdeedff7728f'],
    [
      'R2',
      sha256('21245-95711214363538840Payment_was_successful'),
      '24354422953c29bf4b822f6783bbaf64ef445623d6e8ea4ddc1582a29c03cda0',
    ],
  ])('legacy vector %s (documentation only)', (_name, computed, expected) => {
    expect(computed).toBe(expected)
  })
})

describe('senangpay: notifications (Global signature over the raw body)', () => {
  let fake: Awaited<ReturnType<typeof startFakeSenangPay>>
  let gw: ReturnType<typeof senangpay>
  let id = ''
  beforeAll(async () => {
    fake = await startFakeSenangPay(keys)
    gw = make(fake.url)
    id = (await gw.createPayment(sampleInput())).id
    fake.markPaid(id)
  })
  afterAll(() => fake.close())

  /** Re-sign a callback with a custom string builder (how the various official samples build it). */
  const resign = (cb: CallbackInput, build: (digest: string) => string): CallbackInput => ({
    ...cb,
    headers: {
      ...cb.headers,
      signature: `HMACSHA256=${b64hmac(keys.secretKey, build(dokuDigest(cb.rawBody)))}`,
    },
  })
  const ts = (cb: CallbackInput) => cb.headers['request-timestamp'] ?? ''

  it('accepts a notification signed per the written rules and the Java/Ruby samples', () => {
    const cb = fake.callbackFor(id)
    const javaStyle = resign(cb, (d) => `${keys.clientId}\n${ts(cb)}\n${keys.notificationPath}\n${d}`)
    expect(gw.verifyCallback(javaStyle)).toMatchObject({ id, reference: id, claimedStatus: 'paid' })
  })

  it('C1: refuses the Python/Node sample form with a "Digest:" prefix on the digest line', () => {
    const cb = fake.callbackFor(id)
    const nodeStyle = resign(cb, (d) => `${keys.clientId}\n${ts(cb)}\n${keys.notificationPath}\nDigest:${d}`)
    expect(gw.verifyCallback(nodeStyle)).toBeNull()
  })

  it('C2: refuses the Go sample form that appends the digest twice', () => {
    const cb = fake.callbackFor(id)
    const goStyle = resign(cb, (d) => `${keys.clientId}\n${ts(cb)}\n${keys.notificationPath}\n${d}\n${d}`)
    expect(gw.verifyCallback(goStyle)).toBeNull()
  })

  it('refuses a re-serialised body (DOKU: do not beautify or re-serialise; the digest covers the raw bytes)', () => {
    const cb = fake.callbackFor(id)
    const reserialised = JSON.stringify(JSON.parse(cb.rawBody))
    expect(reserialised).not.toBe(cb.rawBody)
    expect(gw.verifyCallback(cb)).not.toBeNull()
    expect(gw.verifyCallback({ ...cb, rawBody: reserialised })).toBeNull()
  })

  it('signs over the path of the merchant notification URL, not a DOKU path', () => {
    const cb = fake.callbackFor(id)
    const dokuPath = resign(cb, (d) => `${keys.clientId}\n${ts(cb)}\n/v3/payments\n${d}`)
    expect(gw.verifyCallback(dokuPath)).toBeNull()
    expect(make(fake.url, { notificationPath: '/other' }).verifyCallback(cb)).toBeNull()
  })

  it("uses the notification's own Client-Id and Request-Timestamp, and the Client-Id must be yours", () => {
    const cb = fake.callbackFor(id)
    const otherTs = { ...cb, headers: { ...cb.headers, 'request-timestamp': '2020-01-01T00:00:00Z' } }
    expect(gw.verifyCallback(otherTs)).toBeNull()
    // Correctly signed, but for another merchant's Client-Id.
    const other = 'BRN-9999-0000000000'
    const signature = fakeSignature(keys.secretKey, other, ts(cb), keys.notificationPath, cb.rawBody)
    expect(gw.verifyCallback({ ...cb, headers: { ...cb.headers, 'client-id': other, signature } })).toBeNull()
  })

  it('C4: refuses the separate Cards scheme (labelled lines, Request-Id), which this adapter does not implement', () => {
    const cb = fake.callbackFor(id)
    const requestId = '479b663f-5c9d-400d-8e80-3e548a8f7639'
    const cards = resign(
      { ...cb, headers: { ...cb.headers, 'request-id': requestId } },
      (d) =>
        `Client-Id:${keys.clientId}\nRequest-Id:${requestId}\nRequest-Timestamp:${ts(cb)}\nRequest-Target:${keys.notificationPath}\nDigest:${d}`,
    )
    expect(gw.verifyCallback(cards)).toBeNull()
  })

  it('C9: does not depend on API-Version (doku-global.… on notifications, arabica.… on requests)', () => {
    const cb = fake.callbackFor(id)
    expect(cb.headers['api-version']).toBe('doku-global.2025-12-01')
    const { 'api-version': _dropped, ...without } = cb.headers
    expect(gw.verifyCallback({ ...cb, headers: without })).not.toBeNull()
  })

  it('reads a failed notification as failed and never as paid', () => {
    const v = gw.verifyCallback(fake.callbackFor(id, { status: 'FAILED' }))
    expect(v?.claimedStatus).toBe('failed')
    expect(gw.verifyCallback(fake.callbackFor(id, { status: 'EXPIRED' }))?.claimedStatus).toBe('expired')
  })

  it('refuses a correctly signed Cards-shaped body (no payment object)', () => {
    const rawBody = JSON.stringify({
      order: { invoice_number: id, amount: 10.5 },
      transaction: { status: 'SUCCESS' },
    })
    const timestamp = '2026-10-23T00:00:00Z'
    const cb = {
      fields: {},
      rawBody,
      headers: {
        'client-id': keys.clientId,
        'request-timestamp': timestamp,
        signature: fakeSignature(keys.secretKey, keys.clientId, timestamp, keys.notificationPath, rawBody),
      },
    }
    expect(
      verifyDokuSignature(keys.secretKey, cb.headers.signature, {
        clientId: keys.clientId,
        timestamp,
        path: keys.notificationPath,
        rawBody,
      }),
    ).toBe(true)
    expect(gw.verifyCallback(cb)).toBeNull()
  })

  it('refuses a timestamp carrying a newline (it would shift the signed lines)', () => {
    const cb = fake.callbackFor(id)
    const bad = { ...cb, headers: { ...cb.headers, 'request-timestamp': `${ts(cb)}\n/x` } }
    expect(gw.verifyCallback(bad)).toBeNull()
  })
})

describe('senangpay: requests (Create / Retrieve Checkout)', () => {
  let fake: Awaited<ReturnType<typeof startFakeSenangPay>>
  let gw: ReturnType<typeof senangpay>
  beforeAll(async () => {
    fake = await startFakeSenangPay(keys)
    gw = make(fake.url)
  })
  afterAll(() => fake.close())

  it('signs the exact body it sends and converts sen to ringgit at the edge', async () => {
    const input = sampleInput({ amount: 1050 })
    await gw.createPayment(input)
    const req = fake.requests.at(-1)
    if (!req) throw new Error('no request')
    const h = req.headers as Record<string, string>
    expect(req.method).toBe('POST')
    expect(req.path).toBe('/v3/checkouts')
    expect(h['api-version']).toBe(API_VERSION)
    expect(h.signature).toBe(
      dokuSignature(
        keys.secretKey,
        signingString({
          clientId: keys.clientId,
          timestamp: h['request-timestamp'] ?? '',
          path: '/v3/checkouts',
          digest: dokuDigest(req.rawBody),
        }),
      ),
    )
    expect(h['request-timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const body = req.body as { id: string; order: Record<string, unknown> }
    expect(body.id).toBe(input.reference)
    expect(body.order.invoice_number).toBe(input.reference)
    expect(body.order.amount).toBe(10.5)
    expect(body.order.currency).toBe('MYR')
    expect(body.order.expired_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  it('C8: Authorization is Basic base64("<API key>:") with the colon', async () => {
    await gw.createPayment(sampleInput())
    const h = fake.requests.at(-1)?.headers as Record<string, string>
    expect(h.authorization).toBe(`Basic ${Buffer.from(`${keys.apiKey}:`).toString('base64')}`)
  })

  it('C6/C7: sends none of the contested fields (channels / payment_channels / payment.processor)', async () => {
    await gw.createPayment(sampleInput())
    const body = fake.requests.at(-1)?.body as Record<string, Record<string, unknown>>
    expect(body.payment).toBeUndefined()
    expect(body.checkout_experience).toEqual({ callback_url: 'https://shop.example/return' })
  })

  it('signs GET without a digest line and reads amounts back to sen', async () => {
    const input = sampleInput({ amount: 10005 })
    const { id } = await gw.createPayment(input)
    const record = await gw.getPayment(id)
    const req = fake.requests.at(-1)
    const h = req?.headers as Record<string, string>
    expect(req?.method).toBe('GET')
    expect(h.signature).toBe(
      dokuSignature(keys.secretKey, `${keys.clientId}\n${h['request-timestamp']}\n/v3/checkouts/${id}`),
    )
    expect(record).toMatchObject({
      id,
      reference: input.reference,
      amount: 10005,
      currency: 'MYR',
      status: 'pending',
    })
  })

  it('C10: refuses a reference with ":" (allowed by reference_id, not by the Identity type) before calling', async () => {
    const before = fake.requests.length
    await expect(gw.createPayment(sampleInput({ reference: 'ORDER:1' }))).rejects.toBeInstanceOf(GatewayError)
    await expect(gw.createPayment(sampleInput({ reference: 'X'.repeat(31) }))).rejects.toBeInstanceOf(
      GatewayError,
    )
    expect(fake.requests.length).toBe(before)
  })

  it('C11: sends idempotencyKey as Idempotency-Id; the same key with another body is a 409', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000)
    const input = sampleInput({ idempotencyKey: 'key-123', expiresAt })
    const first = await gw.createPayment(input)
    expect(fake.requests.at(-1)?.headers?.['idempotency-id']).toBe('key-123')
    expect(await gw.createPayment(input)).toMatchObject({ id: first.id, url: first.url })
    await expect(gw.createPayment({ ...input, amount: 2000 })).rejects.toMatchObject({
      status: 409,
      code: 'idempotency_id_conflict',
    })
    await expect(gw.createPayment(sampleInput({ idempotencyKey: 'bad key' }))).rejects.toBeInstanceOf(
      GatewayError,
    )
  })

  it('a second checkout with the same reference is refused by DOKU (duplicate_transaction)', async () => {
    const input = sampleInput()
    await gw.createPayment(input)
    await expect(gw.createPayment(input)).rejects.toMatchObject({
      status: 400,
      code: 'duplicate_transaction',
    })
  })

  it('status: paid only when order PAID and payment SUCCESS; C5 state INIT/INITIATE both pending', async () => {
    const { id } = await gw.createPayment(sampleInput())
    const c = fake.checkout(id)
    if (!c) throw new Error('no checkout')
    const set = (order: string, payment: string, state = 'COMPLETED') => {
      c.order.status = order
      c.payment.status = payment
      c.payment.state = state
    }
    const cases: [string, string, string, string][] = [
      ['PENDING', 'PENDING', 'INIT', 'pending'],
      ['PENDING', 'PENDING', 'INITIATE', 'pending'],
      ['PENDING', 'SUCCESS', 'COMPLETED', 'unknown'],
      ['PAID', 'PENDING', 'COMPLETED', 'pending'],
      ['PENDING', 'FAILED', 'COMPLETED', 'failed'],
      ['EXPIRED', 'EXPIRED', 'COMPLETED', 'expired'],
      ['PAID', 'REFUNDED', 'COMPLETED', 'unknown'],
      ['PAID', 'AUTHORIZED', 'COMPLETED', 'unknown'],
      ['PAID', 'SUCCESS', 'COMPLETED', 'paid'],
    ]
    for (const [order, payment, state, expected] of cases) {
      set(order, payment, state)
      expect([order, payment, state, (await gw.getPayment(id)).status]).toEqual([
        order,
        payment,
        state,
        expected,
      ])
    }
  })

  it('a failed payment never confirms, even with a genuine notification claiming success', async () => {
    const input = sampleInput()
    const { id } = await gw.createPayment(input)
    const c = fake.checkout(id)
    if (!c) throw new Error('no checkout')
    c.payment.status = 'FAILED'
    expect(await confirmPayment(gw, fake.callbackFor(id), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
    })
  })

  it('reads ringgit strictly: two decimals at most, never rounded into a match', () => {
    expect(senOf(100.05)).toBe(10005)
    expect(senOf('10.50')).toBe(1050)
    expect(senOf(2)).toBe(200)
    expect(senOf(10.505)).toBeNaN()
    expect(senOf(-1)).toBeNaN()
    expect(senOf('1e3')).toBeNaN()
    expect(senOf(null)).toBeNaN()
  })

  it('errors quote DOKU only, never a key', async () => {
    const wrong = make(fake.url, { apiKey: 'wrong-api-key-xyz' })
    const err = await wrong.createPayment(sampleInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    const message = (err as Error).message
    expect(message).toContain('unauthorized')
    for (const s of [
      'wrong-api-key-xyz',
      keys.secretKey,
      Buffer.from('wrong-api-key-xyz:').toString('base64'),
    ])
      expect(message).not.toContain(s)
    const badSecret = make(fake.url, { secretKey: 'not-the-secret' })
    await expect(badSecret.createPayment(sampleInput())).rejects.toMatchObject({
      status: 401,
      code: 'invalid_signature',
    })
  })

  it('refuses a config without a notification path', () => {
    expect(() => make(fake.url, { notificationPath: 'payments/doku' })).toThrow(GatewayError)
    expect(() => make(fake.url, { notificationPath: '/a?b=1' })).toThrow(GatewayError)
  })

  it('refuses an expiry in the past before calling', async () => {
    await expect(
      gw.createPayment(sampleInput({ expiresAt: new Date(Date.now() - 1000) })),
    ).rejects.toBeInstanceOf(GatewayError)
  })
})

describe('senangpay: once paid, the amount is what was paid', () => {
  const checkout = (payment: Record<string, unknown>) => async () =>
    new Response(
      JSON.stringify({
        id: 'chk1',
        order: { invoice_number: 'R1', amount: 50, currency: 'MYR', status: 'PAID' },
        payment,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  it('uses payment.amount when the retrieve carries one', async () => {
    const g = senangpay({
      ...keys,
      environment: 'sandbox',
      baseUrl: 'https://doku.test',
      fetch: checkout({ status: 'SUCCESS', amount: 30 }),
    })
    expect((await g.getPayment('chk1')).amount).toBe(3000)
  })

  it('falls back to order.amount (the documented retrieve shape) when it does not', async () => {
    const g = senangpay({
      ...keys,
      environment: 'sandbox',
      baseUrl: 'https://doku.test',
      fetch: checkout({ status: 'SUCCESS' }),
    })
    expect((await g.getPayment('chk1')).amount).toBe(5000)
  })
})
