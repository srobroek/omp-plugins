#!/usr/bin/env bash
set -euo pipefail

# check.sh: run TypeScript/JavaScript format, lint, and type-check via the
# first available package manager (pnpm, then bun, then npx), falling back to
# a globally installed biome/tsc. Warns and exits 0 if none is available.
#
# Usage: check.sh [--help]

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
usage: check.sh

Runs biome check + tsc --noEmit via the first available runner:
  1. pnpm exec / bunx / npx --yes   (first package manager found on PATH)
  2. globally installed biome (and tsc if present)
  3. otherwise: warn and exit 0 -- fall back to project-native package.json
     scripts or eslint manually

See fix.sh for the narrower auto-fix counterpart (biome check --write only).
EOF
    exit 0
    ;;
esac

if [ ! -f package.json ]; then
  echo "Warning: no package.json found; skipping TypeScript checks." >&2
  exit 0
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm exec biome check . && pnpm exec tsc --noEmit
  exit 0
fi
if command -v bun >/dev/null 2>&1; then
  bunx biome check . && bunx tsc --noEmit
  exit 0
fi
if command -v npx >/dev/null 2>&1; then
  npx --yes biome check . && npx --yes tsc --noEmit
  exit 0
fi

# No package manager available: fall back to globally installed tools.
if command -v biome >/dev/null 2>&1; then
  biome check .
  if command -v tsc >/dev/null 2>&1; then
    tsc --noEmit
  else
    echo "Warning: tsc not found; skipping type check." >&2
  fi
  exit 0
fi

echo "Warning: package.json present but no package manager (pnpm/bun/npx) or global biome found; skipping TypeScript checks." >&2
exit 0
