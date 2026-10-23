import { startFakeHitPay } from '../fakes/hitpay.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { apiKey: 'fake-api-key', apiSalt: 'fake-api-salt', webhookSalt: 'fake-webhook-salt' },
  start: (o) =>
    startFakeHitPay({ apiKey: o.apiKey ?? '', apiSalt: o.apiSalt ?? '', webhookSalt: o.webhookSalt ?? '' }),
}

export default fake
