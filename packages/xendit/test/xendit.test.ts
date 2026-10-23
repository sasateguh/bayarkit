import { type CallbackInput, confirmPayment, GatewayError } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFakeXendit, XENDIT_API_VERSION } from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  API_VERSION,
  paymentRequestStatus,
  ringgitToSen,
  senToRinggit,
  sessionStatus,
  verifyCallbackToken,
  xendit,
} from '../src/index.js'

const keys = { secretKey: 'xnd_development_fakeKey123', callbackToken: 'fake-webhook-verification-token' }

gatewayConformance('xendit', async () => {
  const fake = await startFakeXendit(keys)
  return { fake, gateway: xendit({ ...keys, baseUrl: fake.url }) }
})

/** A fetch that answers one JSON body and records what was asked. */
const stubFetch = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { f, calls }
}

const withToken = (cb: CallbackInput, token: string | undefined): CallbackInput => {
  const { 'x-callback-token': _drop, ...rest } = cb.headers
  return { ...cb, headers: token === undefined ? rest : { ...rest, 'x-callback-token': token } }
}

describe('xendit: official examples (the spec publishes no token or signature test vector)', () => {
  // docs.xendit.co/apidocs/payment-webhook-notification.md, example `paymentCapture` (embedded OpenAPI), verbatim.
  const officialCapture = JSON.stringify({
    event: 'payment.capture',
    business_id: '603f1c4172bbe840979fd408',
    created: '2026-08-26T07:28:23.731Z',
    data: {
      payment_id: 'py-66269236-7447-450f-b0d8-ed4255b11d8a',
      business_id: '603f1c4172bbe840979fd408',
      reference_id: 'nw-2026-08-26T07:28:23.260Z',
      payment_request_id: 'pr-c5a38204-58a9-4968-a8ad-68a79b172a66',
      customer_id: 'cust-279ab1f7-3b7a-43f0-8f5e-7a2835a854a8',
      type: 'PAY',
      country: 'ID',
      currency: 'IDR',
      request_amount: 1234,
      capture_method: 'AUTOMATIC',
      channel_code: 'DANA',
      status: 'SUCCEEDED',
      captures: [
        {
          capture_id: 'cptr-66269236-7447-450f-b0d8-ed4255b11d8a',
          capture_timestamp: '2026-08-26T07:28:37.2Z',
          capture_amount: 1234,
        },
      ],
      payment_details: {},
      metadata: { metametadata: 'metametametadata' },
      created: '2026-08-26T07:28:23.731Z',
      updated: '2026-08-26T07:28:37.032Z',
    },
  })
  const gw = xendit(keys)

  it('reads the official payment.capture example when x-callback-token equals the configured token', () => {
    const v = gw.verifyCallback({
      fields: {},
      rawBody: officialCapture,
      headers: { 'content-type': 'application/json', 'x-callback-token': keys.callbackToken },
    })
    expect(v).toEqual({
      id: 'pr-c5a38204-58a9-4968-a8ad-68a79b172a66',
      reference: 'nw-2026-08-26T07:28:23.260Z',
      claimedStatus: 'paid',
      raw: {
        event: 'payment.capture',
        id: 'pr-c5a38204-58a9-4968-a8ad-68a79b172a66',
        reference_id: 'nw-2026-08-26T07:28:23.260Z',
        status: 'SUCCEEDED',
        payment_id: 'py-66269236-7447-450f-b0d8-ed4255b11d8a',
        business_id: '603f1c4172bbe840979fd408',
      },
    })
  })

  it('refuses the same official body with a wrong, missing, empty or differently-cased token', () => {
    const cb = { fields: {}, rawBody: officialCapture, headers: { 'x-callback-token': keys.callbackToken } }
    for (const t of [undefined, '', 'wrong', keys.callbackToken.toUpperCase(), `${keys.callbackToken} `]) {
      expect(gw.verifyCallback(withToken(cb, t))).toBeNull()
    }
  })

  it('the only check is constant_time_equals(header, configured token) (spec §4)', () => {
    expect(verifyCallbackToken('abc', 'abc')).toBe(true)
    expect(verifyCallbackToken('abd', 'abc')).toBe(false)
    expect(verifyCallbackToken('abcd', 'abc')).toBe(false)
    expect(verifyCallbackToken('', '')).toBe(false)
    expect(verifyCallbackToken(undefined, 'abc')).toBe(false)
  })

  it('authenticates with Basic base64("<key>:") (empty password), as the quick-setup page shows', async () => {
    const fake = await startFakeXendit(keys)
    try {
      await xendit({ ...keys, baseUrl: fake.url }).createPayment(sampleInput())
      const expected = `Basic ${Buffer.from(`${keys.secretKey}:`).toString('base64')}`
      expect(fake.requests.at(-1)?.headers.authorization).toBe(expected)
      // And the fake answers 401 INVALID_API_KEY for any other key, quoted without the key.
      const wrong = xendit({ ...keys, secretKey: 'xnd_development_otherKey', baseUrl: fake.url })
      const err = await wrong.createPayment(sampleInput()).catch((e) => e)
      expect(err).toBeInstanceOf(GatewayError)
      expect(err.code).toBe('INVALID_API_KEY')
      expect(err.message).not.toContain('otherKey')
    } finally {
      await fake.close()
    }
  })

  it('routes the official session id example (ps- + 24 hex, 27 characters) to GET /sessions/{id}', async () => {
    const official = 'ps-661f87c614802d6c402cd82d'
    expect(official).toHaveLength(27)
    const { f, calls } = stubFetch(200, {
      payment_session_id: official,
      reference_id: 'Alice',
      session_type: 'PAY',
      currency: 'MYR',
      amount: 10.5,
      status: 'ACTIVE',
    })
    const rec = await xendit({ ...keys, fetch: f }).getPayment(official)
    expect(calls[0]?.url).toBe(`https://api.xendit.co/sessions/${official}`)
    expect(calls[0]?.init.method).toBe('GET')
    expect(rec).toMatchObject({
      id: official,
      reference: 'Alice',
      status: 'pending',
      amount: 1050,
      currency: 'MYR',
    })
  })

  it('a payment request id (pr-…, as in the official examples) is read from /v3 with api-version 2024-11-11', async () => {
    expect(API_VERSION).toBe('2024-11-11')
    const id = 'pr-c5a38204-58a9-4968-a8ad-68a79b172a66'
    const { f, calls } = stubFetch(200, {
      payment_request_id: id,
      reference_id: 'R1',
      status: 'SUCCEEDED',
      currency: 'MYR',
      request_amount: 150,
    })
    const rec = await xendit({ ...keys, fetch: f }).getPayment(id)
    expect(calls[0]?.url).toBe(`https://api.xendit.co/v3/payment_requests/${id}`)
    const sent = (calls[0]?.init.headers ?? {}) as Record<string, string>
    expect(sent['api-version']).toBe('2024-11-11')
    expect(rec).toMatchObject({ status: 'paid', amount: 15_000 })
  })

  it('refuses ids that are neither, before calling Xendit', async () => {
    const { f, calls } = stubFetch(200, {})
    const gw2 = xendit({ ...keys, fetch: f })
    for (const id of ['', 'ps-short', '../sessions', 'ps-661f87c614802d6c402cd82d/cancel', 'inv-1'])
      await expect(gw2.getPayment(id)).rejects.toBeInstanceOf(GatewayError)
    expect(calls).toHaveLength(0)
  })
})

