// Smoke setup for one gateway: a fake from the packed @bayarkit/testing and the packed adapter pointed at it.
export default async function setup(testing) {
  const keys = { clientId: 'BRN-smoke', secretKey: 's', apiKey: 'k', notificationPath: '/doku' }
  const fake = await testing.startFakeSenangPay(keys)
  const { senangpay } = await import('@bayarkit/senangpay')
  return { fake, gateway: senangpay({ ...keys, environment: 'sandbox', baseUrl: fake.url }) }
}
