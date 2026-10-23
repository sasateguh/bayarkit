import { startFakeBayarcash } from '../fakes/bayarcash.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { token: 'fake-token', secretKey: 'fake-secret', portalKey: 'fake-portal' },
  start: (o) =>
    startFakeBayarcash({
      token: o.token ?? '',
      secretKey: o.secretKey ?? '',
      portalKey: o.portalKey ?? '',
    }),
}

export default fake
