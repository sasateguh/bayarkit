// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const keys = { merchantCode: 'M00003', merchantKey: 'k' }
  const fake = await testing.startFakeIPay88(keys)
  const { ipay88 } = await import('@bayarkit/ipay88')
  return { fake, gateway: ipay88({ ...keys, environment: 'production', baseUrl: fake.url, fetch }) }
}
