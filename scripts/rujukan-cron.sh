#!/usr/bin/env bash
# Daily docs watch (cron). Exit 2 from `check` = a source changed for the first time; 3 = a source could not be read
# (gone, blocked, or no longer contains its mustContain words). The alert text is built (and rate-limited) by
# `rujukan.mjs alert`: on a new change, and once a week while the oldest unreviewed change is a week old; a failed
# source gets its own alert. Sent through RUJUKAN_NOTIFY (default ~/bin/notify.sh) when that helper exists (this
# host); elsewhere the output and exit code are the signal.
set -uo pipefail
cd "$(dirname "$0")/.."
for d in "$HOME"/.nvm/versions/node/v22*/bin; do PATH="$d:$PATH"; done   # cron PATH has no node 22
out="$(node tools/rujukan.mjs check 2>&1)"; rc=$?
printf '%s\n' "── $(date -u +%FT%TZ) rc=$rc" "$out"
notify="${RUJUKAN_NOTIFY:-$HOME/bin/notify.sh}"
send() { [ -n "$1" ] || return 0; printf '%s\n' "→ alert:" "$1"; [ -x "$notify" ] && "$notify" "$1" warn; return 0; }
if [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ] || [ "$rc" -eq 3 ]; then
  # rc 2 (newly changed) always alerts; rc 0/3 alert too when the backlog is a week old (at most weekly).
  send "$(node tools/rujukan.mjs alert 2>&1)"
  [ "$rc" -eq 3 ] && send "$(node tools/rujukan.mjs alert --failed 2>&1)"
else
  send "bayarkit rujukan gagal (rc=$rc):
$(tail -5 <<<"$out")
Buat: cd ~/bayarkit && node tools/rujukan.mjs check — baca ralat."
fi
exit "$rc"
