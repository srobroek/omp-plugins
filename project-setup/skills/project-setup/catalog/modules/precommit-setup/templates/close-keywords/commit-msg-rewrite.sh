#!/usr/bin/env bash
set -euo pipefail

# commit-msg-rewrite.sh — pre-commit `commit-msg` stage entrypoint.
#
# pre-commit passes the path to the commit message file as $1. We run it through
# the shared normalizer and rewrite IN PLACE so a comma-list close
# (`Closes #1, #2`) becomes `Closes #1, closes #2` before the commit is created.
# This is the tool-agnostic, true auto-rewrite layer (fires for any committer who
# has the pre-commit framework installed).
#
# Always exits 0 — rewriting the message is not a failure; we never block the
# commit. Idempotent (the normalizer is).
#
# Portability floor: bash 3.2.57 + BSD userland.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NORMALIZE="${SCRIPT_DIR}/normalize-closes.sh"

msg_file="${1:-}"
[ -n "$msg_file" ] && [ -f "$msg_file" ] || exit 0
[ -x "$NORMALIZE" ] || exit 0

original="$(cat "$msg_file")"
fixed="$(printf '%s' "$original" | "$NORMALIZE" 2>/dev/null || true)"

# Only rewrite when something actually changed, and never clobber the file with
# empty output (a normalizer failure).
if [ -n "$fixed" ] && [ "$fixed" != "$original" ]; then
  printf '%s\n' "$fixed" > "$msg_file"
  printf 'close-keywords: distributed the close keyword across the issue list so every issue closes.\n' >&2
fi

exit 0
