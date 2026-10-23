import type { FakeGateway } from '../fakes/types.js'

/** One `bayarkit-fake` gateway: test defaults, and how to start the fake. One file per gateway in this folder. */
export interface CliFake {
  defaults: Record<string, string>
  start(options: Record<string, string>): Promise<FakeGateway>
}
