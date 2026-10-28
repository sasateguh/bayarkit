// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const keys = { clientId: 'BRN-smoke', secretKey: 's', apiKey: 'k', notificationPath: '/doku' }
  const fake = await testing.startFakeSenangPay(keys)
  const { senangpay } = await import('@bayarkit/senangpay')
  return { fake, gateway: senangpay({ ...keys, environment: 'sandbox', baseUrl: fake.url, fetch }) }
}
