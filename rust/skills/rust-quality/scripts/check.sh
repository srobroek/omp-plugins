#!/usr/bin/env bash
set -euo pipefail

# check.sh: run Rust format, lint, and test checks in order.
#   1. cargo fmt --check
#   2. cargo clippy --all-targets --all-features -- -D warnings
#   3. cargo test
#
# Usage: check.sh [--help]

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
usage: check.sh

Runs, in order:
  1. cargo fmt --check
  2. cargo clippy --all-targets --all-features -- -D warnings
  3. cargo test

See fix.sh for the narrower auto-fix counterpart (cargo fmt only).
EOF
    exit 0
    ;;
esac

cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
