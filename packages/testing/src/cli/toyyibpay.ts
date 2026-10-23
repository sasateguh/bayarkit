import { startFakeToyyibPay } from '../fakes/toyyibpay.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { secretKey: 'fake-secret', categoryCode: 'fakecat' },
  start: (o) => startFakeToyyibPay({ secretKey: o.secretKey ?? '', categoryCode: o.categoryCode ?? '' }),
}

export default fake
