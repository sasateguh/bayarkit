import { createHmac } from 'node:crypto'
import { type CallbackInput, confirmPayment, GatewayError } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFakeStripe, stripeSignature } from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeForm, parseSignatureHeader, stripe, verifyStripeSignature } from '../src/index.js'

const keys = { secretKey: 'sk_test_fake123', webhookSecret: 'whsec_fakeSigningSecret' }
const hmac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex')
const nowS = () => Math.floor(Date.now() / 1000)

gatewayConformance('stripe', async () => {
  const fake = await startFakeStripe(keys)
  return { fake, gateway: stripe({ ...keys, baseUrl: fake.url }) }
})

describe('stripe: webhook signatures (docs "verify manually" + stripe-node Webhooks.ts)', () => {
  let fake: Awaited<ReturnType<typeof startFakeStripe>>
  let gw: ReturnType<typeof stripe>
  let paidId = ''
  beforeAll(async () => {
    fake = await startFakeStripe(keys)
    gw = stripe({ ...keys, baseUrl: fake.url })
    paidId = (await gw.createPayment(sampleInput())).id
    fake.markPaid(paidId)
  })
  afterAll(() => fake.close())

  const withHeader = (cb: CallbackInput, header: string): CallbackInput => ({
    ...cb,
    headers: { ...cb.headers, 'stripe-signature': header },
  })

  it('accepts a signature over "<t>.<raw body>" keyed with the full whsec_ string', () => {
    const cb = fake.callbackFor(paidId)
    const t = nowS()
    const header = `t=${t},v1=${hmac(keys.webhookSecret, `${t}.${cb.rawBody}`)}`
    expect(gw.verifyCallback({ ...cb, headers: { 'stripe-signature': header } })).toMatchObject({
      id: paidId,
      claimedStatus: 'paid',
    })
  })

  it('refuses an HMAC over the body without the timestamp prefix', () => {
    const cb = fake.callbackFor(paidId)
    const header = `t=${nowS()},v1=${hmac(keys.webhookSecret, cb.rawBody)}`
    expect(gw.verifyCallback({ ...cb, headers: { 'stripe-signature': header } })).toBeNull()
  })

  it('accepts when ONE of several v1 values matches (endpoint secret being rolled)', () => {
    const cb = fake.callbackFor(paidId)
    const t = nowS()
    const good = hmac(keys.webhookSecret, `${t}.${cb.rawBody}`)
    const old = hmac('whsec_previousSecret', `${t}.${cb.rawBody}`)
    const header = `t=${t},v1=${old},v1=${good},v0=${'0'.repeat(64)}`
    expect(gw.verifyCallback({ ...cb, headers: { 'stripe-signature': header } })).not.toBeNull()
    expect(parseSignatureHeader(header).signatures).toEqual([old, good])
  })

  it('refuses when no v1 matches, even if several are present', () => {
    const cb = fake.callbackFor(paidId)
    const t = nowS()
    const header = `t=${t},v1=${hmac('whsec_a', `${t}.${cb.rawBody}`)},v1=${hmac('whsec_b', `${t}.${cb.rawBody}`)}`
    expect(gw.verifyCallback({ ...cb, headers: { 'stripe-signature': header } })).toBeNull()
  })

  it('ignores v0 (a v0-only header never verifies, even with a correct HMAC)', () => {
    const cb = fake.callbackFor(paidId)
    const t = nowS()
    const header = `t=${t},v0=${hmac(keys.webhookSecret, `${t}.${cb.rawBody}`)}`
    expect(gw.verifyCallback({ ...cb, headers: { 'stripe-signature': header } })).toBeNull()
  })

  it('refuses a timestamp older than the tolerance (default 300 s) and accepts one inside it', () => {
    const cb = fake.callbackFor(paidId)
    const old = nowS() - 301
    expect(gw.verifyCallback(withHeader(cb, stripeSignature(keys.webhookSecret, cb.rawBody, old)))).toBeNull()
    const fresh = nowS() - 290
    expect(
      gw.verifyCallback(withHeader(cb, stripeSignature(keys.webhookSecret, cb.rawBody, fresh))),
    ).not.toBeNull()
  })

  it('applies the tolerance against the injected clock (a genuine callback, received 6 minutes later)', () => {
    const cb = fake.callbackFor(paidId)
    const late = stripe({ ...keys, baseUrl: fake.url, now: () => Date.now() + 360_000 })
    expect(late.verifyCallback(cb)).toBeNull()
    const lenient = stripe({
      ...keys,
      baseUrl: fake.url,
      now: () => Date.now() + 360_000,
      toleranceSeconds: 600,
    })
    expect(lenient.verifyCallback(cb)).not.toBeNull()
  })

  it('follows stripe-node: the age check is one-sided (a future timestamp with a valid HMAC passes)', () => {
    const cb = fake.callbackFor(paidId)
    expect(
      verifyStripeSignature(
        cb.rawBody,
        stripeSignature(keys.webhookSecret, cb.rawBody, nowS() + 3600),
        keys.webhookSecret,
        300,
        Date.now(),
      ),
    ).toBe(true)
  })

  it('refuses a tolerance of 0 (it would switch the recency check off)', () => {
    expect(() => stripe({ ...keys, toleranceSeconds: 0 })).toThrow(GatewayError)
  })

  it('refuses a re-serialised body (signatures cover the raw bytes)', () => {
    const cb = fake.callbackFor(paidId)
    const reserialised = JSON.stringify(JSON.parse(cb.rawBody))
    expect(reserialised).not.toBe(cb.rawBody)
    expect(gw.verifyCallback({ ...cb, rawBody: reserialised })).toBeNull()
  })

  it('refuses a correctly signed event that is not about a Checkout Session', () => {
    const cb = fake.callbackFor(paidId, { type: 'payment_intent.succeeded' })
    expect(gw.verifyCallback(cb)).toBeNull()
  })

  it('reads an async failure as failed, and the reference from client_reference_id', () => {
    const cb = fake.callbackFor(paidId, {
      type: 'checkout.session.async_payment_failed',
      payment_status: 'unpaid',
    })
    const v = gw.verifyCallback(cb)
    expect(v?.claimedStatus).toBe('failed')
    expect(v?.reference).toBe(fake.session(paidId)?.client_reference_id)
  })
})

