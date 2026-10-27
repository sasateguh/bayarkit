#!/usr/bin/env bash
# One-time: give .github/workflows/php-split.yml a deploy key that can push to sasateguh/bayarkit-php, and nothing else.
# Needs deploy keys allowed in the sasateguh organisation (Settings → Member privileges → Deploy keys). The private key
# goes straight into the bayarkit secret PHP_SPLIT_DEPLOY_KEY and is then destroyed; run again to rotate.
set -euo pipefail
k="$(mktemp -d)"
trap 'shred -u "$k/key" 2>/dev/null || true; rm -rf "$k"' EXIT
ssh-keygen -q -t ed25519 -N '' -C "bayarkit php-split" -f "$k/key"
gh repo deploy-key add "$k/key.pub" -R sasateguh/bayarkit-php --title "bayarkit php-split (Actions)" --allow-write
gh secret set PHP_SPLIT_DEPLOY_KEY -R sasateguh/bayarkit <"$k/key"
echo "✓ deploy key on sasateguh/bayarkit-php, secret PHP_SPLIT_DEPLOY_KEY on sasateguh/bayarkit"