describe('xendit: amounts are ringgit at the API, sen at the interface', () => {
  let fake: Awaited<ReturnType<typeof startFakeXendit>>
  let gw: ReturnType<typeof xendit>
  beforeAll(async () => {
    fake = await startFakeXendit(keys)
    gw = xendit({ ...keys, baseUrl: fake.url })
  })
  afterAll(() => fake.close())

  it('sends 1050 sen as the JSON number 10.5 and reads it back as 1050', async () => {
    const created = await gw.createPayment(sampleInput({ amount: 1050 }))
    const body = fake.requests.at(-1)?.body
    expect(body?.amount).toBe(10.5)
    expect(typeof body?.amount).toBe('number')
    expect((await gw.getPayment(created.id)).amount).toBe(1050)
  })

  it('round-trips every awkward sen value exactly', () => {
    for (const sen of [100, 101, 107, 1099, 123_456, 3_000_000, 99_999_999]) {
      expect(ringgitToSen(senToRinggit(sen))).toBe(sen)
      expect(String(senToRinggit(sen))).toMatch(/^\d+(\.\d{1,2})?$/)
    }
  })

  it('reads a fraction of a sen, a string or a negative as NaN (mismatch, never rounded to a match)', () => {
    expect(ringgitToSen(10.505)).toBeNaN()
    expect(ringgitToSen('10.50')).toBeNaN()
    expect(ringgitToSen(-1)).toBeNaN()
    expect(ringgitToSen(null)).toBeNaN()
  })

  it('declares a 100 sen minimum (RM 1 on every MY channel page; session minimum UNCONFIRMED)', async () => {
    expect(gw.info.minimumAmount).toBe(100)
    await expect(gw.createPayment(sampleInput({ amount: 99 }))).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    })
  })

  it('sends PAY / PAYMENT_LINK / AUTOMATIC / MYR / MY and no customer, metadata or callback URL', async () => {
    await gw.createPayment(sampleInput())
    const body = fake.requests.at(-1)?.body ?? {}
    expect(body).toMatchObject({
      session_type: 'PAY',
      mode: 'PAYMENT_LINK',
      capture_method: 'AUTOMATIC',
      currency: 'MYR',
      country: 'MY',
      success_return_url: 'https://shop.example/return',
      cancel_return_url: 'https://shop.example/return',
    })
    for (const k of ['customer', 'customer_id', 'metadata', 'callback_url', 'idempotency-key'])
      expect(body).not.toHaveProperty(k)
    expect(fake.requests.at(-1)?.headers['idempotency-key']).toBeUndefined()
  })
})

