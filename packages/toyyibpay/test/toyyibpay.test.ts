import { GatewayError } from '@bayarkit/core'
import { gatewayConformance, sampleInput, startFakeToyyibPay } from '@bayarkit/testing'
import { describe, expect, it } from 'vitest'
import { clean, malaysiaTime, parseMalaysiaTime, toyyibpay } from '../src/index.js'

const keys = { secretKey: 'fake-secret', categoryCode: 'fakecat' }

gatewayConformance('toyyibpay', async () => {
  const fake = await startFakeToyyibPay(keys)
  return { fake, gateway: toyyibpay({ ...keys, environment: 'sandbox', baseUrl: fake.url }) }
})

describe('toyyibpay: measured sandbox behaviour', () => {
  it('reads "No data found!" (not []) as an unpaid bill', async () => {
    const fake = await startFakeToyyibPay(keys)
    const gw = toyyibpay({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const created = await gw.createPayment(sampleInput())
    expect((await gw.getPayment(created.id)).status).toBe('pending')
    await fake.close()
  })

  it('surfaces the bracketed error code and the JSON error message, never the secret', async () => {
    const fake = await startFakeToyyibPay(keys)
    const wrongKey = toyyibpay({
      ...keys,
      secretKey: 'wrong-secret',
      environment: 'sandbox',
      baseUrl: fake.url,
    })
    const err = await wrongKey.createPayment(sampleInput()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect((err as GatewayError).code).toBe('KEY-DID-NOT-EXIST-OR-USER-IS-NOT-ACTIVE')
    expect((err as Error).message).not.toContain('wrong-secret')
    const gw = toyyibpay({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const noEmail = await gw
      .createPayment(sampleInput({ customer: { name: 'A' } }))
      .then(() => 'created')
      .catch((e: Error) => e.message)
    expect(noEmail).toBe('created') // no email → billPayorInfo=0, not a refusal
    await fake.close()
  })

  it('sends a form post with the fields toyyibPay requires', async () => {
    const fake = await startFakeToyyibPay(keys)
    const gw = toyyibpay({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const input = sampleInput({
      description: 'Panel Solar 550W (x2) — RM1,050!',
      expiresAt: new Date('2026-10-23T02:00:00Z'),
    })
    await gw.createPayment(input)
    const sent = fake.requests.at(-1)
    expect(sent?.contentType).toBe('application/x-www-form-urlencoded')
    expect(sent?.fields).toMatchObject({
      billAmount: '1050',
      billExternalReferenceNo: input.reference,
      billPayorInfo: '1',
      billPaymentChannel: '0',
      billChargeToCustomer: '',
      billExpiryDate: '23-10-2026 10:00:00',
    })
    expect(sent?.fields.billName).toMatch(/^[A-Za-z0-9 _]{1,30}$/)
    await fake.close()
  })

  it('reads the fee in sen and the payment time in Malaysia time', async () => {
    const fake = await startFakeToyyibPay(keys)
    const gw = toyyibpay({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const created = await gw.createPayment(sampleInput())
    fake.markPaid(created.id)
    const record = await gw.getPayment(created.id)
    expect(record.fee).toBe(100)
    expect(record.paidAt?.toISOString()).toBe('2026-10-10T02:50:07.000Z')
    await fake.close()
  })

  it("asks with the owner's key, so the fee is kept and another account's bill never reads as paid", async () => {
    const fake = await startFakeToyyibPay(keys)
    const gw = toyyibpay({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const created = await gw.createPayment(sampleInput())
    fake.markPaid(created.id)
    await gw.getPayment(created.id)
    expect(fake.requests.at(-1)).toMatchObject({
      path: 'getBillTransactions',
      fields: { billCode: created.id, userSecretKey: keys.secretKey },
    })
    // The same paid bill, asked about with ANOTHER merchant's key: no transactions, so not paid.
    const other = toyyibpay({ ...keys, secretKey: 'someone-else', environment: 'sandbox', baseUrl: fake.url })
    expect((await other.getPayment(created.id)).status).toBe('pending')
    await fake.close()
  })

  it('deactivates a bill, and says so the second time', async () => {
    const fake = await startFakeToyyibPay(keys)
    const gw = toyyibpay({ ...keys, environment: 'sandbox', baseUrl: fake.url })
    const created = await gw.createPayment(sampleInput())
    expect(await gw.deactivate(created.id)).toEqual({ alreadyInactive: false })
    expect(await gw.deactivate(created.id)).toEqual({ alreadyInactive: true })
    expect(await gw.checkConnection()).toEqual({ categoryName: 'Fake category' })
    await fake.close()
  })
})

describe('toyyibpay: text and time helpers', () => {
  it('cleans names to the allowed characters and length', () => {
    expect(clean('Panel Solar 550W (x2) — RM1,050!', 30)).toBe('Panel Solar 550W x2 RM1 050')
    expect(clean('a'.repeat(50), 30)).toHaveLength(30)
  })
  it('round-trips Malaysia time and rejects impossible dates', () => {
    const d = new Date('2026-03-02T08:24:25Z')
    expect(malaysiaTime(d)).toBe('02-03-2026 16:24:25')
    expect(parseMalaysiaTime('02-03-2026 16:24:25')?.toISOString()).toBe(d.toISOString())
    expect(parseMalaysiaTime('31-02-2026 10:00:00')).toBeUndefined()
    expect(parseMalaysiaTime('2026-03-02 16:24:25')).toBeUndefined()
  })
})
