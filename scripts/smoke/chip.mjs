// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const fake = await testing.startFakeChip({ secretKey: 's', brandId: 'b' })
  const { chip } = await import('@bayarkit/chip')
  const publicKey = await chip({ secretKey: 's', brandId: 'b', baseUrl: fake.url }).fetchPublicKey()
  return { fake, gateway: chip({ secretKey: 's', brandId: 'b', publicKey, baseUrl: fake.url }) }
}
