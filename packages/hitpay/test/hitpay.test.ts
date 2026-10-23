import { createHmac, randomUUID } from 'node:crypto'
import { type CallbackInput, confirmPayment, GatewayError } from '@bayarkit/core'
import { type FakeHitPay, gatewayConformance, sampleInput, startFakeHitPay } from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventSignature, formSignature, formSigningString, hitpay, requestStatus } from '../src/index.js'

const keys = {
  apiKey: 'fake-api-key-123',
  apiSalt: 'fake-api-salt-456',
  webhookSalt: 'fake-webhook-salt-789',
}
const make = (fake: FakeHitPay, extra: Partial<Parameters<typeof hitpay>[0]> = {}) =>
  hitpay({ ...keys, environment: 'sandbox', baseUrl: fake.url, ...extra })

gatewayConformance('hitpay (event webhook, Hitpay-Signature)', async () => {
  const fake = await startFakeHitPay(keys)
  return { fake, gateway: make(fake) }
})

gatewayConformance('hitpay (legacy per-request webhook, hmac field)', async () => {
  const fake = await startFakeHitPay(keys)
  return { fake: { ...fake, callbackFor: fake.formCallbackFor }, gateway: make(fake) }
})

describe('hitpay: signature vectors (spec §4 "Test vectors")', () => {
  // The spec records that HitPay publishes NO official vector: the one signed example (LF:4143) omits its salt.
  // These two are SELF-COMPUTED by the spec author from the PHP SDK algorithm, not HitPay's.
  const salt = 'test_salt_123'
  const v1Fields = {
    payment_id: '',
    payment_request_id: '92965a20-dae5-4d89-a452-5fdfa382dbe1',
    phone: '',
    amount: '599.00',
    currency: 'SGD',
    status: 'failed',
    reference_number: 'ABC123',
    error_message: 'Card declined',
  }
  const v1String =
    'amount599.00currencySGDerror_messageCard declinedpayment_idpayment_request_id92965a20-dae5-4d89-a452-5fdfa382dbe1phonereference_numberABC123statusfailed'
  const v1Hmac = 'ec41cf7733110562f43c1ea0a5357a93fa5625a88adb69fd32ea658718e54ffa'
  const v2Body = '{"id":"9ef68e2e-3569-4f69-9f68-04c7e4bb007c","status":"completed","amount":"100.00"}'
  const v2Sig = '05a8c91ec0413e4814e5829dbed9b08bf5f386240ac245a6cb80318f2ba63805'
  const gw = hitpay({ apiKey: 'k', apiSalt: salt, webhookSalt: salt, environment: 'sandbox' })

  it('self-computed v1 vector: signing string (sorted key+value, empty values kept, no hmac) and hmac', () => {
    expect(formSigningString({ ...v1Fields, hmac: 'ignored' })).toBe(v1String)
    expect(formSignature(salt, v1Fields)).toBe(v1Hmac)
  })

  it('self-computed v1 vector: verifyCallback accepts it and reads the failed status', () => {
    const v = gw.verifyCallback({ fields: { ...v1Fields, hmac: v1Hmac }, rawBody: '', headers: {} })
    expect(v).toMatchObject({
      id: '92965a20-dae5-4d89-a452-5fdfa382dbe1',
      reference: 'ABC123',
      claimedStatus: 'failed',
    })
  })

  it('self-computed v1 vector: dropping the empty fields (payment_id, phone) breaks it', () => {
    const { payment_id: _a, phone: _b, ...withoutEmpty } = v1Fields
    expect(formSignature(salt, withoutEmpty)).not.toBe(v1Hmac)
    expect(
      gw.verifyCallback({ fields: { ...withoutEmpty, hmac: v1Hmac }, rawBody: '', headers: {} }),
    ).toBeNull()
  })

  it('self-computed v2 vector: HMAC over the raw body, and verifyCallback accepts it', () => {
    expect(eventSignature(salt, v2Body)).toBe(v2Sig)
    const v = gw.verifyCallback({
      fields: {},
      rawBody: v2Body,
      headers: { 'content-type': 'application/json', 'hitpay-signature': v2Sig },
    })
    expect(v).toMatchObject({ id: '9ef68e2e-3569-4f69-9f68-04c7e4bb007c', claimedStatus: 'paid' })
  })

  it('self-computed v2 vector: the same JSON with different whitespace is refused', () => {
    const spaced = JSON.stringify(JSON.parse(v2Body), null, 1)
    expect(
      gw.verifyCallback({ fields: {}, rawBody: spaced, headers: { 'hitpay-signature': v2Sig } }),
    ).toBeNull()
  })
})

