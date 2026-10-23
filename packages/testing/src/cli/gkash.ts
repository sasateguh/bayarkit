import { startFakeGkash } from '../fakes/gkash.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { cid: 'M161-U-999', signatureKey: 'fake-signature-key' },
  start: (o) => startFakeGkash({ cid: o.cid ?? '', signatureKey: o.signatureKey ?? '' }),
}

export default fake
