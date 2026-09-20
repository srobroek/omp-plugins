#!/usr/bin/env python3
"""Warn when a commit message claims an AI agent as an author.

    attribution_guard.py <commit-msg-file>

The commit-msg entry point for the patterns vendored in `attribution_patterns.py`. That
module's own `main` reads a PreToolUse JSON payload and inspects the shell command, which
only ever fires for an agent whose harness is configured. A commit-msg hook fires for every
committer and survives an agent running without that config, which is the point of moving
it here.

Advisory, matching upstream: it prints and exits 0. The message is trivially fixable, and a
denied commit costs more than a nudge. The check that must hold is in CI, where the quality
workflow reads the whole pull request range.

Exit codes:
    0  always, including when a pattern matched
    2  usage error
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from attribution_patterns import ADVICE, COMPILED
except ImportError:  # pragma: no cover - the vendored module is shipped beside this one
    print("attribution_guard: attribution_patterns.py is missing", file=sys.stderr)
    raise SystemExit(0) from None


def findings(message: str) -> list[str]:
    """Every pattern label the message matches, deduplicated in declaration order."""
    found: list[str] = []
    for pattern, label in COMPILED:
        if pattern.search(message) and label not in found:
            found.append(label)
    return found


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2

    path = Path(argv[0])
    if not path.is_file():
        # A missing message file is git's problem rather than this hook's.
        return 0

    message = path.read_text(encoding="utf-8", errors="replace")

    # The comment block git appends carries branch names and a file list, which can mention
    # anything. Only the message a person wrote is checked.
    message = "\n".join(line for line in message.splitlines() if not line.lstrip().startswith("#"))

    matched = findings(message)
    if not matched:
        return 0

    print("attribution-guard: this commit message reads as AI attribution", file=sys.stderr)
    for label in matched:
        print(f"  {label}", file=sys.stderr)
    print(f"  {ADVICE}", file=sys.stderr)
    # Advisory. See the module docstring.
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
