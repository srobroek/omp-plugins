#!/usr/bin/env python3
"""Fail when a file duplicated across plugins drifts between its copies.

Plugins bundle in isolation: `build-extensions.py` copies one plugin's tree and
resolves imports inside it, so a module cannot be imported across a plugin boundary
and there is no package mechanism in this repository to share one. Genuinely shared
code is therefore duplicated, and duplication without a check is how two copies of a
parser end up disagreeing about the same input.

Copies are compared byte for byte. A formatting-only difference is still a drift:
the point of the contract is that one edit lands in every copy, and a diff nobody
intended is exactly the signal that it did not.

Every copy must be a real file. A symlink reads back the canonical bytes, so a byte
comparison alone would accept a tree that had replaced a copy with a link across the
plugin boundary -- which is the shape this contract exists to reject.

Add a set by appending to DUPLICATED, whose members are repository-relative paths
that must all be identical.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Each tuple is one set of copies that must be identical.
DUPLICATED: tuple[tuple[str, ...], ...] = (
    (
        "dep-update/extensions/detect.ts",
        "whats-new/extensions/detect.ts",
    ),
)


def main() -> int:
    failures: list[str] = []

    for group in DUPLICATED:
        missing = [name for name in group if not (ROOT / name).is_file()]
        if missing:
            failures.append(
                f"{group[0]}: copy set is incomplete, missing {', '.join(missing)}"
            )
            continue

        # is_file() follows symlinks, and a symlink to the canonical copy reads back
        # identical bytes -- so a byte comparison alone would pass a tree that had
        # quietly replaced a copy with a link across the plugin boundary. That is the
        # shape this contract exists to reject: it makes one plugin depend on another's
        # internals undeclared, and it does not survive Windows or archive extraction.
        links = [name for name in group if (ROOT / name).is_symlink()]
        if links:
            failures.append(
                f"{', '.join(links)}: symlinked instead of copied\n"
                f"    each plugin bundles in isolation, so every copy must be a real file"
            )
            continue

        canonical, *others = group
        expected = (ROOT / canonical).read_bytes()
        for name in others:
            actual = (ROOT / name).read_bytes()
            if actual == expected:
                continue
            failures.append(
                f"{name} has drifted from {canonical}\n"
                f"    to see the difference: diff {canonical} {name}\n"
                f"    to resolve it, decide which copy is right, then:"
                f" cp <right> <wrong>"
            )

    if failures:
        print("FAIL duplicated files have drifted\n")
        for failure in failures:
            print(f"  {failure}")
        print(
            "\nThese files are duplicated because each plugin bundles in isolation."
            "\nAn edit to one has to land in all of them."
        )
        return 1

    total = sum(len(group) for group in DUPLICATED)
    print(f"PASS {total} copies across {len(DUPLICATED)} set(s) are identical")
    return 0


if __name__ == "__main__":
    sys.exit(main())
