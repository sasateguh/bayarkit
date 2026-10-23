#!/usr/bin/env bash
# The gate before every commit and release. Runs offline (fakes only); sandbox runs are separate (see CONTRIBUTING).
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc -p tsconfig.json
npx biome check .
npx vitest run
rm -rf packages/*/dist
npm run build >/dev/null
bash scripts/smoke-pack.sh
echo "✓ gate bayarkit lulus"