describe('xendit: session rules from the create-session reference', () => {
  let fake: Awaited<ReturnType<typeof startFakeXendit>>
  let gw: ReturnType<typeof xendit>
  beforeAll(async () => {
    fake = await startFakeXendit(keys)
    gw = xendit({ ...keys, baseUrl: fake.url })
  })
  afterAll(() => fake.close())

  it('refuses a non-HTTPS return URL before calling Xendit (the fake answers INVALID_URL too)', async () => {
    const before = fake.requests.length
    await expect(gw.createPayment(sampleInput({ returnUrl: 'http://shop.example/r' }))).rejects.toMatchObject(
      {
        code: 'INVALID_URL',
      },
    )
    expect(fake.requests.length).toBe(before)
    const res = await fetch(`${fake.url}/sessions`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${keys.secretKey}:`).toString('base64')}` },
      body: JSON.stringify({
        reference_id: 'R',
        session_type: 'PAY',
        mode: 'PAYMENT_LINK',
        amount: 5,
        currency: 'MYR',
        country: 'MY',
        success_return_url: 'http://x',
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error_code: string }).error_code).toBe('INVALID_URL')
  })

  it("C7: sends expires_at (not the overview's expiry_date), and only when at least 10 minutes ahead", async () => {
    await expect(
      gw.createPayment(sampleInput({ expiresAt: new Date(Date.now() + 9 * 60_000) })),
    ).rejects.toMatchObject({ code: 'INVALID_EXPIRY' })
    const at = new Date(Date.now() + 11 * 60_000)
    const created = await gw.createPayment(sampleInput({ expiresAt: at }))
    const body = fake.requests.at(-1)?.body ?? {}
    expect(body.expires_at).toBe(at.toISOString())
    expect(body).not.toHaveProperty('expiry_date')
    expect(fake.session(created.id)?.expires_at).toBe(at.toISOString())
  })

  it('without expiresAt the session expires 30 minutes after creation (the documented default)', async () => {
    const created = await gw.createPayment(sampleInput())
    const ahead = Date.parse(String(fake.session(created.id)?.expires_at)) - Date.now()
    expect(ahead).toBeGreaterThan(29 * 60_000)
    expect(ahead).toBeLessThanOrEqual(30 * 60_000)
  })

  it('refuses a reference longer than 64 characters', async () => {
    await expect(gw.createPayment(sampleInput({ reference: 'x'.repeat(65) }))).rejects.toMatchObject({
      code: 'INVALID_REFERENCE',
    })
  })

  it('cancelPayment: ACTIVE → CANCELED (one L) → cancelled; an expired session reads expired', async () => {
    const a = await gw.createPayment(sampleInput())
    expect((await gw.cancelPayment(a.id)).status).toBe('cancelled')
    expect(fake.session(a.id)?.status).toBe('CANCELED')
    await expect(gw.cancelPayment(a.id)).rejects.toBeInstanceOf(GatewayError)
    const b = await gw.createPayment(sampleInput())
    fake.expire(b.id)
    expect((await gw.getPayment(b.id)).status).toBe('expired')
  })
})

