#!/usr/bin/env bash
# Publish every package to npm, core first (every other package depends on it), then testing, then the adapters.
# A version already on npm is skipped, so a re-run after a partial failure publishes only what is missing.
# --dry-run: npm publish --dry-run for each package (what would go out, nothing is sent).
# Auth: npm Trusted Publishing from .github/workflows/release.yml only (gilap D22) — never an npm token.
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
  # Provenance needs the CI's OIDC token, so a local dry run turns it off; the workflow publishes with it on.
  if [ ${#dry[@]} -gt 0 ]; then
    npm publish -w "$name" "${dry[@]}" --provenance=false >/dev/null
  else
    npm publish -w "$name"
  fi
done
echo "✓ publish ${dry[*]:-done}"
