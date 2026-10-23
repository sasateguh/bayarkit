#!/usr/bin/env bash
# Install the PACKED tarballs into an empty project and use them the way a user would (ESM import, fake gateway,
# confirmPayment). Catches broken `exports`, missing `files`, and dependencies that only resolve inside the monorepo.
# Every gateway goes through the same steps: an early callback is refused, a paid one confirms, a tampered one is refused.
set -euo pipefail
cd "$(dirname "$0")/.."
# One setup file per gateway in scripts/smoke/<id>.mjs: adding a gateway adds a file, never edits this script.
GATEWAYS=()
for f in scripts/smoke/*.mjs; do GATEWAYS+=("$(basename "$f" .mjs)"); done
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for p in core testing "${GATEWAYS[@]}"; do (cd "packages/$p" && npm pack --silent --pack-destination "$tmp" >/dev/null); done
mkdir -p "$tmp/setups" && cp scripts/smoke/*.mjs "$tmp/setups/"
cd "$tmp"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund ./bayarkit-*.tgz vitest@5.0.5 >/dev/null
cat > smoke.mjs <<'JS'
import { confirmPayment } from '@bayarkit/core'
import * as testing from '@bayarkit/testing'

const order = { reference: 'SMOKE1', amount: 1500, description: 'Smoke test', customer: { name: 'Ali', email: 'a@example.com' },
  returnUrl: 'https://x/return', callbackUrl: 'https://x/cb' }

const names = process.argv.slice(2)
for (const name of names) {
  const { default: setup } = await import(`./setups/${name}.mjs`)
  const { fake, gateway } = await setup(testing)
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
