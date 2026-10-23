// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const fake = await testing.startFakeCurlec({
    keyId: 'rzp_test_smoke',
    keySecret: 'ks',
    webhookSecret: 'ws',
  })
  const { curlec } = await import('@bayarkit/curlec')
  return {
    fake,
    gateway: curlec({ keyId: 'rzp_test_smoke', keySecret: 'ks', webhookSecret: 'ws', baseUrl: fake.url }),
  }
}
