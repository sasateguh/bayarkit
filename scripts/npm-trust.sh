#!/usr/bin/env bash
# One-time setup on release day (D20): give every @bayarkit/* package a Trusted Publisher, so that from then on only
# .github/workflows/release.yml (environment npm) can publish. Run it yourself in a terminal after `npx npm@11 login`.
# Every change needs 2FA: npm prints "Authenticate your account at: <link>" and waits — open the link, approve
# (passkey / Face ID), and the script carries on. It needs a real terminal; without one npm fails with EOTP.
#
# Trusted publishing cannot create a package that does not exist yet. If npm refuses a package for that reason, the
# script asks before publishing a 0.0.0 placeholder (name only, no code) and then sets the trust. A trust that sees no
# publish within 2 days expires, so tag v0.1.0 soon after. Ends with `npm logout`, which revokes the login token.
set -euo pipefail
cd "$(dirname "$0")/.."
npm11=(npx -y npm@11)
repo="sasateguh/bayarkit"

placeholder() {
  local name="$1" dir
  dir="$(mktemp -d)"
  cat >"$dir/package.json" <<JSON
{"name": "$name", "version": "0.0.0", "description": "Name reserved for bayarkit. The first release is 0.1.0.",
 "license": "MIT", "repository": {"type": "git", "url": "git+https://github.com/$repo.git"}}
JSON
  printf '# %s\n\nName reserved for [bayarkit](https://github.com/%s). Install 0.1.0 or later.\n' "$name" "$repo" >"$dir/README.md"
  (cd "$dir" && "${npm11[@]}" publish --access public --provenance=false)
  rm -rf "$dir"
}

echo "npm user: $("${npm11[@]}" whoami)"
allow_placeholder=""
failed=()
for d in packages/*/; do
  name="$(node -p "require('./${d}package.json').name")"
  trust=(trust github "$name" --file release.yml --repo "$repo" --env npm --allow-publish --yes)
  echo "── $name"
  if "${npm11[@]}" "${trust[@]}"; then echo "✓ $name"; continue; fi
  if ! "${npm11[@]}" view "$name" version >/dev/null 2>&1; then
    if [ -z "$allow_placeholder" ]; then
      read -r -p "$name does not exist on npm yet. Publish 0.0.0 placeholders for missing packages? [y/N] " a
      allow_placeholder="${a:-n}"
    fi
    if [ "$allow_placeholder" = y ] && placeholder "$name" && "${npm11[@]}" "${trust[@]}"; then
      echo "✓ $name (placeholder 0.0.0)"
      continue
    fi
  fi
  echo "✗ $name"
  failed+=("$name")
done
"${npm11[@]}" logout && echo "logged out (token revoked)"
[ ${#failed[@]} -eq 0 ] && echo "✓ all packages trust sasateguh/bayarkit release.yml (env npm)" || {
  echo "✗ not set: ${failed[*]} — run again after fixing (packages already set are set again, harmless)"
  exit 1
}
