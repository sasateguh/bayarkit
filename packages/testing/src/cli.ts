#!/usr/bin/env node
/**
 * bayarkit-fake — run one fake gateway as a standalone server, for tests in any language.
 *
 *   npx bayarkit-fake <toyyibpay|bayarcash|billplz|stripe|chip|curlec> [--control-port N] [--<option> <value> ...]
 *
 * Prints ONE JSON line ({ gateway, url, control, options }) and serves until SIGINT/SIGTERM. Options are the fake's
 * own (e.g. --secretKey, --webhookSecret); test defaults are used for the rest and echoed in `options`.
 * Imports the fakes directly, not the package index, so vitest is not needed.
 */
import { startControlServer } from './control.js'
import { startFakeBayarcash } from './fakes/bayarcash.js'
import { startFakeBillplz } from './fakes/billplz.js'
import { startFakeChip } from './fakes/chip.js'
import { startFakeCurlec } from './fakes/curlec.js'
import { startFakeStripe } from './fakes/stripe.js'
import { startFakeToyyibPay } from './fakes/toyyibpay.js'
import type { FakeGateway } from './fakes/types.js'

const FAKES: Record<
  string,
  { defaults: Record<string, string>; start(o: Record<string, string>): Promise<FakeGateway> }
> = {
  toyyibpay: {
    defaults: { secretKey: 'fake-secret', categoryCode: 'fakecat' },
    start: (o) => startFakeToyyibPay({ secretKey: o.secretKey ?? '', categoryCode: o.categoryCode ?? '' }),
  },
  bayarcash: {
    defaults: { token: 'fake-token', secretKey: 'fake-secret', portalKey: 'fake-portal' },
    start: (o) =>
      startFakeBayarcash({
        token: o.token ?? '',
        secretKey: o.secretKey ?? '',
        portalKey: o.portalKey ?? '',
      }),
  },
  billplz: {
    defaults: { secretKey: 'fake-secret', xSignatureKey: 'fake-x-signature', collectionId: 'fakecollection' },
    start: (o) =>
      startFakeBillplz({
        secretKey: o.secretKey ?? '',
        xSignatureKey: o.xSignatureKey ?? '',
        collectionId: o.collectionId ?? '',
      }),
  },
  stripe: {
    defaults: { secretKey: 'sk_test_fake', webhookSecret: 'whsec_fake' },
    start: (o) => startFakeStripe({ secretKey: o.secretKey ?? '', webhookSecret: o.webhookSecret ?? '' }),
  },
  chip: {
    defaults: { secretKey: 'fake-secret', brandId: 'fake-brand' },
    start: (o) => startFakeChip({ secretKey: o.secretKey ?? '', brandId: o.brandId ?? '' }),
  },
  curlec: {
    defaults: { keyId: 'rzp_test_fake', keySecret: 'fake-key-secret', webhookSecret: 'fake-webhook-secret' },
    start: (o) =>
      startFakeCurlec({
        keyId: o.keyId ?? '',
        keySecret: o.keySecret ?? '',
        webhookSecret: o.webhookSecret ?? '',
      }),
  },
}

const [gateway, ...rest] = process.argv.slice(2)
const entry = gateway ? FAKES[gateway] : undefined
if (!gateway || !entry) {
  console.error(
    `usage: bayarkit-fake <${Object.keys(FAKES).join('|')}> [--control-port N] [--<option> <value> ...]`,
  )
  process.exit(64)
}
const options: Record<string, string> = { ...entry.defaults }
let controlPort = 0
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i]?.replace(/^--/, '') ?? ''
  const value = rest[i + 1] ?? ''
  if (key === 'control-port') controlPort = Number(value)
  else options[key] = value
}
const fake = await entry.start(options)
const control = await startControlServer(gateway, fake, controlPort)
console.log(JSON.stringify({ gateway, url: fake.url, control: control.url, options }))
const stop = async () => {
  await control.close()
  await fake.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
