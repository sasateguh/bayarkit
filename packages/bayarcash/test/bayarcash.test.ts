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
