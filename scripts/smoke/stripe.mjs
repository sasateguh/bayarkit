// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const fake = await testing.startFakeStripe({ secretKey: 'sk_test_smoke', webhookSecret: 'whsec_smoke' })
  const { stripe } = await import('@bayarkit/stripe')
  return {
    fake,
    gateway: stripe({ secretKey: 'sk_test_smoke', webhookSecret: 'whsec_smoke', baseUrl: fake.url, fetch }),
  }
}
