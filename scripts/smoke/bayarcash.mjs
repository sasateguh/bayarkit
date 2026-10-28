// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const fake = await testing.startFakeBayarcash({ token: 't', secretKey: 's', portalKey: 'p' })
  const { bayarcash } = await import('@bayarkit/bayarcash')
  return {
    fake,
    gateway: bayarcash({
      token: 't',
      secretKey: 's',
      portalKey: 'p',
      environment: 'sandbox',
      baseUrl: fake.url,
      fetch,
    }),
  }
}
