import { confirmPayment, GatewayError } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFakePayPal } from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CURRENCIES, fromPayPalValue, paypal, toPayPalValue } from '../src/index.js'

const keys = { clientId: 'client_fake', clientSecret: 'secret_fake', webhookId: 'WH_FAKE' }

gatewayConformance('paypal', async () => {
  const fake = await startFakePayPal(keys)
  return { fake, gateway: paypal({ ...keys, baseUrl: fake.url }) }
})

describe('paypal: amounts (smallest unit ↔ PayPal decimal string, spec §7)', () => {
  const vectors: [number, string, string][] = [
    [1050, 'MYR', '10.50'],
    [1, 'MYR', '0.01'],
    [100, 'USD', '1.00'],
    [123456789, 'USD', '1234567.89'],
    [500, 'JPY', '500'],
    [1, 'JPY', '1'],
    [2500, 'HUF', '2500'],
    [30, 'TWD', '30'],
  ]
  it.each(vectors)('%i %s ↔ "%s"', (minor, currency, value) => {
    expect(toPayPalValue(minor, currency)).toBe(value)
    expect(fromPayPalValue(value, currency)).toBe(minor)
  })

  it('reads trailing zeros, refuses more decimals than the currency has and anything not a decimal string', () => {
    expect(fromPayPalValue('10.500', 'USD')).toBe(1050)
    expect(fromPayPalValue('500.00', 'JPY')).toBe(500)
    for (const [v, c] of [
      ['10.505', 'USD'],
      ['500.5', 'JPY'],
      ['-1.00', 'USD'],
      ['1e3', 'USD'],
      ['', 'USD'],
      [10.5, 'USD'],
      [null, 'USD'],
    ] as const) {
      expect(fromPayPalValue(v, c), String(v)).toBeNaN()
    }
    expect(() => toPayPalValue(10.5, 'USD')).toThrow(RangeError)
    expect(() => toPayPalValue(-1, 'USD')).toThrow(RangeError)
  })

  it('lists the 24 currencies, MYR among them', () => {
    expect(CURRENCIES).toHaveLength(24)
    expect(CURRENCIES).toContain('MYR')
  })
})