describe('hitpay: contradictions in the official materials (spec §6)', () => {
  let fake: FakeHitPay
  let gw: ReturnType<typeof hitpay>
  let paidId = ''
  beforeAll(async () => {
    fake = await startFakeHitPay(keys)
    gw = make(fake)
    paidId = (await gw.createPayment(sampleInput())).id
    fake.markPaid(paidId)
  })
  afterAll(() => fake.close())

  it("§6.3: a re-serialised body (the guide's JSON.stringify(req.body) Express sample) fails; the raw body passes", () => {
    const cb = fake.callbackFor(paidId)
    const reserialised = JSON.stringify(JSON.parse(cb.rawBody))
    expect(reserialised).not.toBe(cb.rawBody)
    expect(gw.verifyCallback(cb)).not.toBeNull()
    expect(gw.verifyCallback({ ...cb, rawBody: reserialised })).toBeNull()
  })

  it('§6.1: each scheme verifies only with its own salt', () => {
    const event = fake.callbackFor(paidId)
    const withApiSalt = createHmac('sha256', keys.apiSalt).update(event.rawBody).digest('hex')
    expect(
      gw.verifyCallback({ ...event, headers: { ...event.headers, 'hitpay-signature': withApiSalt } }),
    ).toBeNull()

    const form = fake.formCallbackFor(paidId)
    const { hmac: _h, ...signed } = form.fields
    const withWebhookSalt = formSignature(keys.webhookSalt, signed)
    expect(gw.verifyCallback({ ...form, fields: { ...signed, hmac: withWebhookSalt } })).toBeNull()
    expect(gw.verifyCallback(form)).toMatchObject({ id: paidId, claimedStatus: 'paid' })
  })

  it('§6.1: a bad Hitpay-Signature does not fall back to a valid hmac field', () => {
    const form = fake.formCallbackFor(paidId)
    expect(gw.verifyCallback(form)).not.toBeNull()
    expect(
      gw.verifyCallback({ ...form, headers: { ...form.headers, 'hitpay-signature': '0'.repeat(64) } }),
    ).toBeNull()
  })

  it('§6.1: an empty salt disables that scheme instead of verifying with an empty key', () => {
    const noWebhookSalt = make(fake, { webhookSalt: '' })
    const noApiSalt = make(fake, { apiSalt: '' })
    const emptyEvent = fake.callbackFor(paidId)
    const forged = {
      ...emptyEvent,
      headers: { ...emptyEvent.headers, 'hitpay-signature': eventSignature('', emptyEvent.rawBody) },
    }
    expect(noWebhookSalt.verifyCallback(forged)).toBeNull()
    const form = fake.formCallbackFor(paidId)
    const { hmac: _h, ...signed } = form.fields
    expect(
      noApiSalt.verifyCallback({ ...form, fields: { ...signed, hmac: formSignature('', signed) } }),
    ).toBeNull()
  })

  it('§6.2 + §6.4 + §6.10: create is form-encoded with amount in ringgit, webhook = callbackUrl, SMS/email off', async () => {
    const input = sampleInput({
      amount: 1050,
      customer: { name: 'Ali', email: 'ali@example.com', phone: '+60123456789' },
    })
    await gw.createPayment(input)
    const sent = fake.requests.at(-1)
    expect(sent?.contentType).toBe('application/x-www-form-urlencoded')
    expect(sent?.headers['x-business-api-key']).toBe(keys.apiKey)
    expect(sent?.headers['x-requested-with']).toBe('XMLHttpRequest')
    expect(sent?.body).toMatchObject({
      amount: '10.50',
      currency: 'MYR',
      reference_number: input.reference,
      redirect_url: input.returnUrl,
      webhook: input.callbackUrl,
      send_sms: 'false',
      send_email: 'false',
      purpose: input.description,
      name: 'Ali',
      email: 'ali@example.com',
      phone: '+60123456789',
    })
  })

  it("§6.4: the fake also takes the OpenAPI's JSON body, and refuses a request without X-Requested-With", async () => {
    const json = await fetch(`${fake.url}/v1/payment-requests`, {
      method: 'POST',
      headers: {
        'x-business-api-key': keys.apiKey,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount: 5, currency: 'MYR' }),
    })
    expect(json.status).toBe(201)
    expect(((await json.json()) as { amount: string }).amount).toBe('5.00')
    const bare = await fetch(`${fake.url}/v1/payment-requests`, {
      method: 'POST',
      headers: { 'x-business-api-key': keys.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 5, currency: 'MYR' }),
    })
    expect(bare.status).toBe(401)
  })

  it('§6.5–6.7: a signed event whose id is not a payment request (charge-shaped) never confirms', async () => {
    const input = sampleInput()
    const id = (await gw.createPayment(input)).id
    fake.markPaid(id)
    const charge = fake.callbackFor(id, { id: randomUUID(), status: 'succeeded' })
    expect(gw.verifyCallback(charge)?.claimedStatus).toBe('unknown')
    expect(await confirmPayment(gw, charge, input)).toMatchObject({ ok: false, reason: 'gateway_error' })
    expect(gw.verifyCallback(fake.callbackFor(id, { id: 'not-a-uuid' }))).toBeNull()
  })

  it('§6.9: the official CLI `trigger` posts no Hitpay-Signature, so its payload is refused', () => {
    const cb = fake.callbackFor(paidId)
    const { 'hitpay-signature': _s, ...headers } = cb.headers
    expect(gw.verifyCallback({ ...cb, headers: { ...headers, 'hitpay-event-object': 'event' } })).toBeNull()
  })
})

