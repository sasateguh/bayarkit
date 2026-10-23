import { generateKeyPairSync } from 'node:crypto'
import { confirmPayment, GatewayError } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFakeChip } from '@bayarkit/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chip, decodePublicKey, hasExplicitPort, mapStatus } from '../src/index.js'

const keys = { secretKey: 'test_fake-secret', brandId: '00000000-0000-0000-0000-000000000003' }

gatewayConformance('chip', async () => {
  const fake = await startFakeChip(keys)
  const publicKey = await chip({ ...keys, environment: 'test', baseUrl: fake.url }).fetchPublicKey()
  return { fake, gateway: chip({ ...keys, publicKey, environment: 'test', baseUrl: fake.url }) }
})

describe('chip: rules from the official OpenAPI', () => {
  let fake: Awaited<ReturnType<typeof startFakeChip>>
  let gw: ReturnType<typeof chip>
  let publicKey: string

  beforeAll(async () => {
    fake = await startFakeChip(keys)
    publicKey = await chip({ ...keys, environment: 'test', baseUrl: fake.url }).fetchPublicKey()
    gw = chip({ ...keys, environment: 'test', publicKey, baseUrl: fake.url })
  })
  afterAll(() => fake.close())

  it('decodes GET /public_key/ as a JSON-encoded string, not a bare PEM or an object', () => {
    expect(publicKey).toBe(fake.publicKey)
    expect(publicKey.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true)
    expect(decodePublicKey(JSON.stringify(fake.publicKey))).toBe(fake.publicKey)
    expect(decodePublicKey(fake.publicKey)).toBeNull() // bare PEM is not what CHIP sends
    expect(decodePublicKey(JSON.stringify({ public_key: fake.publicKey }))).toBeNull() // PHP SDK's wrong shape
  })

  it('accepts a public key stored with literal \\n sequences (environment variables)', async () => {
    const g = chip({
      ...keys,
      environment: 'test',
      publicKey: publicKey.replace(/\n/g, '\\n'),
      baseUrl: fake.url,
    })
    const created = await g.createPayment(sampleInput())
    expect(g.verifyCallback(fake.callbackFor(created.id))).not.toBeNull()
  })

  it('refuses a public key that is not RSA', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString()
    expect(() => chip({ ...keys, environment: 'test', publicKey: ec })).toThrow(GatewayError)
    expect(() => chip({ ...keys, environment: 'test', publicKey: 'not a key' })).toThrow(GatewayError)
  })

  it('verifies X-Signature over the RAW body: the same JSON re-serialised does not verify', async () => {
    const created = await gw.createPayment(sampleInput())
    const cb = fake.callbackFor(created.id)
    expect(gw.verifyCallback(cb)).toMatchObject({ id: created.id, claimedStatus: 'paid' })
    const reserialised = JSON.stringify(JSON.parse(cb.rawBody), null, 2)
    expect(reserialised).not.toBe(cb.rawBody)
    expect(gw.verifyCallback({ ...cb, rawBody: reserialised })).toBeNull()
    expect(gw.verifyCallback({ ...cb, rawBody: `${cb.rawBody} ` })).toBeNull()
  })

  it('ignores the parsed fields: only the signed raw body decides id, reference and status', async () => {
    const created = await gw.createPayment(sampleInput({ reference: 'REAL-REF' }))
    const cb = fake.callbackFor(created.id)
    const v = gw.verifyCallback({ ...cb, fields: { ...cb.fields, id: 'other', reference: 'FORGED' } })
    expect(v).toMatchObject({ id: created.id, reference: 'REAL-REF' })
  })

  it('returns null without a configured public key, without the header, or with bad base64', async () => {
    const created = await gw.createPayment(sampleInput())
    const cb = fake.callbackFor(created.id)
    expect(chip({ ...keys, environment: 'test' }).verifyCallback(cb)).toBeNull()
    expect(gw.verifyCallback({ ...cb, headers: { 'content-type': 'application/json' } })).toBeNull()
    expect(
      gw.verifyCallback({ ...cb, headers: { ...cb.headers, 'x-signature': '%%%not-base64%%%' } }),
    ).toBeNull()
    expect(gw.verifyCallback({ ...cb, headers: { ...cb.headers, 'x-signature': '' } })).toBeNull()
    expect(gw.verifyCallback({ ...cb, rawBody: '' })).toBeNull()
  })

  it('a callback signed by another key does not verify', async () => {
    const other = await startFakeChip(keys)
    const g = chip({ ...keys, environment: 'test', baseUrl: other.url })
    const created = await g.createPayment(sampleInput())
    expect(gw.verifyCallback(other.callbackFor(created.id))).toBeNull()
    await other.close()
  })

  it('refuses a callbackUrl with an explicit port before calling CHIP (even :443)', async () => {
    const before = fake.requests.length
    for (const callbackUrl of [
      'https://shop.example:443/cb',
      'https://shop.example:8443/cb',
      'http://shop.example:80/cb',
      'https://user:pw@shop.example:443/cb',
      'http://[::1]:8080/cb',
    ]) {
      await expect(gw.createPayment(sampleInput({ callbackUrl }))).rejects.toMatchObject({
        code: 'webhooks_callback_port',
      })
    }
    await expect(
      gw.createPayment(sampleInput({ callbackUrl: 'ftp://shop.example/cb' })),
    ).rejects.toMatchObject({
      code: 'webhooks_callback_scheme',
    })
    expect(fake.requests.length).toBe(before)
    expect(hasExplicitPort('https://shop.example/cb?next=http://x:1')).toBe(false)
    expect(hasExplicitPort('https://user:pw@shop.example/cb')).toBe(false)
    expect(hasExplicitPort('http://[::1]/cb')).toBe(false)
  })

  it('the fake also rejects a port, so the rule is tested on both sides', async () => {
    const res = await fetch(`${fake.url}/purchases/`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keys.secretKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        brand_id: keys.brandId,
        client: { email: 'a@example.com' },
        purchase: { products: [{ name: 'x', price: 100 }] },
        success_callback: 'https://shop.example:443/cb',
      }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ __all__: { code: 'webhooks_callback_port' } })
  })

  it('sends the documented body: brand, client, sen products, top-level URLs, due + due_strict, whitelist', async () => {
    const g = chip({
      ...keys,
      environment: 'test',
      publicKey,
      baseUrl: fake.url,
      paymentMethods: ['fpx', 'duitnow_qr'],
    })
    const expiresAt = new Date('2026-12-01T00:00:00Z')
    const input = sampleInput({ amount: 2599, expiresAt })
    await g.createPayment(input)
    const body = fake.requests.at(-1)?.body as Record<string, unknown>
    expect(body).toMatchObject({
      brand_id: keys.brandId,
      client: { email: 'ali@example.com', full_name: 'Ali bin Abu' },
      purchase: { currency: 'MYR', products: [{ name: input.description, price: 2599 }], due_strict: true },
      reference: input.reference,
      success_redirect: input.returnUrl,
      failure_redirect: input.returnUrl,
      success_callback: input.callbackUrl,
      due: 1796083200, // 2026-12-01T00:00:00Z in Unix seconds
      payment_method_whitelist: ['fpx', 'duitnow_qr'],
    })
    expect(fake.requests.at(-1)?.headers.authorization).toBe(`Bearer ${keys.secretKey}`)
    expect(fake.requests.at(-1)?.headers['idempotency-key']).toBeUndefined()
  })

  it('requires a customer email (the one required client field)', async () => {
    await expect(gw.createPayment(sampleInput({ customer: { name: 'A' } }))).rejects.toMatchObject({
      code: 'EMAIL_REQUIRED',
    })
  })

  it('reads amount, fee and paid_on from the payment object once paid', async () => {
    const input = sampleInput({ amount: 1050 })
    const created = await gw.createPayment(input)
    const before = await gw.getPayment(created.id)
    expect(before).toMatchObject({
      status: 'pending',
      amount: 1050,
      currency: 'MYR',
      reference: input.reference,
    })
    expect(before.paidAt).toBeUndefined()
    fake.markPaid(created.id)
    const after = await gw.getPayment(created.id)
    expect(after).toMatchObject({ status: 'paid', amount: 1050, currency: 'MYR', fee: 100 })
    expect(after.paidAt).toBeInstanceOf(Date)
    expect(Math.abs((after.paidAt?.getTime() ?? 0) - Date.now())).toBeLessThan(60_000)
  })

  it("quotes CHIP's error, never the key, on a wrong secret key", async () => {
    const g = chip({ ...keys, environment: 'test', secretKey: 'test_wrong-key', baseUrl: fake.url })
    const err = await g.createPayment(sampleInput()).catch((e) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err).toMatchObject({ status: 401, code: 'authentication_failed' })
    expect(err.message).toContain('Incorrect secret_key')
    expect(err.message).not.toContain('wrong-key')
    await expect(g.fetchPublicKey()).rejects.toMatchObject({ status: 401 })
  })

  it('environment guards against a test purchase confirming a live order', async () => {
    const live = chip({ ...keys, publicKey, environment: 'live', baseUrl: fake.url })
    const input = sampleInput()
    const created = await gw.createPayment(input)
    fake.markPaid(created.id)
    await expect(live.getPayment(created.id)).rejects.toMatchObject({ code: 'MODE_MISMATCH' })
    expect(await confirmPayment(live, fake.callbackFor(created.id), input)).toMatchObject({
      ok: false,
      reason: 'gateway_error',
    })
  })

  it('maps every OpenAPI PurchaseStatus; only paid, cleared and settled are paid', () => {
    const table: Record<string, string> = {
      created: 'pending',
      sent: 'pending',
      viewed: 'pending',
      overdue: 'pending',
      error: 'pending', // a failed ATTEMPT; the purchase can still be paid
      blocked: 'pending',
      hold: 'pending',
      pending_execute: 'pending',
      pending_charge: 'pending',
      pending_capture: 'pending',
      pending_release: 'pending',
      preauthorized: 'pending',
      paid: 'paid',
      cleared: 'paid',
      settled: 'paid',
      cancelled: 'cancelled',
      released: 'cancelled',
      expired: 'expired',
      chargeback: 'unknown',
      pending_refund: 'unknown',
      refunded: 'unknown',
      failed: 'unknown', // CHIP's AI skill lists it; the OpenAPI enum has no such status
      '': 'unknown',
    }
    for (const [chipStatus, ours] of Object.entries(table))
      expect([chipStatus, mapStatus(chipStatus)]).toEqual([chipStatus, ours])
  })

  it('a correctly signed callback for a purchase in error is not paid', async () => {
    const input = sampleInput()
    const created = await gw.createPayment(input)
    const cb = fake.callbackFor(created.id, { status: 'error' })
    expect(gw.verifyCallback(cb)?.claimedStatus).toBe('pending')
  })
})

describe('chip: the test/live guard is not optional', () => {
  it('refuses a config without environment (one host for test and live: the key alone decides)', () => {
    expect(() => chip({ ...keys } as Parameters<typeof chip>[0])).toThrow(/environment/)
    expect(() => chip({ ...keys, environment: 'prod' as 'live' })).toThrow(/environment/)
  })

  it('refuses a purchase record that does not say whether it is a test', async () => {
    const purchase = {
      id: 'p1',
      reference: 'R1',
      status: 'paid',
      purchase: { total: 1050, currency: 'MYR' },
      payment: { amount: 1050, currency: 'MYR' },
    }
    const fetch = async () =>
      new Response(JSON.stringify(purchase), { status: 200, headers: { 'content-type': 'application/json' } })
    const g = chip({ ...keys, environment: 'live', baseUrl: 'https://chip.test/api/v1', fetch })
    await expect(g.getPayment('p1')).rejects.toMatchObject({ code: 'MODE_UNKNOWN' })
  })
})
