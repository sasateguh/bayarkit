#!/usr/bin/env bash
# One-time setup on release day (D20): give every @bayarkit/* package a Trusted Publisher, so that from then on only
# .github/workflows/release.yml (environment npm) can publish. Run it yourself in a terminal after `npx npm@11 login`:
# every change asks for a 2FA code (EOTP), so it cannot run unattended.
#
# Trusted publishing cannot create a package that does not exist yet. If npm refuses a package for that reason, the
# script asks before publishing a 0.0.0 placeholder (name only, no code) and then sets the trust. A trust that sees no
# publish within 2 days expires, so tag v0.1.0 soon after. Ends with `npm logout`, which revokes the login token.
set -euo pipefail
cd "$(dirname "$0")/.."
npm11=(npx -y npm@11)
repo="sasateguh/bayarkit"
otp=""

# The prompt goes to the terminal directly: callers redirect stderr.
ask_otp() { printf "2FA code (authenticator app): " >/dev/tty; read -r otp </dev/tty; }

# Runs an npm command with the current code; asks for a fresh one when npm says it is missing or expired.
with_otp() {
  local out
  for _ in 1 2 3; do
    if out="$("${npm11[@]}" "$@" ${otp:+--otp="$otp"} 2>&1)"; then printf '%s\n' "$out"; return 0; fi
    if grep -q 'EOTP\|one-time password' <<<"$out"; then ask_otp; continue; fi
    printf '%s\n' "$out" >&2
    return 1
  done
  return 1
}

placeholder() {
  local name="$1" dir
  dir="$(mktemp -d)"
  cat >"$dir/package.json" <<JSON
{"name": "$name", "version": "0.0.0", "description": "Name reserved for bayarkit. The first release is 0.1.0.",
 "license": "MIT", "repository": {"type": "git", "url": "git+https://github.com/$repo.git"}}
JSON
  printf '# %s\n\nName reserved for [bayarkit](https://github.com/%s). Install 0.1.0 or later.\n' "$name" "$repo" >"$dir/README.md"
  (cd "$dir" && with_otp publish --access public --provenance=false)
  rm -rf "$dir"
}

echo "npm user: $("${npm11[@]}" whoami)"
allow_placeholder=""
for d in packages/*/; do
  name="$(node -p "require('./${d}package.json').name")"
  trust=(trust github "$name" --file release.yml --repo "$repo" --env npm --allow-publish --yes)
  if with_otp "${trust[@]}" >/dev/null 2>"/tmp/npm-trust-err.$$"; then echo "✓ $name"; continue; fi
  if ! "${npm11[@]}" view "$name" version >/dev/null 2>&1; then
    if [ -z "$allow_placeholder" ]; then
      cat "/tmp/npm-trust-err.$$" >&2
      read -r -p "$name does not exist on npm yet. Publish 0.0.0 placeholders for missing packages? [y/N] " a </dev/tty
      allow_placeholder="${a:-n}"
    fi
    if [ "$allow_placeholder" = y ]; then
      placeholder "$name" >/dev/null && with_otp "${trust[@]}" >/dev/null && { echo "✓ $name (placeholder 0.0.0)"; continue; }
    fi
  fi
  echo "✗ $name"; cat "/tmp/npm-trust-err.$$" >&2
done
rm -f "/tmp/npm-trust-err.$$"
"${npm11[@]}" logout && echo "logged out (token revoked)"
