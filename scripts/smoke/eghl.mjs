// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
// `fetch` (optional): the demo passes its own, so a closed set of fakes leaves no connection pool behind.
export default async function setup(testing, { fetch } = {}) {
  const fake = await testing.startFakeEghl({ serviceId: 'SMK', password: 'p' })
  const { eghl } = await import('@bayarkit/eghl')
  return {
    fake,
    gateway: eghl({
      serviceId: 'SMK',
      merchantPassword: 'p',
      environment: 'sandbox',
      baseUrl: fake.url,
      fetch,
      fallbackCustomerIp: '127.0.0.1',
    }),
  }
}
