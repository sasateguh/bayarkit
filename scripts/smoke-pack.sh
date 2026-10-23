#!/usr/bin/env bash
# Install the PACKED tarballs into an empty project and use them the way a user would (ESM import, fake gateway,
# confirmPayment). Catches broken `exports`, missing `files`, and dependencies that only resolve inside the monorepo.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for p in core testing toyyibpay bayarcash stripe; do (cd "packages/$p" && npm pack --silent --pack-destination "$tmp" >/dev/null); done
cd "$tmp"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund ./bayarkit-core-*.tgz ./bayarkit-testing-*.tgz ./bayarkit-toyyibpay-*.tgz ./bayarkit-bayarcash-*.tgz ./bayarkit-stripe-*.tgz vitest@5.0.5 >/dev/null
cat > smoke.mjs <<'JS'
import { confirmPayment } from '@bayarkit/core'
import { startFakeToyyibPay, startFakeBayarcash, startFakeStripe } from '@bayarkit/testing'
import { toyyibpay } from '@bayarkit/toyyibpay'
import { bayarcash } from '@bayarkit/bayarcash'
import { stripe } from '@bayarkit/stripe'

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
const st = await startFakeStripe({ secretKey: 'sk_test_smoke', webhookSecret: 'whsec_smoke' })
const g3 = stripe({ secretKey: 'sk_test_smoke', webhookSecret: 'whsec_smoke', baseUrl: st.url })
const b3 = await g3.createPayment(order)
const early = await confirmPayment(g3, st.callbackFor(b3.id), order)
st.markPaid(b3.id)
const r3 = await confirmPayment(g3, st.callbackFor(b3.id), order)
const forged = await confirmPayment(g3, st.tamper(st.callbackFor(b3.id)), order)
await tp.close(); await bc.close(); await st.close()
if (!r1.ok || !r2.ok || !r3.ok || early.ok || forged.ok) { console.error(r1, r2, r3, early, forged); process.exit(1) }
console.log('smoke ok: toyyibpay + bayarcash + stripe confirmed from packed tarballs')
JS
node smoke.mjs
