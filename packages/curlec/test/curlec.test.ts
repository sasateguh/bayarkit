import { createHmac } from 'node:crypto'
import { type CallbackInput, confirmPayment, GatewayError } from '@bayarkit/core'
import { curlecWebhookSignature, gatewayConformance, sampleInput, startFakeCurlec } from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  curlec,
  linkStatus,
  orderStatus,
  verifyCheckoutSignature,
  verifyPaymentLinkSignature,
  verifyWebhookSignature,
} from '../src/index.js'

const keys = {
  keyId: 'rzp_test_fakeKeyId01',
  keySecret: 'fake-key-secret',
  webhookSecret: 'fake-webhook-secret',
}
const hmac = (secret: string, message: string) => createHmac('sha256', secret).update(message).digest('hex')

gatewayConformance('curlec', async () => {
  const fake = await startFakeCurlec(keys)
  return { fake, gateway: curlec({ ...keys, baseUrl: fake.url }) }
})

// Official test values, quoted from the docs and SDK tests (spec §Signatures); not credentials.
const DOC_SECRET = 'EnLs21M47BllR3X8PSFtjtbd' // gitleaks:allow (published example secret, CK L652 / PLA)
/**
 * razorpay-python tests/mocks/fake_payment_authorized_webhook.json, byte for byte (971 bytes, trailing newline):
 * the indentation and the final `\n` are part of the signed bytes.
 */
const PY_WEBHOOK = `{
  "event": "payment.authorized",
  "entity": "event",
  "contains": [
    "payment"
  ],
  "payload": {
    "payment": {
      "entity": {
        "id": "pay_6koWN7bvxujzxM",
        "entity": "payment",
        "amount": 1000000,
        "currency": "INR",
        "status": "captured",
        "order_id": "order_100000000order",
        "international": false,
        "method": "card",
        "amount_refunded": 0,
        "refund_status": null,
        "captured": true,
        "description": "random description",
        "card_id": "card_6koWNAT6LASUqy",
        "bank": null,
        "wallet": null,
        "vpa": null,
        "email": "a@b.com",
        "contact": "+919999999999",
        "notes": {
          "merchant_order_id": "random order id"
        },
        "fee": 23000,
        "service_tax": 3000,
        "error_code": null,
        "error_description": null,
        "created_at": 1479978483
      }
    }
  },
  "created_at": 1400826760
}
`

