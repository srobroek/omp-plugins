#!/usr/bin/env bash
# Thin wrapper so the skill can say `scripts/lint.sh <file>` uniformly.
exec python3 "$(dirname "$0")/lint.py" "$@"
