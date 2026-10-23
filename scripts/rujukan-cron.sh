#!/usr/bin/env bash
# Daily docs watch (cron). Exit 2 from `check` = a source changed for the first time; 3 = a source could not be read
# (gone, blocked, or no longer contains its mustContain words). Either one notifies through ~/bin/notify.sh when that
# helper exists (this host); elsewhere the output and exit code are the signal.
set -uo pipefail
cd "$(dirname "$0")/.."
for d in "$HOME"/.nvm/versions/node/v22*/bin; do PATH="$d:$PATH"; done   # cron PATH has no node 22
out="$(node tools/rujukan.mjs check 2>&1)"; rc=$?
printf '%s\n' "── $(date -u +%FT%TZ) rc=$rc" "$out"
notify="$HOME/bin/notify.sh"
if [ "$rc" -eq 2 ] && [ -x "$notify" ]; then
  "$notify" "bayarkit: dokumen rasmi gateway BERUBAH — semak spec + palsu + adapter:
$(grep '△' <<<"$out")" warn
elif [ "$rc" -ne 0 ] && [ -x "$notify" ]; then
  "$notify" "bayarkit rujukan gagal (rc=$rc):
$(grep '✗' <<<"$out" | head -5)" warn
fi
exit "$rc"
