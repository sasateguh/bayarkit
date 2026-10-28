// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const fake = await testing.startFakeChip({ secretKey: 's', brandId: 'b' })
  const { chip } = await import('@bayarkit/chip')
  const publicKey = await chip({
    secretKey: 's',
    brandId: 'b',
    environment: 'test',
    baseUrl: fake.url,
    fetch,
  }).fetchPublicKey()
  return {
    fake,
    gateway: chip({ secretKey: 's', brandId: 'b', publicKey, environment: 'test', baseUrl: fake.url, fetch }),
  }
}
