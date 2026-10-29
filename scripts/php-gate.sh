#!/usr/bin/env bash
# PHP package gate (php/): the same fake gateways as the TS suite, run by `bayarkit-fake`, driven from PHPUnit.
# Needs `npm run build` first (the CLI runs from packages/testing/dist). Uses local php+composer when present, else the
# pinned test image (php/Dockerfile.test) — the host has no PHP.
set -euo pipefail
cd "$(dirname "$0")/.."
cli=packages/testing/dist/cli.js
[ -f "$cli" ] || { echo "php-gate: $cli missing — run npm run build first" >&2; exit 1; }
work="$(mktemp -d)"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true; rm -rf "$work"' EXIT
fakes='{}'
for g in toyyibpay chip paddle; do
  node "$cli" "$g" > "$work/$g.json" &
  pids+=($!)
  for _ in $(seq 1 100); do [ -s "$work/$g.json" ] && break; sleep 0.1; done
  [ -s "$work/$g.json" ] || { echo "php-gate: bayarkit-fake $g did not start" >&2; exit 1; }
  fakes="$(node -e 'const [a,g,f]=process.argv.slice(1);const o=JSON.parse(a);o[g]=JSON.parse(require("fs").readFileSync(f,"utf8"));console.log(JSON.stringify(o))' "$fakes" "$g" "$work/$g.json")"
done
# set -e inside: every step's own error output is shown (a silent failure here once looked like a pass).
# PHP_GATE_STATIC=0 skips php -l + phpstan (sabotage runs only; the gate always runs them).
# PHP_VERSION / PHP_DEPS (locked|lowest|highest) / PHP_ROOT are set by scripts/php-compat.sh; the gate uses the defaults.
php_version="${PHP_VERSION:-8.3.36}"
root="${PHP_ROOT:-$PWD}"
install='composer install --no-interaction --no-progress'
case "${PHP_DEPS:-locked}" in
  lowest) install='composer update --prefer-lowest --prefer-stable --no-interaction --no-progress' ;;
  highest) install='composer update --no-interaction --no-progress' ;;
esac
static='for f in $(find src config lang tests -name "*.php"); do php -l "$f" >/dev/null; done; vendor/bin/phpstan analyse --no-progress --memory-limit=1G --error-format=raw;'
[ "${PHP_GATE_STATIC:-1}" = 0 ] && static=''
steps="set -e; $install 2>&1 | tail -3; php -r 'echo \"PHP \", PHP_VERSION, PHP_EOL;'; composer show laravel/framework 2>/dev/null | grep -m1 '^versions' | sed 's/^versions : \* /laravel\/framework /'; $static vendor/bin/phpunit"
if [ -z "${PHP_VERSION:-}" ] && command -v php >/dev/null && command -v composer >/dev/null; then
  (cd php && BAYARKIT_FAKES="$fakes" bash -c "$steps")
else
  image="bayarkit-php-test:$php_version"
  docker image inspect "$image" >/dev/null 2>&1 \
    || docker build -q --build-arg "PHP_VERSION=$php_version" -t "$image" -f php/Dockerfile.test php >/dev/null
  mkdir -p "$HOME/.cache/composer"
  # --network host: PHPUnit reaches the fakes on 127.0.0.1. Runs as the caller so vendor/ is not root-owned.
  docker run --rm --network host -u "$(id -u):$(id -g)" -e HOME=/tmp -e COMPOSER_HOME=/tmp/composer \
    -v "$HOME/.cache/composer:/tmp/composer/cache" -v "$root:/repo" -w /repo/php -e BAYARKIT_FAKES="$fakes" \
    "$image" sh -c "$steps"
fi
echo "✓ php bayarkit lulus"