describe('curlec: every official test vector in the spec', () => {
  it('Checkout vector 1 (CK L652-654, L711-716; razorpay-node test): order_id|payment_id with the key secret', () => {
    const sig = '0d4e745a1838664ad6c9c9902212a32d627d68e917290b0ad5f08ff4561bc50f'
    expect(verifyCheckoutSignature('order_IEIaMR65cu6nz3', 'pay_IH4NVgf4Dreq1l', sig, DOC_SECRET)).toBe(true)
    const gw = curlec({ keyId: 'rzp_test_x', keySecret: DOC_SECRET })
    expect(
      gw.verifyCallback({
        fields: {
          razorpay_order_id: 'order_IEIaMR65cu6nz3',
          razorpay_payment_id: 'pay_IH4NVgf4Dreq1l',
          razorpay_signature: sig,
        },
        rawBody: '',
        headers: {},
      }),
    ).toMatchObject({ id: 'order_IEIaMR65cu6nz3', claimedStatus: 'paid' })
  })

  it('Checkout vector 2 (razorpay-python test_client_utility.py L13-21)', () => {
    expect(
      verifyCheckoutSignature(
        'fake_order_id',
        'fake_payment_id',
        'b2335e3b0801106b84a7faff035df56ecffde06918c9ddd1f0fafbb37a51cc89',
        'key_secret',
      ),
    ).toBe(true)
  })

  it('webhook vector 1 (razorpay-node test L95-108): secret 123456 over the raw body', () => {
    expect(
      verifyWebhookSignature(
        '{"a":1,"b":2,"c":{"d":3}}',
        '2fe04e22977002e6c7cb553adab8b460cb9e2a4970d5953cb27a8472752e3bbc',
        '123456',
      ),
    ).toBe(true)
  })

  it('webhook vector 2 (razorpay-python L66-72): the exact 971 bytes, trailing newline included', () => {
    const sig = 'd60e67fd884556c045e9be7dad57903e33efc7172c17c6e3ef77db42d2b366e9'
    expect(Buffer.byteLength(PY_WEBHOOK)).toBe(971)
    expect(verifyWebhookSignature(PY_WEBHOOK, sig, 'key_secret')).toBe(true)
    // Without the trailing newline the HMAC is 0971cde1…, so the same signature must fail.
    expect(hmac('key_secret', PY_WEBHOOK.slice(0, -1)).startsWith('0971cde1')).toBe(true)
    expect(verifyWebhookSignature(PY_WEBHOOK.slice(0, -1), sig, 'key_secret')).toBe(false)
    // Through the adapter: a payment.authorized event, read as a pending claim on its order.
    const gw = curlec({ keyId: 'rzp_test_x', keySecret: 'other', webhookSecret: 'key_secret' })
    expect(
      gw.verifyCallback({ fields: {}, rawBody: PY_WEBHOOK, headers: { 'x-razorpay-signature': sig } }),
    ).toMatchObject({ id: 'order_100000000order', claimedStatus: 'pending' })
  })

  it('Payment Link vector (PLA Java/Go samples): link_id|reference_id|status|payment_id with the key secret', () => {
    const p = {
      paymentLinkId: 'plink_IH3cNucfVEgV68',
      referenceId: 'TSsd1989',
      status: 'paid',
      paymentId: 'pay_IH3d0ara9bSsjQ',
    }
    const sig = '07ae18789e35093e51d0a491eb9922646f3f82773547e5b0f67ee3f2d3bf7d5b'
    expect(verifyPaymentLinkSignature(p, sig, DOC_SECRET)).toBe(true)
    const gw = curlec({ keyId: 'rzp_test_x', keySecret: DOC_SECRET })
    expect(
      gw.verifyCallback({
        fields: {
          razorpay_payment_id: p.paymentId,
          razorpay_payment_link_id: p.paymentLinkId,
          razorpay_payment_link_reference_id: p.referenceId,
          razorpay_payment_link_status: p.status,
          razorpay_signature: sig,
        },
        rawBody: '',
        headers: {},
      }),
    ).toMatchObject({ id: p.paymentLinkId, reference: 'TSsd1989', claimedStatus: 'paid' })
  })

  it('each vector fails with the key the OTHER signature uses (webhook secret ≠ API key secret)', () => {
    const sig = '0d4e745a1838664ad6c9c9902212a32d627d68e917290b0ad5f08ff4561bc50f'
    const gw = curlec({ keyId: 'rzp_test_x', keySecret: 'not-it', webhookSecret: DOC_SECRET })
    expect(
      gw.verifyCallback({
        fields: {
          razorpay_order_id: 'order_IEIaMR65cu6nz3',
          razorpay_payment_id: 'pay_IH4NVgf4Dreq1l',
          razorpay_signature: sig,
        },
        rawBody: '',
        headers: {},
      }),
    ).toBeNull()
    const webhookOnly = curlec({ keyId: 'rzp_test_x', keySecret: 'key_secret' })
    expect(
      webhookOnly.verifyCallback({
        fields: {},
        rawBody: PY_WEBHOOK,
        headers: {
          'x-razorpay-signature': 'd60e67fd884556c045e9be7dad57903e33efc7172c17c6e3ef77db42d2b366e9',
        },
      }),
    ).toBeNull()
  })
})

