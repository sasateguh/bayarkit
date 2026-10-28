// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
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
      fetch,
    }),
  }
}
