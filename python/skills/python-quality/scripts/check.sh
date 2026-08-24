#!/usr/bin/env bash
set -euo pipefail

# check.sh: run Python format, lint, type-check, and test checks in order.
#   1. ruff check + ruff format --check (always)
#   2. pyright (only when installed; skipped otherwise)
#   3. pytest (only when installed and pyproject.toml or tests/ exists)
#
# Usage: check.sh [--help]

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
usage: check.sh

Runs, in order:
  1. ruff check . && ruff format --check .      (always)
  2. pyright                                     (only when installed)
  3. pytest                                       (only when installed and
                                                    pyproject.toml or tests/ exists)

See fix.sh for the narrower auto-fix counterpart (ruff check --fix, ruff format).
EOF
    exit 0
    ;;
esac

ruff check .
ruff format --check .

if command -v pyright >/dev/null 2>&1; then
  pyright
fi

if [ -f pyproject.toml ] || [ -d tests ]; then
  if command -v pytest >/dev/null 2>&1; then
    pytest
  fi
fi
