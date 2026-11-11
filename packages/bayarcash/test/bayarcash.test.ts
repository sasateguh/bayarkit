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

  it('rejects a Direct Debit deduction callback (also record_type "transaction", signed over other fields)', () => {
    // Direct Debit is not supported: its deduction callback signs batch_number, mandate_id, cycle, … and,
    // when present, payment_gateway_id. A correctly signed one must still not pass as a checkout payment.
    const gw = bayarcash({ ...keys, environment: 'sandbox' })
    const fields: Record<string, string> = {
      record_type: 'transaction',
      batch_number: 'B1',
      mandate_id: 'M1',
      mandate_reference_number: 'MR1',
      transaction_id: 'trx_dd_1',
      datetime: '2026-11-07 10:00:00',
      reference_number: 'R1',
      amount: '25.00',
      status: '3',
      status_description: 'Approved',
      cycle: '1',
      payment_gateway_id: '2',
    }
    const signed = { ...fields, checksum: checksum(keys.secretKey, fields) }
    expect(gw.verifyCallback({ fields: signed, rawBody: '', headers: {} })).toBeNull()
  })

  it('refuses a correctly signed recurring charge callback and recurring return landing (recurring is not supported)', async () => {
    // The SDK signs these over their own fixed field lists (22 and 12); they must never pass as a one-off payment.
    const fake = await startFakeBayarcash(keys)
    const gw = bayarcash({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    expect(gw.verifyCallback(fake.recurringChargeCallback())).toBeNull()
    expect(gw.verifyCallback(fake.recurringReturn())).toBeNull()
    await fake.close()
  })

  it('treats only record_type "transaction" (or none, a one-off return landing) as a payment', () => {
    // Fields a one-off return-URL checksum covers, under another record type or with a recurring marker: the record
    // type, not the field list, decides what kind of message this is.
    const gw = bayarcash({ ...keys, environment: 'sandbox' })
    const ret: Record<string, string> = {
      transaction_id: 'trx_1',
      exchange_reference_number: '1-x',
      exchange_transaction_id: 'FPX1',
      order_number: 'A1',
      currency: 'MYR',
      amount: '25.00',
      payer_bank_name: 'Test Bank',
      status: '3',
      status_description: 'Approved',
    }
    const signed = { ...ret, checksum: checksum(keys.secretKey, ret) }
    expect(gw.verifyCallback({ fields: signed, rawBody: '', headers: {} })?.id).toBe('trx_1')
    for (const extra of [{ record_type: 'recurring_charge' }, { recurring_type: 'subscription' }]) {
      expect(gw.verifyCallback({ fields: { ...signed, ...extra }, rawBody: '', headers: {} })).toBeNull()
    }
  })

  it('requires payer name and email, which are part of the signed payload', async () => {
    const gw = bayarcash({ ...keys, environment: 'sandbox', baseUrl: 'http://127.0.0.1:9' })
    await expect(gw.createPayment(sampleInput({ customer: { name: 'A' } }))).rejects.toThrow(
      /payer name and email/,
    )
  })

  it('refuses an order number over 30 characters before calling the API (measured sandbox limit; a UUID does not fit)', async () => {
    const fake = await startFakeBayarcash(keys)
    const gw = bayarcash({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const sent = fake.requests.length
    for (const reference of ['x'.repeat(31), '550e8400-e29b-41d4-a716-446655440000']) {
      await expect(gw.createPayment(sampleInput({ reference }))).rejects.toMatchObject({
        code: 'INVALID_REFERENCE',
      })
    }
    expect(fake.requests.length).toBe(sent)
    await gw.createPayment(sampleInput({ reference: 'y'.repeat(30) }))
    expect((fake.requests.at(-1)?.body as Record<string, unknown> | undefined)?.order_number).toBe(
      'y'.repeat(30),
    )
    await fake.close()
  })

  it('fake answers an over-long order number with the measured 422', async () => {
    const fake = await startFakeBayarcash(keys)
    const res = await fetch(`${fake.url}/payment-intents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keys.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ portal_key: keys.portalKey, order_number: 'z'.repeat(31), checksum: 'x' }),
    })
    expect(res.status).toBe(422)
    const json = (await res.json()) as { errors: { order_number: string[] } }
    expect(json.errors.order_number[0]).toMatch(/not be greater than 30 characters/)
    await fake.close()
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
