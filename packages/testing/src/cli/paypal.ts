import { startFakePayPal } from '../fakes/paypal.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: {
    clientId: 'client_fake',
    clientSecret: 'secret_fake',
    webhookId: 'WH_FAKE',
  },
  start: (o) =>
    startFakePayPal({
      clientId: o.clientId ?? '',
      clientSecret: o.clientSecret ?? '',
      webhookId: o.webhookId ?? '',
      ...(o.tokenTtlSeconds ? { tokenTtlSeconds: Number(o.tokenTtlSeconds) } : {}),
    }),
}

export default fake
