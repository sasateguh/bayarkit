import { startFakeBillplz } from '../fakes/billplz.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { secretKey: 'fake-secret', xSignatureKey: 'fake-x-signature', collectionId: 'fakecollection' },
  start: (o) =>
    startFakeBillplz({
      secretKey: o.secretKey ?? '',
      xSignatureKey: o.xSignatureKey ?? '',
      collectionId: o.collectionId ?? '',
    }),
}

export default fake
