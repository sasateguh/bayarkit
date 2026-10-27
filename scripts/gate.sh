#!/usr/bin/env bash
# The gate before every commit and release. Runs offline (fakes only); sandbox runs are separate (see CONTRIBUTING).
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc -p tsconfig.json
npx biome check .
npx vitest run
node tools/rujukan.mjs lint
node tools/rujukan.mjs skills --check
node scripts/release-check.mjs
rm -rf packages/*/dist
npm run build >/dev/null
bash scripts/smoke-pack.sh
bash scripts/php-gate.sh
echo "✓ gate bayarkit lulus"
