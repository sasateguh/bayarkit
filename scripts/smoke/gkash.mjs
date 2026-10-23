// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const fake = await testing.startFakeGkash({ cid: 'M161-U-999', signatureKey: 's' })
  const { gkash } = await import('@bayarkit/gkash')
  return {
    fake,
    gateway: gkash({ cid: 'M161-U-999', signatureKey: 's', environment: 'sandbox', baseUrl: fake.url }),
  }
}
