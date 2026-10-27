import { gatewayConformance, sampleInput, startFakeBayarcash } from '@bayarkit/testing'
import { describe, expect, it } from 'vitest'
import { bayarcash, checksum, verifyChecksum } from '../src/index.js'

const keys = { token: 'fake-token', secretKey: 'fake-secret', portalKey: 'fake-portal' }

gatewayConformance('bayarcash', async () => {
  const fake = await startFakeBayarcash(keys)
  return { fake, gateway: bayarcash({ ...keys, environment: 'sandbox', baseUrl: fake.url }) }
})

describe('bayarcash: checksum rules from the official SDK', () => {
  it('sorts by field name, joins with |, and joins channel lists with ,', () => {
    const a = checksum('s', {
      payment_channel: '1,2',
      order_number: 'A1',
      amount: '10.00',
      payer_name: 'N',
      payer_email: 'e',
    })
    const b = checksum('s', {
      payer_email: 'e',
      amount: '10.00',
      payer_name: 'N',
      order_number: 'A1',
      payment_channel: '1,2',
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts an amount sent as a JSON number only when the HMAC still matches its two-decimal form', async () => {
    const fake = await startFakeBayarcash(keys)
    const gw = bayarcash({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const created = await gw.createPayment(sampleInput({ amount: 2500 }))
    fake.markPaid(created.id)
    const body = fake.callbackFor(created.id).fields
    expect(body.amount).toBe('25.00')
    expect(verifyChecksum(keys.secretKey, { ...body, amount: '25' }, 'transaction')).toBe(true)
    expect(verifyChecksum(keys.secretKey, { ...body, amount: '26' }, 'transaction')).toBe(false)
    await fake.close()
  })

  it('ignores pre-transaction callbacks (nothing to confirm yet)', () => {
    const gw = bayarcash({ ...keys, environment: 'sandbox' })
    expect(
      gw.verifyCallback({
        fields: { record_type: 'pre_transaction', order_number: 'A1', exchange_reference_number: 'x' },
        rawBody: '',
        headers: {},
      }),
    ).toBeNull()
  })

  it('requires payer name and email, which are part of the signed payload', async () => {
    const gw = bayarcash({ ...keys, environment: 'sandbox', baseUrl: 'http://127.0.0.1:9' })
    await expect(gw.createPayment(sampleInput({ customer: { name: 'A' } }))).rejects.toThrow(
      /payer name and email/,
    )
  })

  it('sends the idempotency key so a retried request returns the same intent', async () => {
    const fake = await startFakeBayarcash(keys)
    const gw = bayarcash({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const input = sampleInput({ idempotencyKey: 'retry-1' })
    await gw.createPayment(input)
    expect(fake.requests.at(-1)?.headers['idempotency-key']).toBe('retry-1')
    await fake.close()
  })
})

describe('bayarcash: only this portal', () => {
  const tx = (extra: Record<string, unknown>) => async () =>
    new Response(
      JSON.stringify({ id: 'trx_1', order_number: 'R1', amount: 10.5, currency: 'MYR', status: 3, ...extra }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )
  const make = (fetch: typeof globalThis.fetch) =>
    bayarcash({
      token: 't',
      secretKey: 's',
      portalKey: 'portal-a',
      environment: 'sandbox',
      baseUrl: 'https://bc.test',
      fetch,
    })

  it('refuses a transaction the API says belongs to another portal (the secret is account-wide)', async () => {
    await expect(make(tx({ portal_key: 'portal-b' })).getPayment('trx_1')).rejects.toMatchObject({
      code: 'FOREIGN_PORTAL',
    })
  })

  it('accepts this portal, and a record with no portal field (the documented shape)', async () => {
    expect((await make(tx({ portal_key: 'portal-a' })).getPayment('trx_1')).status).toBe('paid')
    expect((await make(tx({})).getPayment('trx_1')).status).toBe('paid')
  })

  // Measured 27 Oct 2026: a sandbox transaction names its portal by NAME (`portal`), never by key.
  const named = (portal: string, portals = [{ portal_key: 'portal-a', portal_name: 'Shop A' }]) =>
    make(async (u) =>
      String(u).endsWith('/portals')
        ? Response.json({ data: portals })
        : Response.json({
            id: 'trx_1',
            order_number: 'R1',
            amount: 10.5,
            currency: 'MYR',
            status: 3,
            portal,
          }),
    )

  it("refuses a transaction whose portal name is not the configured portal key's name", async () => {
    await expect(named('Shop B').getPayment('trx_1')).rejects.toMatchObject({ code: 'FOREIGN_PORTAL' })
    expect((await named('Shop A').getPayment('trx_1')).status).toBe('paid')
  })

  it("refuses when the configured portal key is not among the account's portals", async () => {
    await expect(
      named('Shop A', [{ portal_key: 'portal-z', portal_name: 'Shop A' }]).getPayment('trx_1'),
    ).rejects.toMatchObject({
      code: 'FOREIGN_PORTAL',
    })
  })
})

describe('bayarcash: the payment id from checkout (a payment intent)', () => {
  const keys = { token: 't', secretKey: 's', portalKey: 'pk' }
  it('reads an unpaid intent as pending, and a paid one through its transaction', async () => {
    const fake = await startFakeBayarcash(keys)
    try {
      const gw = bayarcash({ ...keys, environment: 'sandbox', baseUrl: fake.url })
      const created = await gw.createPayment(sampleInput({ amount: 1500 }))
      expect(created.id).toMatch(/^pi_/)
      const unpaid = await gw.getPayment(created.id)
      expect(unpaid).toMatchObject({ status: 'pending', amount: 1500, currency: 'MYR' })
      fake.markPaid(created.id)
      const paid = await gw.getPayment(created.id)
      expect(paid.status).toBe('paid')
      expect(paid.id).toMatch(/^trx_/)
      expect(paid.amount).toBe(1500)
    } finally {
      await fake.close()
    }
  })
})
