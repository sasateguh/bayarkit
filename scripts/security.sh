#!/usr/bin/env bash
# Security checks before a release (D7), using the same scanners and policy as Perisai (~/perisai/config/polisi.yaml):
# - semgrep p/default + p/owasp-top-ten + p/typescript + p/php over EVERY packages/*/src (a glob: a hand list once left
#   nine adapters unscanned), php/src, php/config, examples/ and tools/. --no-git-ignore is required
#   (without it semgrep can scan 0 files and still exit 0), coverage fails on any per-rule timeout;
# - osv-scanner over package-lock.json (runtime AND dev dependencies);
# - gitleaks over the whole git history.
# A scanner that exits 0 without scanning is a failure here, not a pass.
set -euo pipefail
cd "$(dirname "$0")/.."
PATH="$HOME/.local/bin:$PATH"
out="$(mktemp -d)"; trap 'rm -rf "$out"' EXIT
fail=0

semgrep scan --metrics=off --quiet --no-git-ignore --json -o "$out/semgrep.json" \
  --timeout 60 --timeout-threshold 0 \
  --config p/default --config p/owasp-top-ten --config p/typescript --config p/php \
  packages/*/src php/src php/config examples tools || true
python3 - "$out/semgrep.json" <<'PY' || fail=1
import json, sys
d = json.load(open(sys.argv[1]))
scanned = len(d.get("paths", {}).get("scanned", []))
timeouts = [e for e in d.get("errors", []) if "Timeout" in str(e.get("type"))]
results = d.get("results", [])
print(f"semgrep: {scanned} files scanned, {len(timeouts)} rule timeouts, {len(results)} findings")
for r in results:
    print(f"  {r['extra'].get('severity')} {r['check_id'].split('.')[-1]} {r['path']}:{r['start']['line']}")
# Every source directory must be in the scan, so a new package can never be silently skipped.
import glob, os
dirs = sorted(glob.glob("packages/*/src")) + ["php/src", "examples/demo", "examples/web-standard"]
paths = d.get("paths", {}).get("scanned", [])
missing = [x for x in dirs if not any(p.startswith(x + "/") for p in paths)]
for x in missing:
    print(f"  NOT SCANNED: {x}")
sys.exit(1 if scanned == 0 or timeouts or results or missing else 0)
PY

if osv-scanner scan --lockfile package-lock.json >"$out/osv.txt" 2>&1; then
  echo "osv-scanner: $(grep -m1 -i 'no issues\|packages' "$out/osv.txt" || echo ok)"
else
  echo "osv-scanner: vulnerabilities or error"; cat "$out/osv.txt"; fail=1
fi

if gitleaks detect --no-banner --redact >"$out/gl.txt" 2>&1; then
  echo "gitleaks: $(grep -o 'commits scanned\|no leaks found' "$out/gl.txt" | head -1), full history"
else
  echo "gitleaks: leaks or error"; cat "$out/gl.txt"; fail=1
fi

[ "$fail" -eq 0 ] && echo "✓ security bayarkit lulus" || { echo "✗ security bayarkit GAGAL"; exit 1; }
