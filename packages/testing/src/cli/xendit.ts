import { startFakeXendit } from '../fakes/xendit.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { secretKey: 'xnd_development_fake', callbackToken: 'fake-callback-token' },
  start: (o) => startFakeXendit({ secretKey: o.secretKey ?? '', callbackToken: o.callbackToken ?? '' }),
}

export default fake