describe('hitpay: statuses, amounts, errors', () => {
  let fake: FakeHitPay
  let gw: ReturnType<typeof hitpay>
  beforeAll(async () => {
    fake = await startFakeHitPay(keys)
    gw = make(fake)
  })
  afterAll(() => fake.close())

  it('maps every documented payment-request status; only completed is paid', () => {
    expect(requestStatus('completed')).toBe('paid')
    expect(requestStatus('pending')).toBe('pending')
    expect(requestStatus('failed')).toBe('failed')
    expect(requestStatus('expired')).toBe('expired')
    expect(requestStatus('canceled')).toBe('cancelled')
    expect(requestStatus('inactive')).toBe('cancelled')
    expect(requestStatus('succeeded')).toBe('unknown')
    expect(requestStatus(undefined)).toBe('unknown')
  })

  for (const status of ['failed', 'expired', 'canceled', 'inactive', 'pending']) {
    it(`does not confirm a request the gateway reports as ${status}, even with a signed "completed" callback`, async () => {
      const input = sampleInput()
      const id = (await gw.createPayment(input)).id
      const record = fake.paymentRequest(id)
      if (record) record.status = status
      const result = await confirmPayment(gw, fake.callbackFor(id), input)
      expect(result).toMatchObject({ ok: false, reason: 'not_paid' })
      expect((await gw.getPayment(id)).status).toBe(requestStatus(status))
    })
  }

  it('a legacy form callback claiming failed reads as failed', async () => {
    const id = (await gw.createPayment(sampleInput())).id
    const cb = fake.formCallbackFor(id, { status: 'failed', error_message: 'Card declined' })
    expect(gw.verifyCallback(cb)?.claimedStatus).toBe('failed')
  })

  it('reads amounts in ringgit strings as sen, and refuses to round a 3-decimal amount into a match', async () => {
    const input = sampleInput({ amount: 1999 })
    const id = (await gw.createPayment(input)).id
    fake.markPaid(id)
    const record = await gw.getPayment(id)
    expect(record).toMatchObject({ amount: 1999, currency: 'MYR', reference: input.reference, fee: null })
    expect(record.paidAt).toBeUndefined()
    const raw = fake.paymentRequest(id)
    if (raw) raw.amount = '19.990'
    expect(Number.isNaN((await gw.getPayment(id)).amount)).toBe(true)
    expect(await confirmPayment(gw, fake.callbackFor(id), input)).toMatchObject({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('refuses the unsigned browser return (redirect_url?reference=…&status=completed)', async () => {
    const id = (await gw.createPayment(sampleInput())).id
    expect(
      gw.verifyCallback({ fields: { reference: id, status: 'completed' }, rawBody: '', headers: {} }),
    ).toBeNull()
  })

  it('quotes the 422 message and never a key', async () => {
    const leaky = hitpay({
      ...keys,
      environment: 'sandbox',
      fetch: async () =>
        new Response(JSON.stringify({ message: `Invalid Business API Key ${keys.apiKey}` }), { status: 401 }),
    })
    const err = await leaky.createPayment(sampleInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as Error).message).toContain('Invalid Business API Key')
    expect((err as Error).message).not.toContain(keys.apiKey)

    const big = await gw.createPayment(sampleInput({ amount: 100_000_000_000 })).catch((e: unknown) => e)
    expect(big).toBeInstanceOf(GatewayError)
    const res = await fetch(`${fake.url}/v1/payment-requests`, {
      method: 'POST',
      headers: { 'x-business-api-key': keys.apiKey, 'x-requested-with': 'XMLHttpRequest' },
      body: 'amount=0.1&currency=MYR',
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({
      errors: { amount: ['The amount must be between 0.3 and 999999999.99.'] },
    })
  })

  it('getPayment refuses a non-UUID id before calling, and quotes the documented 404', async () => {
    await expect(gw.getPayment('../v1/refund')).rejects.toMatchObject({ code: 'INVALID_ID' })
    const err = await gw.getPayment(randomUUID()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).status).toBe(404)
    expect((err as Error).message).toContain('No query results for model')
  })

  it('sends expires_after in whole minutes, rounded down; refuses less than a minute', async () => {
    await gw.createPayment(sampleInput({ expiresAt: new Date(Date.now() + 30 * 60_000 + 30_000) }))
    expect(fake.requests.at(-1)?.body.expires_after).toBe('30 mins')
    await expect(
      gw.createPayment(sampleInput({ expiresAt: new Date(Date.now() + 30_000) })),
    ).rejects.toMatchObject({
      code: 'INVALID_EXPIRY',
    })
  })

  it('leaves out a phone that is not E.164 and sends chosen payment methods', async () => {
    const withMethods = make(fake, { paymentMethods: ['fpx', 'card'] })
    await withMethods.createPayment(
      sampleInput({ customer: { name: 'A', email: 'a@example.com', phone: '0123456789' } }),
    )
    const sent = fake.requests.at(-1)
    expect(sent?.body.phone).toBeUndefined()
    expect(sent?.body['payment_methods[]']).toBe('fpx,card')
  })

  it('never throws on junk callbacks', () => {
    const junk: CallbackInput[] = [
      { fields: {}, rawBody: '', headers: { 'hitpay-signature': 'zz' } },
      { fields: { hmac: 'x'.repeat(64) }, rawBody: '', headers: {} },
      { fields: {}, rawBody: '[]', headers: { 'hitpay-signature': eventSignature(keys.webhookSalt, '[]') } },
      {
        fields: {},
        rawBody: 'null',
        headers: { 'hitpay-signature': eventSignature(keys.webhookSalt, 'null') },
      },
      { fields: {}, rawBody: '{', headers: { 'hitpay-signature': eventSignature(keys.webhookSalt, '{') } },
      null as unknown as CallbackInput,
    ]
    for (const cb of junk) {
      expect(() => gw.verifyCallback(cb)).not.toThrow()
      expect(gw.verifyCallback(cb)).toBeNull()
    }
  })
})