describe('xendit: the token is the only check, so confirmPayment carries the weight', () => {
  let fake: Awaited<ReturnType<typeof startFakeXendit>>
  let gw: ReturnType<typeof xendit>
  beforeAll(async () => {
    fake = await startFakeXendit(keys)
    gw = xendit({ ...keys, baseUrl: fake.url })
  })
  afterAll(() => fake.close())

  it('the body is NOT covered: a re-serialised or altered body with the right token still verifies…', async () => {
    const created = await gw.createPayment(sampleInput())
    const cb = fake.callbackFor(created.id)
    const reserialised = JSON.stringify(JSON.parse(cb.rawBody), null, 2)
    expect(gw.verifyCallback({ ...cb, rawBody: reserialised })).not.toBeNull()
    const altered = JSON.parse(cb.rawBody)
    altered.data.amount = 0.01
    expect(gw.verifyCallback({ ...cb, rawBody: JSON.stringify(altered) })).not.toBeNull()
  })

  it('…so an altered "paid" body for an unpaid session is refused by the fresh GET, not by the token', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    const cb = fake.callbackFor(created.id)
    expect(await confirmPayment(gw, cb, input)).toMatchObject({ ok: false, reason: 'not_paid' })
  })

  it("a leaked token + another paid order's id is refused as a mismatch", async () => {
    const mine = sampleInput()
    const other = sampleInput({ amount: 100 })
    const otherCreated = await gw.createPayment(other)
    fake.markPaid(otherCreated.id)
    const forged = fake.callbackFor(otherCreated.id, { reference_id: mine.reference })
    expect(await confirmPayment(gw, forged, mine)).toMatchObject({ ok: false, reason: 'mismatch' })
  })

  it('parses the RAW body, not the parsed fields (fields are ignored)', () => {
    const v = gw.verifyCallback({
      fields: { event: 'payment_session.completed', payment_session_id: 'ps-661f87c614802d6c402cd82d' },
      rawBody: '',
      headers: { 'x-callback-token': keys.callbackToken },
    })
    expect(v).toBeNull()
  })

  it('refuses the API key presented as the token (the token is issued separately, not derived from the key)', async () => {
    const created = await gw.createPayment(sampleInput())
    expect(gw.verifyCallback(withToken(fake.callbackFor(created.id), keys.secretKey))).toBeNull()
  })

  it('reads payment.capture: id = payment request, confirmed paid only after the payment succeeded', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    const early = fake.paymentCallbackFor(created.id)
    const v = gw.verifyCallback(early)
    expect(v?.id).toMatch(/^pr-/)
    expect(v?.claimedStatus).toBe('paid')
    expect(await confirmPayment(gw, early, input)).toMatchObject({ ok: false, reason: 'not_paid' })
    fake.markPaid(created.id)
    const result = await confirmPayment(gw, fake.paymentCallbackFor(created.id), input)
    expect(result).toMatchObject({
      ok: true,
      payment: { amount: input.amount, currency: 'MYR', reference: input.reference },
    })
    if (result.ok) expect(result.payment.paidAt).toBeInstanceOf(Date)
  })

  it('a payment collected after the session was cancelled: the session says cancelled, payment.capture confirms', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    fake.markPaid(created.id)
    const s = fake.session(created.id)
    if (s) s.status = 'CANCELED' // the documented behaviour: the session status is NOT updated by a late payment
    expect(await confirmPayment(gw, fake.callbackFor(created.id), input)).toMatchObject({
      ok: false,
      reason: 'not_paid',
    })
    expect(await confirmPayment(gw, fake.paymentCallbackFor(created.id), input)).toMatchObject({ ok: true })
  })

  it('reads other events (refunds, unknown) as null', async () => {
    const created = await gw.createPayment(sampleInput())
    for (const event of ['refund.succeeded', 'refund.failed', 'payment_request.expiry', 'invoice.paid', ''])
      expect(gw.verifyCallback(fake.callbackFor(created.id, { event }))).toBeNull()
  })
})

