import { startFakePaddle } from '../fakes/paddle.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: {
    apiKey: 'pdl_sdbx_apikey_fake',
    webhookSecret: 'pdl_ntfset_fake',
    defaultPaymentLink: 'https://shop.example/pay',
  },
  start: (o) =>
    startFakePaddle({
      apiKey: o.apiKey ?? '',
      webhookSecret: o.webhookSecret ?? '',
      defaultPaymentLink: o.defaultPaymentLink ?? '',
      approvedDomains: o.approvedDomains ? o.approvedDomains.split(',') : [],
    }),
}

export default fake
