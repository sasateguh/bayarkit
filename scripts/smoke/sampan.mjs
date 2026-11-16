// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const fake = await testing.startFakeSampan()
  const { sampan } = await import('@bayarkit/sampan')
  const config = {
    merchantAddress: `bitcoincash:z${'q'.repeat(41)}`,
    webhookSecret: `whsec_${Buffer.from('bayarkit sampan smoke secret 32b').toString('base64')}`,
  }
  return { fake, gateway: sampan({ ...config, baseUrl: fake.url, fetch }) }
}
