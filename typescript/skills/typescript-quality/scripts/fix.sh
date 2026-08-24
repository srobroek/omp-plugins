#!/usr/bin/env bash
set -euo pipefail

if [ ! -f package.json ]; then
  echo "Warning: no package.json found; skipping TypeScript fixes." >&2
  exit 0
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm exec biome check --write .
  exit 0
fi
if command -v bun >/dev/null 2>&1; then
  bunx biome check --write .
  exit 0
fi
if command -v npx >/dev/null 2>&1; then
  npx --yes biome check --write .
  exit 0
fi

# No package manager available: fall back to a globally installed tool.
if command -v biome >/dev/null 2>&1; then
  biome check --write .
  exit 0
fi

echo "Warning: package.json present but no package manager (pnpm/bun/npx) or global biome found; skipping TypeScript fixes." >&2
exit 0