describe('xendit: contradictions recorded in the spec (§9)', () => {
  let fake: Awaited<ReturnType<typeof startFakeXendit>>
  let gw: ReturnType<typeof xendit>
  beforeAll(async () => {
    fake = await startFakeXendit(keys)
    gw = xendit({ ...keys, baseUrl: fake.url })
  })
  afterAll(() => fake.close())

  it('C1: a session webhook authenticated by Basic auth (as its OpenAPI says) and no token is refused', async () => {
    const created = await gw.createPayment(sampleInput())
    const cb = withToken(fake.callbackFor(created.id), undefined)
    const basic = `Basic ${Buffer.from(`${keys.secretKey}:`).toString('base64')}`
    expect(gw.verifyCallback({ ...cb, headers: { ...cb.headers, authorization: basic } })).toBeNull()
    expect(
      gw.verifyCallback({
        ...cb,
        headers: {
          ...cb.headers,
          authorization: `Basic ${Buffer.from(`${keys.callbackToken}:`).toString('base64')}`,
        },
      }),
    ).toBeNull()
    // With the token, as the prose docs say, the same session webhook verifies.
    expect(gw.verifyCallback(fake.callbackFor(created.id))).toMatchObject({
      id: created.id,
      claimedStatus: 'paid',
    })
  })

  it('C2: an ECDSA "signature" field in the body (Magento TPI channel) never stands in for the token', async () => {
    const created = await gw.createPayment(sampleInput())
    const cb = fake.callbackFor(created.id, { signature: Buffer.alloc(96, 1).toString('base64') })
    expect(gw.verifyCallback(withToken(cb, undefined))).toBeNull()
  })

  it('C3: a session webhook without amount/currency/country still verifies; amounts come from the GET', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    fake.markPaid(created.id)
    const cb = fake.callbackFor(created.id)
    const body = JSON.parse(cb.rawBody)
    delete body.data.amount
    delete body.data.currency
    delete body.data.country
    const stripped = { ...cb, rawBody: JSON.stringify(body) }
    expect(gw.verifyCallback(stripped)).not.toBeNull()
    expect(await confirmPayment(gw, stripped, input)).toMatchObject({
      ok: true,
      payment: { amount: input.amount },
    })
  })

  it('C5: CANCELED (enum) and CANCELLED (agent skill) both read as cancelled, never paid', () => {
    expect(sessionStatus({ status: 'CANCELED', session_type: 'PAY' })).toBe('cancelled')
    expect(sessionStatus({ status: 'CANCELLED', session_type: 'PAY' })).toBe('cancelled')
    expect(paymentRequestStatus({ status: 'CANCELED' })).toBe('cancelled')
  })

  it('C8 / C12: payment.failure, payment.failed and payment.expiry are read as claims; the GET decides', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    for (const [event, status, claim] of [
      ['payment.failure', 'FAILED', 'failed'],
      ['payment.failed', 'FAILED', 'failed'],
      ['payment.expiry', 'EXPIRED', 'expired'],
    ] as const) {
      const cb = fake.paymentCallbackFor(created.id, { event, status })
      expect(gw.verifyCallback(cb)?.claimedStatus).toBe(claim)
      expect(await confirmPayment(gw, cb, input)).toMatchObject({ ok: false, reason: 'not_paid' })
    }
  })

  it('C9: the fake requires api-version on /v3 (the guide says required, the OpenAPI does not); the adapter sends it', async () => {
    const created = await gw.createPayment(sampleInput())
    fake.markPaid(created.id)
    const prId = String(fake.session(created.id)?.payment_request_id)
    const res = await fetch(`${fake.url}/v3/payment_requests/${prId}`, {
      headers: { authorization: `Basic ${Buffer.from(`${keys.secretKey}:`).toString('base64')}` },
    })
    expect(res.status).toBe(400)
    expect((await gw.getPayment(prId)).status).toBe('paid')
    expect(fake.requests.at(-1)?.headers['api-version']).toBe(XENDIT_API_VERSION)
  })
})

