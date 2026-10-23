import { startFake2C2P } from '../fakes/2c2p.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { merchantId: 'JT07', secretKey: 'FAKE2C2PSECRETKEY' },
  start: (o) => startFake2C2P({ merchantId: o.merchantId ?? '', secretKey: o.secretKey ?? '' }),
}

export default fake
