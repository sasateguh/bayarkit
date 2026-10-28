// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
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
      fetch,
    }),
  }
}
