#!/usr/bin/env bash
# Install the PACKED tarballs into an empty project and use them the way a user would (ESM import, fake gateway,
# confirmPayment). Catches broken `exports`, missing `files`, and dependencies that only resolve inside the monorepo.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for p in core testing toyyibpay bayarcash chip; do (cd "packages/$p" && npm pack --silent --pack-destination "$tmp" >/dev/null); done
cd "$tmp"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund ./bayarkit-core-*.tgz ./bayarkit-testing-*.tgz ./bayarkit-toyyibpay-*.tgz ./bayarkit-bayarcash-*.tgz ./bayarkit-chip-*.tgz vitest@5.0.5 >/dev/null
cat > smoke.mjs <<'JS'
import { confirmPayment } from '@bayarkit/core'
import { startFakeToyyibPay, startFakeBayarcash, startFakeChip } from '@bayarkit/testing'
import { toyyibpay } from '@bayarkit/toyyibpay'
import { bayarcash } from '@bayarkit/bayarcash'
import { chip } from '@bayarkit/chip'

const order = { reference: 'SMOKE1', amount: 1500, description: 'Smoke test', customer: { name: 'A', email: 'a@example.com' },
  returnUrl: 'https://x/return', callbackUrl: 'https://x/cb' }
const tp = await startFakeToyyibPay({ secretKey: 's', categoryCode: 'c' })
const g1 = toyyibpay({ secretKey: 's', categoryCode: 'c', environment: 'sandbox', baseUrl: tp.url })
const b1 = await g1.createPayment(order); tp.markPaid(b1.id)
const r1 = await confirmPayment(g1, tp.callbackFor(b1.id), order)
const bc = await startFakeBayarcash({ token: 't', secretKey: 's', portalKey: 'p' })
const g2 = bayarcash({ token: 't', secretKey: 's', portalKey: 'p', environment: 'sandbox', baseUrl: bc.url })
const b2 = await g2.createPayment(order); bc.markPaid(b2.id)
const r2 = await confirmPayment(g2, bc.callbackFor(b2.id), order)
const ch = await startFakeChip({ secretKey: 's', brandId: 'b' })
const publicKey = await chip({ secretKey: 's', brandId: 'b', baseUrl: ch.url }).fetchPublicKey()
const g3 = chip({ secretKey: 's', brandId: 'b', publicKey, baseUrl: ch.url })
const b3 = await g3.createPayment(order); ch.markPaid(b3.id)
const r3 = await confirmPayment(g3, ch.callbackFor(b3.id), order)
await tp.close(); await bc.close(); await ch.close()
if (!r1.ok || !r2.ok || !r3.ok) { console.error(r1, r2, r3); process.exit(1) }
console.log('smoke ok: toyyibpay + bayarcash + chip confirmed from packed tarballs')
JS
node smoke.mjs
