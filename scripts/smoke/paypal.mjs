// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const keys = { clientId: 'client_smoke', clientSecret: 'secret_smoke', webhookId: 'WH_SMOKE' }
  const fake = await testing.startFakePayPal(keys)
  const { paypal } = await import('@bayarkit/paypal')
  return { fake, gateway: paypal({ ...keys, baseUrl: fake.url, fetch }) }
}
