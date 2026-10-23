// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const fake = await testing.startFakeToyyibPay({ secretKey: 's', categoryCode: 'c' })
  const { toyyibpay } = await import('@bayarkit/toyyibpay')
  return {
    fake,
    gateway: toyyibpay({ secretKey: 's', categoryCode: 'c', environment: 'sandbox', baseUrl: fake.url }),
  }
}