describe('xendit: status mapping (only COMPLETED PAY sessions and SUCCEEDED payment requests are paid)', () => {
  it('sessions', () => {
    expect(sessionStatus({ status: 'COMPLETED', session_type: 'PAY', capture_method: 'AUTOMATIC' })).toBe(
      'paid',
    )
    expect(sessionStatus({ status: 'COMPLETED', session_type: 'PAY', capture_method: 'MANUAL' })).toBe(
      'pending',
    )
    expect(sessionStatus({ status: 'COMPLETED', session_type: 'SAVE' })).toBe('unknown')
    expect(sessionStatus({ status: 'COMPLETED' })).toBe('unknown')
    expect(sessionStatus({ status: 'ACTIVE', session_type: 'PAY' })).toBe('pending')
    expect(sessionStatus({ status: 'EXPIRED', session_type: 'PAY' })).toBe('expired')
    for (const s of ['PAID', 'SETTLED', 'SUCCEEDED', 'completed', undefined])
      expect(sessionStatus({ status: s, session_type: 'PAY' })).toBe('unknown')
  })

  it('payment requests', () => {
    expect(paymentRequestStatus({ status: 'SUCCEEDED' })).toBe('paid')
    for (const s of ['REQUIRES_ACTION', 'ACCEPTING_PAYMENTS', 'AUTHORIZED', 'PENDING'])
      expect(paymentRequestStatus({ status: s })).toBe('pending')
    expect(paymentRequestStatus({ status: 'FAILED' })).toBe('failed')
    expect(paymentRequestStatus({ status: 'EXPIRED' })).toBe('expired')
    for (const s of ['PAID', 'COMPLETED', 'succeeded', undefined])
      expect(paymentRequestStatus({ status: s })).toBe('unknown')
  })

  it('a manual-capture session that completed (authorised only) is not confirmed', async () => {
    const fake = await startFakeXendit(keys)
    try {
      const gw = xendit({ ...keys, baseUrl: fake.url })
      const input = sampleInput()
      const created = await gw.createPayment(input)
      fake.markPaid(created.id)
      const s = fake.session(created.id)
      if (s) s.capture_method = 'MANUAL'
      expect(await confirmPayment(gw, fake.callbackFor(created.id), input)).toMatchObject({
        ok: false,
        reason: 'not_paid',
      })
    } finally {
      await fake.close()
    }
  })
})

describe('xendit: configuration and errors', () => {
  it('the key prefix decides the mode; anything else, or a mismatching environment, is refused', () => {
    expect(() => xendit({ ...keys, secretKey: 'sk_test_x' })).toThrow(GatewayError)
    expect(() => xendit({ ...keys, secretKey: 'xnd_public_development_x' })).toThrow(GatewayError)
    expect(() => xendit({ ...keys, environment: 'live' })).toThrow(/test key/)
    expect(() => xendit({ ...keys, secretKey: 'xnd_production_x', environment: 'test' })).toThrow(/live key/)
    expect(() => xendit({ ...keys, secretKey: 'xnd_production_x', environment: 'live' })).not.toThrow()
    expect(() => xendit({ ...keys, callbackToken: '' })).toThrow(GatewayError)
  })

  it('never puts the key in a config error', () => {
    try {
      xendit({ ...keys, secretKey: 'not-a-key-SECRET' })
    } catch (e) {
      expect(String(e)).not.toContain('SECRET')
    }
  })

  it("quotes Xendit's message and error_code, masking anything shaped like a key and the webhook token", async () => {
    const { f } = stubFetch(401, {
      error_code: 'INVALID_API_KEY',
      message: `key xnd_development_fakeKey123 rejected; token ${keys.callbackToken}`,
    })
    const err = await xendit({ ...keys, fetch: f })
      .createPayment(sampleInput())
      .catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err.code).toBe('INVALID_API_KEY')
    expect(err.status).toBe(401)
    expect(err.message).not.toContain('fakeKey123')
    expect(err.message).not.toContain(keys.callbackToken)
  })

  it('refuses a create answer without a ps- id or an https payment_link_url', async () => {
    const { f } = stubFetch(201, {
      payment_session_id: 'ps-661f87c614802d6c402cd82d',
      payment_link_url: 'javascript:alert(1)',
    })
    await expect(xendit({ ...keys, fetch: f }).createPayment(sampleInput())).rejects.toBeInstanceOf(
      GatewayError,
    )
  })
})
