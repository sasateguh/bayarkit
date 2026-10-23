#!/usr/bin/env bash
# Install the PACKED tarballs into an empty project and use them the way a user would (ESM import, fake gateway,
# confirmPayment). Catches broken `exports`, missing `files`, and dependencies that only resolve inside the monorepo.
# Every gateway goes through the same steps: an early callback is refused, a paid one confirms, a tampered one is refused.
set -euo pipefail
cd "$(dirname "$0")/.."
GATEWAYS=(toyyibpay bayarcash billplz stripe chip hitpay 2c2p senangpay)
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for p in core testing "${GATEWAYS[@]}"; do (cd "packages/$p" && npm pack --silent --pack-destination "$tmp" >/dev/null); done
cd "$tmp"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund ./bayarkit-*.tgz vitest@5.0.5 >/dev/null
cat > smoke.mjs <<'JS'
import { confirmPayment } from '@bayarkit/core'
import * as testing from '@bayarkit/testing'

const order = { reference: 'SMOKE1', amount: 1500, description: 'Smoke test', customer: { name: 'Ali', email: 'a@example.com' },
  returnUrl: 'https://x/return', callbackUrl: 'https://x/cb' }

const setups = {
  toyyibpay: async () => {
    const fake = await testing.startFakeToyyibPay({ secretKey: 's', categoryCode: 'c' })
    const { toyyibpay } = await import('@bayarkit/toyyibpay')
    return { fake, gateway: toyyibpay({ secretKey: 's', categoryCode: 'c', environment: 'sandbox', baseUrl: fake.url }) }
  },
  bayarcash: async () => {
    const fake = await testing.startFakeBayarcash({ token: 't', secretKey: 's', portalKey: 'p' })
    const { bayarcash } = await import('@bayarkit/bayarcash')
    return { fake, gateway: bayarcash({ token: 't', secretKey: 's', portalKey: 'p', environment: 'sandbox', baseUrl: fake.url }) }
  },
  billplz: async () => {
    const fake = await testing.startFakeBillplz({ secretKey: 's', xSignatureKey: 'x', collectionId: 'c' })
    const { billplz } = await import('@bayarkit/billplz')
    return { fake, gateway: billplz({ secretKey: 's', xSignatureKey: 'x', collectionId: 'c', environment: 'sandbox', baseUrl: fake.url }) }
  },
  stripe: async () => {
    const fake = await testing.startFakeStripe({ secretKey: 'sk_test_smoke', webhookSecret: 'whsec_smoke' })
    const { stripe } = await import('@bayarkit/stripe')
    return { fake, gateway: stripe({ secretKey: 'sk_test_smoke', webhookSecret: 'whsec_smoke', baseUrl: fake.url }) }
  },
  chip: async () => {
    const fake = await testing.startFakeChip({ secretKey: 's', brandId: 'b' })
    const { chip } = await import('@bayarkit/chip')
    const publicKey = await chip({ secretKey: 's', brandId: 'b', baseUrl: fake.url }).fetchPublicKey()
    return { fake, gateway: chip({ secretKey: 's', brandId: 'b', publicKey, baseUrl: fake.url }) }
  },
  hitpay: async () => {
    const fake = await testing.startFakeHitPay({ apiKey: 'k', apiSalt: 'as', webhookSalt: 'ws' })
    const { hitpay } = await import('@bayarkit/hitpay')
    return { fake, gateway: hitpay({ apiKey: 'k', apiSalt: 'as', webhookSalt: 'ws', environment: 'sandbox', baseUrl: fake.url }) }
  },
  '2c2p': async () => {
    const fake = await testing.startFake2C2P({ merchantId: 'JT07', secretKey: 'SMOKEKEY' })
    const { twoc2p } = await import('@bayarkit/2c2p')
    return { fake, gateway: twoc2p({ merchantId: 'JT07', secretKey: 'SMOKEKEY', environment: 'sandbox', baseUrl: fake.url }) }
  },
  senangpay: async () => {
    const keys = { clientId: 'BRN-smoke', secretKey: 's', apiKey: 'k', notificationPath: '/doku' }
    const fake = await testing.startFakeSenangPay(keys)
    const { senangpay } = await import('@bayarkit/senangpay')
    return { fake, gateway: senangpay({ ...keys, environment: 'sandbox', baseUrl: fake.url }) }
  },
}

const names = process.argv.slice(2)
for (const name of names) {
  const { fake, gateway } = await setups[name]()
  const created = await gateway.createPayment(order)
  const early = await confirmPayment(gateway, fake.callbackFor(created.id), order)
  fake.markPaid(created.id)
  const paid = await confirmPayment(gateway, fake.callbackFor(created.id), order)
  const forged = await confirmPayment(gateway, fake.tamper(fake.callbackFor(created.id)), order)
  await fake.close()
  if (early.ok || !paid.ok || forged.ok) {
    console.error(name, { early, paid, forged })
    process.exit(1)
  }
}
console.log(`smoke ok: ${names.join(' + ')} confirmed from packed tarballs`)
JS
node smoke.mjs "${GATEWAYS[@]}"

# bayarkit-fake for non-JavaScript tests, in a project WITHOUT vitest (it is an optional peer).
cli="$(mktemp -d)"
trap 'rm -rf "$tmp" "$cli"; kill "${pid:-0}" 2>/dev/null || true' EXIT
cp "$tmp"/bayarkit-core-*.tgz "$tmp"/bayarkit-testing-*.tgz "$cli"/
cd "$cli"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund ./bayarkit-core-*.tgz ./bayarkit-testing-*.tgz >/dev/null
[ ! -d node_modules/vitest ] || { echo "vitest was installed although it is an optional peer"; exit 1; }
./node_modules/.bin/bayarkit-fake stripe > fake.out &
pid=$!
for _ in $(seq 1 50); do [ -s fake.out ] && break; sleep 0.1; done
control="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("fake.out","utf8")).control)')"
curl -fsS "$control/health" | grep -q '"gateway":"stripe"'
echo "smoke ok: bayarkit-fake runs without vitest ($control)"
