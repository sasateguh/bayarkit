import { startFakeSampan } from '../fakes/sampan.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: {
    // Answered by the fake when an invoice has a webhook URL but no secret, so tests in any language know it.
    webhookSecret: `whsec_${Buffer.from('bayarkit fake sampan secret 32b').toString('base64')}`,
    minUsd: '0.10',
    maxUsd: '1000.00',
  },
  start: (o) =>
    startFakeSampan({
      ...(o.webhookSecret ? { webhookSecret: o.webhookSecret } : {}),
      ...(o.minUsd ? { minUsd: o.minUsd } : {}),
      ...(o.maxUsd ? { maxUsd: o.maxUsd } : {}),
    }),
}

export default fake
