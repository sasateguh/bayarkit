import type { CallbackInput } from '@bayarkit/core'
import { describe, expect, it } from 'vitest'
import { startControlServer } from '../src/control.js'
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
})