describe('curlec: contradictions in the docs, and the side the adapter takes', () => {
  let fake: Awaited<ReturnType<typeof startFakeCurlec>>
  let gw: ReturnType<typeof curlec>
  beforeAll(async () => {
    fake = await startFakeCurlec(keys)
    gw = curlec({ ...keys, baseUrl: fake.url })
  })
  afterAll(() => fake.close())

  it("1: the raw body verifies; the official Node sample's JSON.stringify(parsed) does not", async () => {
    const created = await gw.createPayment(sampleInput())
    const cb = fake.callbackFor(created.id)
    expect(gw.verifyCallback(cb)).not.toBeNull()
    const reserialised = JSON.stringify(JSON.parse(cb.rawBody))
    expect(reserialised).not.toBe(cb.rawBody)
    expect(gw.verifyCallback({ ...cb, rawBody: reserialised })).toBeNull()
    // A handler that verifies JSON.stringify(parsed) against Curlec's header rejects genuine webhooks whose bytes differ:
    expect(
      verifyWebhookSignature(reserialised, cb.headers['x-razorpay-signature'] ?? '', keys.webhookSecret),
    ).toBe(false)
    expect(
      verifyWebhookSignature(
        JSON.stringify(JSON.parse(PY_WEBHOOK)),
        'd60e67fd884556c045e9be7dad57903e33efc7172c17c6e3ef77db42d2b366e9',
        'key_secret',
      ),
    ).toBe(false)
  })

  it('2/3: the reference is unique per link and per order receipt: a retry is refused, never a second one', async () => {
    const input = sampleInput()
    await gw.createPayment(input)
    const again = await gw.createPayment(input).catch((e: unknown) => e)
    expect(again).toBeInstanceOf(GatewayError)
    expect(String((again as Error).message)).toMatch(/reference ID already attempted/)
    const order = { reference: `R${Date.now()}`, amount: 500 }
    await gw.createOrder(order)
    await expect(gw.createOrder(order)).rejects.toThrow(/Duplicate request/)
  })

  it('4: 100 sen (MYR 1.00) is accepted, 99 is refused before calling Curlec', async () => {
    expect(gw.info.minimumAmount).toBe(100)
    await expect(gw.createPayment(sampleInput({ amount: 100 }))).resolves.toMatchObject({
      id: expect.any(String),
    })
    const before = fake.requests.length
    await expect(gw.createPayment(sampleInput({ amount: 99 }))).rejects.toBeInstanceOf(GatewayError)
    expect(fake.requests.length).toBe(before)
  })

  it('5: a link that is `issued` or `created` is pending; only the order decides paid', () => {
    expect(linkStatus('issued')).toBe('pending')
    expect(linkStatus('created')).toBe('pending')
    expect(linkStatus('paid')).toBe('unknown')
    expect(linkStatus('cancelled')).toBe('cancelled')
    expect(linkStatus('expired')).toBe('expired')
  })

  it('6: a Payment Link redirect without reference_id is refused, whichever SDK convention signed it', async () => {
    const created = await gw.createPayment(sampleInput())
    const genuine = fake.redirectFor(created.id)
    expect(gw.verifyCallback(genuine)).toMatchObject({ id: created.id, claimedStatus: 'paid' })
    const { razorpay_payment_link_reference_id: _ref, ...rest } = genuine.fields
    for (const missing of ['undefined', '']) {
      const fields = {
        ...rest,
        razorpay_signature: hmac(
          keys.keySecret,
          `${rest.razorpay_payment_link_id}|${missing}|${rest.razorpay_payment_link_status}|${rest.razorpay_payment_id}`,
        ),
      }
      expect(gw.verifyCallback({ fields, rawBody: '', headers: {} })).toBeNull()
    }
  })

  it('8: amount travels as a JSON integer in sen (the Checkout samples\' string "50000" is refused by the API)', async () => {
    await gw.createPayment(sampleInput({ amount: 2345 }))
    const body = fake.requests.at(-1)?.body as Record<string, unknown>
    expect(body.amount).toBe(2345)
    expect(typeof body.amount).toBe('number')
    const res = await fetch(`${fake.url}/v1/orders`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount: '50000', currency: 'MYR' }),
    })
    expect(res.status).toBe(400)
  })

  it('12: a failure callback (error object, no signature) is refused, not read', () => {
    expect(
      gw.verifyCallback({
        fields: {
          'error[code]': 'BAD_REQUEST_ERROR',
          'error[description]': 'Payment failed',
          razorpay_order_id: 'order_IEIaMR65cu6nz3',
        },
        rawBody: '',
        headers: {},
      }),
    ).toBeNull()
  })
})

