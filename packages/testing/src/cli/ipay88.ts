import { startFakeIPay88 } from '../fakes/ipay88.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { merchantCode: 'M00003', merchantKey: 'fake-merchant-key' },
  start: (o) => startFakeIPay88({ merchantCode: o.merchantCode ?? '', merchantKey: o.merchantKey ?? '' }),
}

export default fake
