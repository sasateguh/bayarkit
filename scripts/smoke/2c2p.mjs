// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const fake = await testing.startFake2C2P({ merchantId: 'JT07', secretKey: 'SMOKEKEY' })
  const { twoc2p } = await import('@bayarkit/2c2p')
  return {
    fake,
    gateway: twoc2p({ merchantId: 'JT07', secretKey: 'SMOKEKEY', environment: 'sandbox', baseUrl: fake.url }),
  }
}
