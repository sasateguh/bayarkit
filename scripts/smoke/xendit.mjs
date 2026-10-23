// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const fake = await testing.startFakeXendit({
    secretKey: 'xnd_development_smoke',
    callbackToken: 'smoke-token',
  })
  const { xendit } = await import('@bayarkit/xendit')
  return {
    fake,
    gateway: xendit({ secretKey: 'xnd_development_smoke', callbackToken: 'smoke-token', baseUrl: fake.url }),
  }
}