describe('paypal: against the fake', () => {
  let fake: Awaited<ReturnType<typeof startFakePayPal>>
  let gw: ReturnType<typeof paypal>
  beforeAll(async () => {
    fake = await startFakePayPal(keys)
    gw = paypal({ ...keys, baseUrl: fake.url })
  })
  afterAll(() => fake.close())
  const paths = (from: number) => fake.requests.slice(from).map((r) => `${r.method} ${r.path}`)

  it('creates an order: intent CAPTURE, one unit, reference in custom_id, amount a string, payer-action link', async () => {
    const input = sampleInput({ amount: 1999, idempotencyKey: 'create-1' })
    const created = await gw.createPayment(input)
    const sent = fake.requests.at(-1)
    expect(sent?.path).toBe('/v2/checkout/orders')
    expect(sent?.headers['paypal-request-id']).toBe('create-1')
    const body = sent?.body as {
      intent: string
      purchase_units: Record<string, unknown>[]
      payment_source: unknown
    }
    expect(body.intent).toBe('CAPTURE')
    expect(body.purchase_units).toHaveLength(1)
    expect(body.purchase_units[0]).toMatchObject({
      custom_id: input.reference,
      amount: { currency_code: 'USD', value: '19.99' },
    })
    expect(body.purchase_units[0]).not.toHaveProperty('invoice_id')
    expect(body.payment_source).toMatchObject({
      paypal: { experience_context: { return_url: input.returnUrl, user_action: 'PAY_NOW' } },
    })
    expect(created.url).toBe(`${fake.url}/checkoutnow?token=${created.id}`)
    expect(fake.order(created.id)?.status).toBe('PAYER_ACTION_REQUIRED')
  })

  it('charges in the order currency when it names one, the config currency otherwise; refuses others first', async () => {
    expect(gw.info.currency).toBe('USD')
    const myr = await gw.createPayment(sampleInput({ currency: 'MYR', amount: 1050 }))
    expect(fake.order(myr.id)?.purchase_units[0]?.amount).toEqual({ currency_code: 'MYR', value: '10.50' })
    const jpy = await gw.createPayment(sampleInput({ currency: 'JPY', amount: 500 }))
    expect(fake.order(jpy.id)?.purchase_units[0]?.amount).toEqual({ currency_code: 'JPY', value: '500' })
    const before = fake.requests.length
    await expect(gw.createPayment(sampleInput({ currency: 'IDR' }))).rejects.toMatchObject({
      code: 'CURRENCY',
    })
    await expect(gw.createPayment(sampleInput({ reference: 'x'.repeat(256) }))).rejects.toBeInstanceOf(
      GatewayError,
    )
    expect(fake.requests.length).toBe(before)
    expect(() => paypal({ ...keys, currency: 'IDR' })).toThrow(GatewayError)
    expect(paypal({ ...keys, currency: 'MYR' }).info.currency).toBe('MYR')
  })

  it('caches the token: one token request for many calls, and fetches a new one once when PayPal ends it', async () => {
    const own = paypal({ ...keys, baseUrl: fake.url })
    const from = fake.requests.length
    const created = await own.createPayment(sampleInput())
    await own.getPayment(created.id)
    await own.getPayment(created.id)
    expect(paths(from).filter((p) => p === 'POST /v1/oauth2/token')).toHaveLength(1)
    fake.expireTokens()
    const again = fake.requests.length
    expect((await own.getPayment(created.id)).status).toBe('pending')
    expect(paths(again)).toEqual([
      `GET /v2/checkout/orders/${created.id}`,
      'POST /v1/oauth2/token',
      `GET /v2/checkout/orders/${created.id}`,
    ])
  })

  it('a wrong client secret is a GatewayError quoting PayPal, never the secret', async () => {
    const wrong = paypal({ ...keys, clientSecret: 'secret_wrong_value', baseUrl: fake.url })
    const err = await wrong.createPayment(sampleInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(String((err as Error).message)).toContain('invalid_client')
    expect(JSON.stringify(err) + String(err)).not.toContain('secret_wrong_value')
    expect(String(err)).not.toContain(Buffer.from('client_fake:secret_wrong_value').toString('base64'))
  })

  it('getPayment only reads: an APPROVED order is pending and is never captured (sabotage: capture in getPayment)', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    fake.approve(created.id)
    const from = fake.requests.length
    expect((await gw.getPayment(created.id)).status).toBe('pending')
    expect(paths(from).some((p) => p.endsWith('/capture'))).toBe(false)
    expect(fake.order(created.id)?.status).toBe('APPROVED')
    // A signed "capture completed" event for an approved, uncaptured order is not paid (sabotage: APPROVED = paid).
    expect(await confirmPayment(gw, fake.callbackFor(created.id), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
    })
  })

  it('capturePayment captures an approved order once (same PayPal-Request-Id on retry), then confirmPayment is ok', async () => {
    const input = sampleInput({ amount: 2500 })
    const created = await gw.createPayment(input)
    fake.approve(created.id)
    const first = await gw.capturePayment(created.id)
    const retry = await gw.capturePayment(created.id)
    expect(first).toMatchObject({ status: 'paid', amount: 2500, currency: 'USD', reference: input.reference })
    expect(first.paidAt).toBeInstanceOf(Date)
    const captures = fake.requests.filter((r) => r.path === `/v2/checkout/orders/${created.id}/capture`)
    expect(captures.map((r) => r.headers['paypal-request-id'])).toEqual([
      `capture-${created.id}`,
      `capture-${created.id}`,
    ])
    expect(retry.raw).toEqual(first.raw)
    expect(await confirmPayment(gw, fake.callbackFor(created.id), input)).toMatchObject({ ok: true })
  })

  it('capturing before approval is a GatewayError (422) with PayPal`s name', async () => {
    const created = await gw.createPayment(sampleInput())
    await expect(gw.capturePayment(created.id)).rejects.toMatchObject({ status: 422 })
    await expect(gw.capturePayment('../x')).rejects.toMatchObject({ code: 'INVALID_ID' })
  })

  it('reads paid from the capture: COMPLETED order with a DECLINED capture = failed, PENDING capture = pending', async () => {
    const declined = await gw.createPayment(sampleInput())
    fake.nextCapture(declined.id, 'DECLINED')
    fake.approve(declined.id)
    const d = await gw.capturePayment(declined.id)
    expect(fake.order(declined.id)?.status).toBe('COMPLETED')
    expect(d.status).toBe('failed')
    const held = await gw.createPayment(sampleInput())
    fake.nextCapture(held.id, 'PENDING')
    fake.approve(held.id)
    expect((await gw.capturePayment(held.id)).status).toBe('pending')
    expect((await gw.getPayment(held.id)).status).toBe('pending')
  })

  it('verifies through the postback with the raw body spliced in byte for byte (sabotage: trust the body)', async () => {
    const created = await gw.createPayment(sampleInput())
    fake.markPaid(created.id)
    const cb = fake.callbackFor(created.id)
    const from = fake.requests.length
    const verified = await gw.verifyCallback(cb)
    expect(verified).toMatchObject({ id: created.id, claimedStatus: 'paid' })
    expect(verified?.raw.capture_id).toBe(
      fake.order(created.id)?.purchase_units[0]?.payments?.captures[0]?.id,
    )
    expect(paths(from)).toContain('POST /v1/notifications/verify-webhook-signature')
    const post = fake.requests
      .slice(from)
      .find((r) => r.path === '/v1/notifications/verify-webhook-signature')
    expect(post?.body).toMatchObject({
      webhook_id: 'WH_FAKE',
      transmission_sig: cb.headers['paypal-transmission-sig'],
    })
    // One byte changed in the body, a re-serialised body, or a wrong webhook id: PayPal says FAILURE.
    expect(
      await gw.verifyCallback({ ...cb, rawBody: cb.rawBody.replace('COMPLETED', 'COMPLETEd') }),
    ).toBeNull()
    expect(await gw.verifyCallback({ ...cb, rawBody: JSON.stringify(JSON.parse(cb.rawBody)) })).toBeNull()
    expect(await paypal({ ...keys, webhookId: 'WH_OTHER', baseUrl: fake.url }).verifyCallback(cb)).toBeNull()
  })

  it('refuses without calling PayPal when a header is missing or the body is not one JSON object', async () => {
    const created = await gw.createPayment(sampleInput())
    const cb = fake.callbackFor(created.id)
    const from = fake.requests.length
    const { 'paypal-cert-url': _, ...noCert } = cb.headers
    expect(await gw.verifyCallback({ ...cb, headers: noCert })).toBeNull()
    for (const rawBody of ['[1]', '"x"', `${cb.rawBody},"webhook_id":"x"`, `${cb.rawBody}}`]) {
      expect(await gw.verifyCallback({ ...cb, rawBody }), rawBody).toBeNull()
    }
    expect(paths(from)).toEqual([])
  })

  it('a verify call that fails is gateway_error in confirmPayment, not a forgery', async () => {
    const created = await gw.createPayment(sampleInput())
    const down = paypal({
      ...keys,
      baseUrl: fake.url,
      fetch: async (url, init) => {
        if (String(url).endsWith('/verify-webhook-signature')) throw new TypeError('fetch failed')
        return fetch(url, init)
      },
    })
    const result = await confirmPayment(down, fake.callbackFor(created.id), sampleInput())
    expect(result).toMatchObject({ ok: false, reason: 'gateway_error' })
  })

  it('an authentic event that names no order is not a payment callback', async () => {
    const created = await gw.createPayment(sampleInput())
    expect(
      await gw.verifyCallback(fake.callbackFor(created.id, { event_type: 'CUSTOMER.DISPUTE.CREATED' })),
    ).toBeNull()
  })

  it('refunds by capture id, reports PENDING as pending, and counts earlier refunds against what is left', async () => {
    const input = sampleInput({ amount: 1000 })
    const created = await gw.createPayment(input)
    fake.markPaid(created.id)
    const captureId = fake.order(created.id)?.purchase_units[0]?.payments?.captures[0]?.id ?? ''
    fake.nextRefund(captureId, 'PENDING')
    const r = await gw.refundPayment({
      paymentId: created.id,
      amount: 400,
      reason: 'damaged',
      idempotencyKey: 'r-1',
    })
    expect(r).toMatchObject({ paymentId: created.id, status: 'pending', amount: 400, currency: 'USD' })
    const sent = fake.requests.at(-1)
    expect(sent?.path).toBe(`/v2/payments/captures/${captureId}/refund`)
    expect(sent?.headers['paypal-request-id']).toBe('r-1')
    expect(sent?.body).toEqual({ amount: { currency_code: 'USD', value: '4.00' }, note_to_payer: 'damaged' })
    const before = fake.requests.length
    await expect(gw.refundPayment({ paymentId: created.id, amount: 601 })).rejects.toBeInstanceOf(
      GatewayError,
    )
    expect(paths(before).some((p) => p.endsWith('/refund'))).toBe(false)
    expect(await gw.refundPayment({ paymentId: created.id, amount: 600 })).toMatchObject({
      status: 'succeeded',
    })
    // Fully refunded: still reads as paid (the refund is the record), and nothing is left to refund.
    expect((await gw.getPayment(created.id)).status).toBe('paid')
    await expect(gw.refundPayment({ paymentId: created.id, amount: 1 })).rejects.toBeInstanceOf(GatewayError)
  })

  it('refuses a config without credentials or webhook id, and an unknown environment', () => {
    expect(() => paypal({ ...keys, clientSecret: '' })).toThrow(GatewayError)
    expect(() => paypal({ ...keys, webhookId: '' })).toThrow(GatewayError)
    expect(() => paypal({ ...keys, environment: 'prod' as 'live' })).toThrow(GatewayError)
  })
})