describe('stripe: Checkout Session requests (create doc + endive changelog)', () => {
  let fake: Awaited<ReturnType<typeof startFakeStripe>>
  beforeAll(async () => {
    fake = await startFakeStripe(keys)
  })
  afterAll(() => fake.close())

  it('the fake rejects payment_method_types under endive, so the adapter must not send it', async () => {
    const res = await fetch(`${fake.url}/v1/checkout/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${keys.secretKey}`,
        'stripe-version': '2026-09-30.endive',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'mode=payment&payment_method_types[]=card',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('invalid_request_error')

    const gw = stripe({ ...keys, baseUrl: fake.url })
    await gw.createPayment(sampleInput())
    const sent = fake.requests.at(-1)
    expect(sent?.headers['stripe-version']).toBe('2026-09-30.endive')
    expect(sent?.keys.some((k) => k.startsWith('payment_method_types'))).toBe(false)
    expect(sent?.body['allowed_payment_method_types[]']).toBe('card,fpx')
  })

  it('sends the documented fields as bracket keys, and the idempotency key', async () => {
    const gw = stripe({ ...keys, baseUrl: fake.url })
    const input = sampleInput({
      amount: 2000,
      customer: { email: 'ali@example.com' },
      idempotencyKey: 'retry-1',
    })
    const created = await gw.createPayment(input)
    const sent = fake.requests.at(-1)
    expect(sent?.body).toMatchObject({
      mode: 'payment',
      'line_items[0][price_data][currency]': 'myr',
      'line_items[0][price_data][unit_amount]': '2000',
      'line_items[0][price_data][product_data][name]': input.description,
      'line_items[0][quantity]': '1',
      success_url: input.returnUrl,
      cancel_url: input.returnUrl,
      client_reference_id: input.reference,
      customer_email: 'ali@example.com',
    })
    expect(sent?.headers['idempotency-key']).toBe('retry-1')
    expect(sent?.headers.authorization).toBe(`Bearer ${keys.secretKey}`)
    // Same key, same params → the same session (no second checkout).
    expect((await gw.createPayment(input)).id).toBe(created.id)
  })

  it('defaults the idempotency key to the reference', async () => {
    const gw = stripe({ ...keys, baseUrl: fake.url })
    const input = sampleInput()
    await gw.createPayment(input)
    expect(fake.requests.at(-1)?.headers['idempotency-key']).toBe(input.reference)
  })

  it('sends payment_method_types[] only when pinned to a version before endive', async () => {
    const gw = stripe({ ...keys, baseUrl: fake.url, apiVersion: '2026-08-26.dahlia' })
    await gw.createPayment(sampleInput())
    const sent = fake.requests.at(-1)
    expect(sent?.body['payment_method_types[]']).toBe('card,fpx')
    expect(sent?.keys.some((k) => k.startsWith('allowed_payment_method_types'))).toBe(false)
  })

  it('sends no payment method list when paymentMethods is empty (Dashboard decides)', async () => {
    const gw = stripe({ ...keys, baseUrl: fake.url, paymentMethods: [] })
    await gw.createPayment(sampleInput())
    expect(fake.requests.at(-1)?.keys.some((k) => k.includes('payment_method_types'))).toBe(false)
  })

  it('normalises currency to MYR (Stripe answers "myr")', async () => {
    const gw = stripe({ ...keys, baseUrl: fake.url })
    const created = await gw.createPayment(sampleInput({ amount: 1234 }))
    expect(fake.session(created.id)?.currency).toBe('myr')
    const record = await gw.getPayment(created.id)
    expect(record).toMatchObject({ currency: 'MYR', amount: 1234, status: 'pending' })
  })

  it('enforces the 30 min – 24 h expires_at window before calling Stripe', async () => {
    const gw = stripe({ ...keys, baseUrl: fake.url })
    const at = (s: number) => new Date(Date.now() + s * 1000)
    const before = fake.requests.length
    await expect(gw.createPayment(sampleInput({ expiresAt: at(29 * 60) }))).rejects.toThrow(/30 minutes/)
    await expect(gw.createPayment(sampleInput({ expiresAt: at(24 * 3600 + 60) }))).rejects.toThrow(/24 hours/)
    expect(fake.requests.length).toBe(before)
    const ok = await gw.createPayment(sampleInput({ expiresAt: at(3600) }))
    expect(fake.session(ok.id)?.expires_at).toBe(Math.floor(at(3600).getTime() / 1000))
  })

  it('maps expired sessions and refuses to confirm them', async () => {
    const gw = stripe({ ...keys, baseUrl: fake.url })
    const input = sampleInput()
    const created = await gw.createPayment(input)
    expect((await gw.expirePayment(created.id)).status).toBe('expired')
    expect(await confirmPayment(gw, fake.callbackFor(created.id), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
    })
  })

  it('a wrong key is a GatewayError quoting Stripe, never the key', async () => {
    const gw = stripe({ ...keys, secretKey: 'sk_test_wrong9', baseUrl: fake.url })
    const err = await gw.createPayment(sampleInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).status).toBe(401)
    expect(String((err as Error).message)).not.toContain('sk_test_wrong9')
  })

  it('masks key-shaped text that Stripe echoes in an error', async () => {
    const echo = (async () =>
      new Response(
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'Invalid API Key provided: sk_test_****9999' },
        }),
        {
          status: 401,
        },
      )) as typeof fetch
    const gw = stripe({ ...keys, fetch: echo })
    await expect(gw.getPayment('cs_test_x')).rejects.toThrow(/\[redacted\]/)
  })

  it('refuses a session id that could change the request path', async () => {
    const gw = stripe({ ...keys, baseUrl: fake.url })
    await expect(gw.getPayment('cs_test_x/../../v1/charges')).rejects.toThrow(/invalid checkout session id/)
  })
})

describe('stripe: form encoder', () => {
  it('produces Stripe bracket keys', () => {
    expect(
      encodeForm({
        mode: 'payment',
        line_items: [
          {
            price_data: { currency: 'myr', unit_amount: 2000, product_data: { name: 'Baju & seluar' } },
            quantity: 1,
          },
        ],
        allowed_payment_method_types: ['card', 'fpx'],
        customer_email: undefined,
        success_url: 'https://x.example/ok?a=1',
      }),
    ).toBe(
      'mode=payment' +
        '&line_items[0][price_data][currency]=myr' +
        '&line_items[0][price_data][unit_amount]=2000' +
        '&line_items[0][price_data][product_data][name]=Baju%20%26%20seluar' +
        '&line_items[0][quantity]=1' +
        '&allowed_payment_method_types[]=card&allowed_payment_method_types[]=fpx' +
        '&success_url=https%3A%2F%2Fx.example%2Fok%3Fa%3D1',
    )
  })
})
