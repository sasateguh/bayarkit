// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const fake = await testing.startFakeXendit({
    secretKey: 'xnd_development_smoke',
    callbackToken: 'smoke-token',
  })
  const { xendit } = await import('@bayarkit/xendit')
  return {
    fake,
    gateway: xendit({
      secretKey: 'xnd_development_smoke',
      callbackToken: 'smoke-token',
      baseUrl: fake.url,
      fetch,
    }),
  }
}
