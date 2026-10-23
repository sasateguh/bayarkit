import { startFakeStripe } from '../fakes/stripe.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { secretKey: 'sk_test_fake', webhookSecret: 'whsec_fake' },
  start: (o) => startFakeStripe({ secretKey: o.secretKey ?? '', webhookSecret: o.webhookSecret ?? '' }),
}

export default fake
