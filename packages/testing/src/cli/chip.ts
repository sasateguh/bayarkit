import { startFakeChip } from '../fakes/chip.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { secretKey: 'fake-secret', brandId: 'fake-brand' },
  start: (o) => startFakeChip({ secretKey: o.secretKey ?? '', brandId: o.brandId ?? '' }),
}

export default fake
