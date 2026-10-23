// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
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
    }),
  }
}
