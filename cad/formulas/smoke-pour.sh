#!/usr/bin/env bash
# Prove every CAD formula pours or bonds in an isolated Beads workspace.
# Requires bd on PATH; the repo's .beads store is never used.
set -euo pipefail

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

mkdir -p "$work/.beads/formulas"
cp "$repo"/cad/formulas/*.formula.toml "$work/.beads/formulas/"
cd "$work"
export BEADS_DIR="$work/.beads"
export BEADS_ACTOR=cad-formula-smoke
export BEADS_DOLT_SHARED_SERVER=

bd init --quiet >/dev/null

formula_counts() {
  local formula=$1 file="$work/.beads/formulas/$1.formula.toml"
  local steps gates
  steps=$(grep -c '^\[\[steps\]\]$' "$file")
  gates=$(grep -c '^type = "human"$' "$file" || true)
  printf '%s: %s steps, %s gates\n' "$formula" "$steps" "$gates"
}

pour() {
  local formula=$1 output root
  shift
  output=$(bd mol pour "$formula" "$@")
  printf '%s\n' "$output" >&2
  root=$(sed -n 's/.*Root issue: //p' <<<"$output")
  if [[ -z "$root" ]]; then
    echo "FAIL: $formula pour printed no 'Root issue:' line" >&2
    exit 1
  fi
  formula_counts "$formula" >&2
  printf '%s' "$root"
}

root=$(pour cad-part --var product=smoke-part --var scope=hw/ \
  --var kernel=cadquery --var process_default=fdm)
product_root=$(pour cad-product --var product=smoke-product --var scope=hw/ \
  --var kernel=build123d --var process_default=cnc)
eco_root=$(pour cad-touch --var product=smoke-part --var scope=hw/ \
  --var part=SMK-0001 --var from_rev=A --var to_rev=B \
  --var decision=DR-001 --var change='smoke ECO' \
  --var kernel=cadquery --var process_default=fdm)

bond() {
  local formula=$1 target=$2 output
  shift 2
  output=$(bd mol bond "$formula" "$target" "$@")
  printf '%s\n' "$output"
  if ! grep -Fq "Bonded: $formula + $target" <<<"$output"; then
    echo "FAIL: $formula did not bond onto $target" >&2
    exit 1
  fi
  formula_counts "$formula"
}

bond mol-cad-part "$product_root" --type parallel \
  --var product=smoke-product --var scope=hw/ --var subassembly=frame \
  --var kernel=build123d --var process_default=cnc --ref part-frame
bond mol-cad-concept "$root" --var product=smoke-part --var scope=hw/ \
  --var round=2 --var kernel=cadquery --var process_default=fdm --ref concept-round-2
bond mol-cad-iterate "$product_root" --var product=smoke-product --var scope=hw/ \
  --var change='approved intent change' --var affected_parts=SMK-0001 \
  --var kernel=build123d --var process_default=cnc --ref iterate-affected
bond mol-cad-release "$product_root" --var product=smoke-product --var scope=hw/ \
  --var release_rev=A --var kernel=build123d --var process_default=cnc --ref release-A

# Also exercise an ECO-specific target rather than relying on another pour root.
bond mol-cad-release "$eco_root" --var product=smoke-part --var scope=hw/ \
  --var release_rev=B --var kernel=cadquery --var process_default=fdm --ref release-B

echo "PASS: poured cad-part, cad-product, cad-touch; bonded all four mol-cad formulas in $BEADS_DIR"
