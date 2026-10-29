import type { CallbackInput } from '@bayarkit/core'
import { describe, expect, it } from 'vitest'
import { startControlServer } from '../src/control.js'
import { startFakePayPal } from '../src/fakes/paypal.js'
import { startFakeToyyibPay } from '../src/fakes/toyyibpay.js'

describe('control API (bayarkit-fake, for tests in other languages)', () => {
  it('marks paid and serves the signed and the tampered callback', async () => {
    const fake = await startFakeToyyibPay({ secretKey: 's', categoryCode: 'c' })
    const control = await startControlServer('toyyibpay', fake)
    const created = await fetch(`${fake.url}/index.php/api/createBill`, {
      method: 'POST',
      body: new URLSearchParams({
        userSecretKey: 's',
        categoryCode: 'c',
        billAmount: '1000',
        billExternalReferenceNo: 'R1',
      }),
    })
    const billCode = JSON.parse((await created.text()).trim())[0].BillCode as string
    expect((await fetch(`${control.url}/health`)).status).toBe(200)
    expect((await fetch(`${control.url}/paid/${billCode}`, { method: 'POST' })).status).toBe(204)
    const cb = (await (await fetch(`${control.url}/callback/${billCode}`)).json()) as CallbackInput
    expect(cb.fields).toMatchObject({ billcode: billCode, order_id: 'R1', status: '1' })
    const bad = (await (await fetch(`${control.url}/callback/${billCode}/tampered`)).json()) as CallbackInput
    expect(bad.fields.hash).not.toBe(cb.fields.hash)
    expect((await fetch(`${control.url}/callback/nope`)).status).toBe(404)
    await control.close()
    await fake.close()
  })

  it('approves without capturing on a fake that has a buyer approval step (PayPal), and nowhere else', async () => {
    const keys = { clientId: 'c', clientSecret: 's', webhookId: 'W' }
    const fake = await startFakePayPal(keys)
    const control = await startControlServer('paypal', fake)
    const token = (await (
      await fetch(`${fake.url}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from('c:s').toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      })
    ).json()) as { access_token: string }
    const order = (await (
      await fetch(`${fake.url}/v2/checkout/orders`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{ custom_id: 'R1', amount: { currency_code: 'USD', value: '1.00' } }],
        }),
      })
    ).json()) as { id: string }
    expect((await fetch(`${control.url}/approve/${order.id}`, { method: 'POST' })).status).toBe(204)
    expect(fake.order(order.id)?.status).toBe('APPROVED')
    expect(fake.order(order.id)?.purchase_units[0]?.payments).toBeUndefined()
    expect((await fetch(`${control.url}/approve/NOPE`, { method: 'POST' })).status).toBe(404)
    await control.close()
    await fake.close()

    const toy = await startFakeToyyibPay({ secretKey: 's', categoryCode: 'c' })
    const toyControl = await startControlServer('toyyibpay', toy)
    expect((await fetch(`${toyControl.url}/approve/x`, { method: 'POST' })).status).toBe(404)
    await toyControl.close()
    await toy.close()
  })
})
