#!/usr/bin/env bash
set -euo pipefail

# check.sh: run Go format, lint, and test checks in order.
#   1. gofmt -l (formatting; always)
#   2. golangci-lint run (only when installed; skipped otherwise)
#   3. go test ./...
#
# Usage: check.sh [--help]

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
usage: check.sh

Runs, in order:
  1. gofmt -l .                                (formatting; always)
  2. golangci-lint run                          (only when installed)
  3. go test ./...

See fix.sh for the narrower auto-fix counterpart (gofmt -w only).
EOF
    exit 0
    ;;
esac

gofmt_output=$(gofmt -l .)
if [[ -n "$gofmt_output" ]]; then
  printf '%s\n' "$gofmt_output"
  exit 1
fi

if command -v golangci-lint >/dev/null 2>&1; then
  golangci-lint run
fi

go test ./...
