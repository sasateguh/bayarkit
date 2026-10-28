// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const fake = await testing.startFakeToyyibPay({ secretKey: 's', categoryCode: 'c' })
  const { toyyibpay } = await import('@bayarkit/toyyibpay')
  return {
    fake,
    gateway: toyyibpay({
      secretKey: 's',
      categoryCode: 'c',
      environment: 'sandbox',
      baseUrl: fake.url,
      fetch,
    }),
  }
}
