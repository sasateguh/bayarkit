// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const keys = { merchantId: 'SB_smoke', verifyKey: 'v', secretKey: 's' }
  const fake = await testing.startFakeFiuu(keys)
  const { fiuu } = await import('@bayarkit/fiuu')
  return { fake, gateway: fiuu({ ...keys, environment: 'sandbox', baseUrl: fake.url }) }
}
