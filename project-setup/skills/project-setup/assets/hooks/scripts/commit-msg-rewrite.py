#!/usr/bin/env python3
# VENDORED from srobroek/agentic-packages, packages/hooks-close-keywords/scripts/commit-msg-rewrite.py.
#
# Vendored rather than referenced because a prek `entry:` has to resolve inside this
# repository. An installed package does not: it may live anywhere on the machine, or
# nowhere. The package's own templates/pre-commit-commit-msg.yaml names project-setup as
# the consumer that does this.
#
# NO CHECKER ENFORCES THIS COPY. Both repositories have twin-script checks and neither
# reaches across a repository boundary, so drift here is silent. Re-sync with:
#
#     cp <agentic-packages>/packages/hooks-close-keywords/scripts/commit-msg-rewrite.py \
#        templates/quality/hooks/template/scripts/commit-msg-rewrite.py
#
# Fix behaviour upstream and re-copy; editing here is reverted by the next sync.
"""Rewrite a commit message so every issue in a close list actually closes.

The pre-commit `commit-msg` stage passes the message file as the first argument.
This rewrites it in place, which makes it the tool-agnostic layer: it fires for
any committer who has the pre-commit framework installed, not only for an agent
running the PreToolUse guard.

Always exits 0. Rewriting a message is not a failure, and a blocked commit costs
more than an unfixed close list.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from close_keywords import normalize
except Exception:  # noqa: BLE001
    # A module-scope import failure is OUTSIDE the wrapper at the bottom of this
    # file, so an absent or unreadable engine exited 1 and pre-commit rejected the
    # commit -- for everyone with the hook installed, not just the author. The
    # documented vendoring path makes that likely rather than exotic: the template
    # names only this script in `entry:` and mentions close_keywords.py in prose,
    # so copying just the entrypoint bricks committing. The shell predecessor
    # degraded to a silent skip here, and so must this.
    sys.exit(0)

NOTICE = (
    "close-keywords: distributed the close keyword across the issue list so every issue closes."
)


def main(argv: list[str]) -> int:
    if not argv:
        return 0
    path = Path(argv[0])
    if not path.is_file():
        return 0

    # newline="" on both sides disables universal-newline translation. Without it,
    # reading turned every CRLF into LF and writing them back rewrote the line
    # endings of the WHOLE message -- including lines the rewrite never touched --
    # whenever a close list happened to need fixing.
    with path.open("r", encoding="utf-8", errors="surrogateescape", newline="") as handle:
        original = handle.read()

    fixed = normalize(original)
    if fixed == original:
        return 0

    with path.open("w", encoding="utf-8", errors="surrogateescape", newline="") as handle:
        handle.write(fixed)
    print(NOTICE, file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except BaseException:
        # Fail open: never block a commit over a message rewrite.
        raise SystemExit(0)