describe('curlec: orders, links and callbacks', () => {
  let fake: Awaited<ReturnType<typeof startFakeCurlec>>
  let gw: ReturnType<typeof curlec>
  beforeAll(async () => {
    fake = await startFakeCurlec(keys)
    gw = curlec({ ...keys, baseUrl: fake.url })
  })
  afterAll(() => fake.close())

  it('creates a Payment Link with Basic auth and the documented fields only', async () => {
    const input = sampleInput({ customer: { name: 'Ali', email: 'ali@example.com', phone: '+60123456789' } })
    const created = await gw.createPayment(input)
    expect(created.url).toMatch(/^https:\/\/rzp\.io\//)
    const sent = fake.requests.at(-1)
    expect(sent?.path).toBe('/v1/payment_links')
    expect(sent?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64')}`,
    )
    expect(sent?.body).toEqual({
      amount: input.amount,
      currency: 'MYR',
      accept_partial: false,
      reference_id: input.reference,
      description: input.description,
      customer: { name: 'Ali', email: 'ali@example.com', contact: '+60123456789' },
      notify: { sms: false, email: false },
      reminder_enable: false,
      callback_url: input.returnUrl,
      callback_method: 'get',
    })
  })

  it('drops a local phone number without a country code instead of rewriting it', async () => {
    await gw.createPayment(sampleInput({ customer: { name: 'Ali', phone: '012-345 6789' } }))
    expect((fake.requests.at(-1)?.body as Record<string, unknown> | undefined)?.customer).toEqual({
      name: 'Ali',
    })
  })

  it('refuses references Curlec would refuse or alter (over 40 characters, non-ASCII)', async () => {
    await expect(gw.createPayment(sampleInput({ reference: 'A'.repeat(41) }))).rejects.toThrow(/1–40/)
    await expect(gw.createPayment(sampleInput({ reference: 'ORDER-é' }))).rejects.toThrow(/ASCII/)
  })

  it('checks expire_by locally: at least 15 minutes ahead', async () => {
    const at = (s: number) => new Date(Date.now() + s * 1000)
    await expect(gw.createPayment(sampleInput({ expiresAt: at(10 * 60) }))).rejects.toThrow(/15 minutes/)
    const ok = await gw.createPayment(sampleInput({ expiresAt: at(3600) }))
    expect(fake.entity(ok.id)?.expire_by).toBe(Math.floor(at(3600).getTime() / 1000))
  })

  it("reports the ORDER's state: an opened link (order attempted) is pending, a paid order is paid", async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    expect((await gw.getPayment(created.id)).status).toBe('pending')
    fake.attempt(created.id)
    expect(fake.entity(String(fake.entity(created.id)?.order_id))?.status).toBe('attempted')
    expect((await gw.getPayment(created.id)).status).toBe('pending')
    fake.markPaid(created.id)
    expect(await gw.getPayment(created.id)).toMatchObject({
      id: created.id,
      reference: input.reference,
      status: 'paid',
      amount: input.amount,
      currency: 'MYR',
      fee: null,
    })
  })

  it('maps order states: only paid is paid', () => {
    expect(orderStatus('paid')).toBe('paid')
    expect(orderStatus('attempted')).toBe('pending')
    expect(orderStatus('created')).toBe('pending')
    expect(orderStatus('failed')).toBe('unknown')
    expect(orderStatus(undefined)).toBe('unknown')
  })

  it('Standard Checkout: createOrder, then the order_id|payment_id callback, confirmed only once the order is paid', async () => {
    const expected = { reference: `CK${Date.now()}`, amount: 1990 }
    const order = await gw.createOrder(expected)
    expect(fake.requests.at(-1)?.body).toEqual({ amount: 1990, currency: 'MYR', receipt: expected.reference })
    fake.attempt(order.id)
    const cb = fake.checkoutCallbackFor(order.id)
    expect(gw.verifyCallback(cb)).toMatchObject({ id: order.id, claimedStatus: 'paid' })
    expect(await confirmPayment(gw, cb, expected)).toMatchObject({ ok: false, reason: 'not_paid' })
    fake.markPaid(order.id)
    expect(await confirmPayment(gw, fake.checkoutCallbackFor(order.id), expected)).toMatchObject({ ok: true })
    expect(await confirmPayment(gw, fake.tamper(fake.checkoutCallbackFor(order.id)), expected)).toMatchObject(
      {
        ok: false,
        reason: 'invalid_signature',
      },
    )
  })

  it('a genuine Checkout callback for ANOTHER paid order is a mismatch (receipt ≠ your reference)', async () => {
    const other = await gw.createOrder({ reference: `OTHER${Date.now()}`, amount: 1990 })
    fake.markPaid(other.id)
    const result = await confirmPayment(gw, fake.checkoutCallbackFor(other.id), {
      reference: 'MY-ORDER',
      amount: 1990,
    })
    expect(result).toMatchObject({ ok: false, reason: 'mismatch' })
  })

  it('a webhook for an order (order.paid) is read with the order receipt as the reference', async () => {
    const order = await gw.createOrder({ reference: `WH${Date.now()}`, amount: 700 })
    const v = gw.verifyCallback(fake.callbackFor(order.id))
    expect(v).toMatchObject({ id: order.id, claimedStatus: 'paid', raw: { event: 'order.paid' } })
    expect(v?.reference).toMatch(/^WH/)
  })

  it('reads payment.failed as failed, and refuses events it does not handle', async () => {
    const created = await gw.createPayment(sampleInput())
    expect(
      gw.verifyCallback(fake.callbackFor(created.id, { event: 'payment.failed', status: 'failed' })),
    ).toMatchObject({
      claimedStatus: 'failed',
    })
    expect(gw.verifyCallback(fake.callbackFor(created.id, { event: 'refund.processed' }))).toBeNull()
  })

  it('refuses a webhook whose payment and order disagree on the order id', async () => {
    const created = await gw.createPayment(sampleInput())
    expect(gw.verifyCallback(fake.callbackFor(created.id, { order_id: 'order_SomeoneElse1' }))).toBeNull()
  })

  it('refuses every webhook when no webhook secret is configured', async () => {
    const created = await gw.createPayment(sampleInput())
    const noSecret = curlec({ keyId: keys.keyId, keySecret: keys.keySecret, baseUrl: fake.url })
    expect(noSecret.verifyCallback(fake.callbackFor(created.id))).toBeNull()
  })

  it('refuses a webhook signed with the API key secret instead of the webhook secret', async () => {
    const created = await gw.createPayment(sampleInput())
    const cb = fake.callbackFor(created.id)
    const wrong: CallbackInput = {
      ...cb,
      headers: { ...cb.headers, 'x-razorpay-signature': curlecWebhookSignature(keys.keySecret, cb.rawBody) },
    }
    expect(gw.verifyCallback(wrong)).toBeNull()
  })

  it('a header signature is never bypassed by also posting Checkout fields', async () => {
    const order = await gw.createOrder({ reference: `MIX${Date.now()}`, amount: 300 })
    const checkout = fake.checkoutCallbackFor(order.id)
    expect(gw.verifyCallback({ ...checkout, headers: { 'x-razorpay-signature': '0'.repeat(64) } })).toBeNull()
  })

  it('a wrong key is a GatewayError quoting Curlec, never the key', async () => {
    const bad = curlec({ ...keys, keySecret: 'secret-that-must-not-leak', baseUrl: fake.url })
    const err = await bad.createPayment(sampleInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).status).toBe(401)
    expect(String((err as Error).message)).toMatch(/Authentication failed/)
    expect(String((err as Error).message)).not.toContain('secret-that-must-not-leak')
  })

  it('masks a key id that Curlec echoes in an error', async () => {
    const echo = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 'BAD_REQUEST_ERROR', description: 'Key rzp_live_AbCdEf123 is not valid' },
        }),
        { status: 400 },
      )) as typeof fetch
    const g = curlec({ ...keys, fetch: echo })
    await expect(g.getPayment('order_X1')).rejects.toThrow(/\[redacted\]/)
  })

  it('refuses an id that could change the request path', async () => {
    await expect(gw.getPayment('plink_x/../../v1/payments')).rejects.toThrow(
      /invalid payment link or order id/,
    )
    await expect(gw.getPayment('pay_123')).rejects.toBeInstanceOf(GatewayError)
  })
})
