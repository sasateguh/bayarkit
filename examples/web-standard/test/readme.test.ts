// The "Testing your own code" snippet of README.md / README.ms.md, run as written: change one, change both.
import { confirmPayment } from '@bayarkit/core'
import { startFakeToyyibPay } from '@bayarkit/testing'
import { toyyibpay } from '@bayarkit/toyyibpay'
import { expect, it } from 'vitest'

it('README testing snippet runs as written', async () => {
  const fake = await startFakeToyyibPay({ secretKey: 's', categoryCode: 'c' })
  const gateway = toyyibpay({ secretKey: 's', categoryCode: 'c', environment: 'sandbox', baseUrl: fake.url })
  const order = { reference: 'T1', amount: 1500 }
  const payment = await gateway.createPayment({
    ...order,
    description: 'Test order',
    customer: { name: 'Ali', email: 'ali@example.com' },
    returnUrl: 'https://shop.example/thank-you',
    callbackUrl: 'https://shop.example/api/payment/callback',
  })
  const early = await confirmPayment(gateway, fake.callbackFor(payment.id), order) // signed, but not paid yet
  fake.markPaid(payment.id)
  const forged = await confirmPayment(gateway, fake.tamper(fake.callbackFor(payment.id)), order)
  const paid = await confirmPayment(gateway, fake.callbackFor(payment.id), order)
  await fake.close()
  expect([early.ok, forged.ok, paid.ok]).toEqual([false, false, true])
  expect([early.ok ? '' : early.reason, forged.ok ? '' : forged.reason]).toEqual([
    'not_paid',
    'invalid_signature',
  ])
})
