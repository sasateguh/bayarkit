#!/usr/bin/env bash
# Publish every package to npm, core first (every other package depends on it), then testing, then the adapters.
# A version already on npm is skipped, so a re-run after a partial failure publishes only what is missing.
# --dry-run: npm publish --dry-run for each package (what would go out, nothing is sent).
# Auth: npm Trusted Publishing from .github/workflows/release.yml only, never an npm token.
set -euo pipefail
cd "$(dirname "$0")/.."
dry=()
[ "${1:-}" = "--dry-run" ] && dry=(--dry-run)

order=(core testing)
for d in packages/*/; do
  d="$(basename "$d")"
  [ "$d" = core ] || [ "$d" = testing ] || order+=("$d")
done

for d in "${order[@]}"; do
  name="$(node -p "require('./packages/$d/package.json').name")"
  version="$(node -p "require('./packages/$d/package.json').version")"
  # npm view exits non-zero (E404) for a version that does not exist yet; that is the case to publish.
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "= $name@$version already on npm, skipped"
    continue
  fi
  echo "→ $name@$version"
  # npm silently rewrites a package.json it disagrees with, and may DROP fields: npm 11.21 removed the
  # "./dist/cli.js" bin of @bayarkit/testing 0.3.2 ("was invalid and removed"), so `npx bayarkit-fake` vanished.
  # Any auto-correction stops the release before that package goes out.
  check="$(npm publish -w "$name" --dry-run --provenance=false 2>&1 || true)"
  if grep -q "auto-corrected" <<<"$check"; then
    grep -A5 "auto-corrected" <<<"$check" >&2
    echo "✗ npm would rewrite packages/$d/package.json: fix it (npm pkg fix) before publishing" >&2
    exit 1
  fi
  # Provenance needs the CI's OIDC token, so a local dry run turns it off; the workflow publishes with it on.
  if [ ${#dry[@]} -gt 0 ]; then
    npm publish -w "$name" "${dry[@]}" --provenance=false >/dev/null
  else
    npm publish -w "$name"
  fi
done
echo "✓ publish ${dry[*]:-done}"
