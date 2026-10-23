// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const fake = await testing.startFakeEghl({ serviceId: 'SMK', password: 'p' })
  const { eghl } = await import('@bayarkit/eghl')
  return {
    fake,
    gateway: eghl({
      serviceId: 'SMK',
      merchantPassword: 'p',
      environment: 'sandbox',
      baseUrl: fake.url,
      fallbackCustomerIp: '127.0.0.1',
    }),
  }
}
