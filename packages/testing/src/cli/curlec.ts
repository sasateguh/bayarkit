import { startFakeCurlec } from '../fakes/curlec.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { keyId: 'rzp_test_fake', keySecret: 'fake-key-secret', webhookSecret: 'fake-webhook-secret' },
  start: (o) =>
    startFakeCurlec({
      keyId: o.keyId ?? '',
      keySecret: o.keySecret ?? '',
      webhookSecret: o.webhookSecret ?? '',
    }),
}

export default fake
