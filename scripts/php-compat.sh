#!/usr/bin/env bash
# The PHP package against the edges of what composer.json promises: PHP 8.2 with the LOWEST allowed dependencies
# (Laravel 11) and PHP 8.4 with the newest. Each runs on a throwaway copy, so php/vendor of the gate is untouched.
# Slower than the gate (fresh dependency resolution); run before a release and after changing composer.json.
set -euo pipefail
cd "$(dirname "$0")/.."
copies=()
trap 'for c in "${copies[@]}"; do rm -rf "$c"; done' EXIT
for combo in "8.2.35 lowest" "8.4.27 highest"; do
  read -r version deps <<<"$combo"
  copy="$(mktemp -d)"
  copies+=("$copy")
  mkdir -p "$copy/packages/core/src"
  # Only what the PHP tests read: the package itself, the TS page they pin against, and the shared money vectors.
  tar -C php --exclude=vendor --exclude=composer.lock --exclude=.phpunit.cache -cf - . | (mkdir -p "$copy/php" && tar -C "$copy/php" -xf -)
  cp packages/core/src/checkout.ts "$copy/packages/core/src/"
  mkdir -p "$copy/packages/core/test" && cp packages/core/test/money-vectors.json "$copy/packages/core/test/"
  echo "── PHP $version, $deps dependencies"
  PHP_VERSION="$version" PHP_DEPS="$deps" PHP_ROOT="$copy" bash scripts/php-gate.sh
done
echo "✓ php compat bayarkit lulus"
