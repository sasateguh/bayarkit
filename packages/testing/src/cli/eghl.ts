import { startFakeEghl } from '../fakes/eghl.js'
import type { CliFake } from './types.js'

const fake: CliFake = {
  defaults: { serviceId: 'SIT', password: 'fake-password' },
  start: (o) => startFakeEghl({ serviceId: o.serviceId ?? '', password: o.password ?? '' }),
}

export default fake
