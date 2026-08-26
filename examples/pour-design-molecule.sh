#!/usr/bin/env bash
# Proves the pour-and-bond example in design/README.md still works, in a throwaway
# beads workspace. Requires bd on PATH.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -r -- "$work" 2>/dev/null || true' EXIT

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

cd "$work"
bd init >/dev/null
mkdir -p .beads/formulas
cp "$repo"/design/formulas/*.formula.toml .beads/formulas/

# The exact sequence design/README.md documents.
export BEADS_ACTOR=you
root=$(bd mol pour design-touch --var surface=/settings --var scope=src/settings/ \
  | sed -n 's/.*Root issue: //p')

if [[ -z "$root" ]]; then
  echo "FAIL: the pour printed no 'Root issue:' line to capture" >&2
  exit 1
fi

bonded=$(bd mol bond mol-design-iterate "$root" \
  --var surface=/settings --var node="$root" --var round=2)

if ! grep -q "Bonded: mol-design-iterate + $root" <<<"$bonded"; then
  echo "FAIL: bond did not report bonding onto $root" >&2
  echo "$bonded" >&2
  exit 1
fi

spawned=$(sed -n 's/.*Spawned: \([0-9]*\) issues.*/\1/p' <<<"$bonded")
if [[ "${spawned:-0}" -lt 1 ]]; then
  echo "FAIL: bond spawned no issues" >&2
  echo "$bonded" >&2
  exit 1
fi

echo "PASS: poured $root and bonded a molecule spawning $spawned issues onto it"
