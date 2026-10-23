import { startFakeSenangPay } from '../fakes/senangpay.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: {
    clientId: 'BRN-fake-0001',
    secretKey: 'fake-secret',
    apiKey: 'fake-api-key',
    notificationPath: '/notifications/doku',
  },
  start: (o) =>
    startFakeSenangPay({
      clientId: o.clientId ?? '',
      secretKey: o.secretKey ?? '',
      apiKey: o.apiKey ?? '',
      notificationPath: o.notificationPath ?? '',
    }),
}

export default fake
