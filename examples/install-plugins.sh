#!/usr/bin/env bash
# Proves the install commands in README.md, design/README.md, browser-tools/README.md
# and diagram/README.md still work. Uses a throwaway OMP profile so the real plugin
# registry is never touched.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
profile="omp-plugins-example-$$"
work=$(mktemp -d)
export OMP_PROFILE="$profile"

cleanup() {
  rm -r -- "$work" 2>/dev/null || true
  rm -r -- "$HOME/.omp/profiles/$profile" 2>/dev/null || true
}
trap cleanup EXIT

cd "$work"

# The command every package README opens with.
omp plugin marketplace add srobroek/omp-plugins

for pkg in design browser-tools diagram; do
  omp plugin install "$pkg@srobroek-omp"
done

listing=$(omp plugin list)

for pkg in design browser-tools diagram; do
  if ! grep -q "$pkg@srobroek-omp" <<<"$listing"; then
    echo "FAIL: omp plugin list does not report $pkg@srobroek-omp" >&2
    echo "$listing" >&2
    exit 1
  fi
done

# The README claims doctor reports a per-plugin line for a LINKED directory only,
# so an installed package must NOT produce one.
if omp plugin doctor | grep -q "plugin:@srobroek/design"; then
  echo "FAIL: doctor named an installed package; the README says link only" >&2
  exit 1
fi

omp plugin link "$repo/design"
if ! omp plugin doctor | grep -q "plugin:@srobroek/design"; then
  echo "FAIL: doctor did not name the linked package" >&2
  exit 1
fi

echo "PASS: three installs listed, and doctor names the linked package only"
