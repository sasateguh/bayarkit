// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const keys = { apiKey: 'pdl_sdbx_apikey_smoke', webhookSecret: 'pdl_ntfset_smoke' }
  const fake = await testing.startFakePaddle(keys)
  const { paddle } = await import('@bayarkit/paddle')
  return { fake, gateway: paddle({ ...keys, baseUrl: fake.url, fetch }) }
}
