// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const fake = await testing.startFakeBillplz({ secretKey: 's', xSignatureKey: 'x', collectionId: 'c' })
  const { billplz } = await import('@bayarkit/billplz')
  return {
    fake,
    gateway: billplz({
      secretKey: 's',
      xSignatureKey: 'x',
      collectionId: 'c',
      environment: 'sandbox',
      baseUrl: fake.url,
    }),
  }
}
