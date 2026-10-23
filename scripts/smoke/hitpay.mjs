// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const fake = await testing.startFakeHitPay({ apiKey: 'k', apiSalt: 'as', webhookSalt: 'ws' })
  const { hitpay } = await import('@bayarkit/hitpay')
  return {
    fake,
    gateway: hitpay({
      apiKey: 'k',
      apiSalt: 'as',
      webhookSalt: 'ws',
      environment: 'sandbox',
      baseUrl: fake.url,
    }),
  }
}
