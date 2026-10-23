import { startFakeFiuu } from '../fakes/fiuu.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: {
    merchantId: 'SB_fakemerchant',
    verifyKey: 'fake-verify-key',
    secretKey: 'fake-secret-key',
    extendedVcode: 'false',
  },
  start: (o) =>
    startFakeFiuu({
      merchantId: o.merchantId ?? '',
      verifyKey: o.verifyKey ?? '',
      secretKey: o.secretKey ?? '',
      extendedVcode: o.extendedVcode === 'true',
    }),
}

export default fake
