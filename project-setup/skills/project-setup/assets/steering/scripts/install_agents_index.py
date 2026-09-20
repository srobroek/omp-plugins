#!/usr/bin/env python3
"""Install AGENTS.md from the rendered body, and point CLAUDE.md at it.

    install_agents_index.py <dest> [--claude MERGE|OVERWRITE|SKIP]

`docs/agents/AGENTS.body.md` is the body this layer owns. AGENTS.md is a copy of it
rather than a symlink, because `agentic/beads` appends a marked block to AGENTS.md and
a symlink would write that block back into the body.

CLAUDE.md is a relative symlink to AGENTS.md, so one file serves both harnesses.
A relative target keeps the link valid inside a linked worktree and after a clone.

Idempotent, and non-destructive: an AGENTS.md that already carries the body is left
alone, so a beads block appended after the first render survives.

A CLAUDE.md whose content AGENTS.md does not already carry is hand-owned project
instruction, and a symlink pointing anywhere else is another tool's wiring. Replacing
either would lose it, so this returns `conflict` until the plan states the class for
that destination:

    MERGE       append the existing text to AGENTS.md, then link CLAUDE.md
    OVERWRITE   drop the existing text and link CLAUDE.md; the plan states the loss
    SKIP        leave CLAUDE.md exactly as it is, and install only AGENTS.md

A CLAUDE.md that is bd's own copy of AGENTS.md needs no decision: AGENTS.md carries
every line of it, so the link loses nothing.
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "## Read for"
CLASSES = ("MERGE", "OVERWRITE", "SKIP")


def parse_args(argv: list[str]) -> tuple[Path, str | None]:
    dest: Path | None = None
    decision: str | None = None
    rest = list(argv)
    while rest:
        argument = rest.pop(0)
        if argument == "--claude":
            if not rest:
                raise SystemExit("--claude needs one of MERGE, OVERWRITE, SKIP")
            decision = rest.pop(0).upper()
        elif argument.startswith("--claude="):
            decision = argument.split("=", 1)[1].upper()
        elif argument.startswith("-"):
            raise SystemExit(f"unknown option {argument}")
        elif dest is None:
            dest = Path(argument)
        else:
            raise SystemExit(f"unexpected argument {argument}")
    if dest is None:
        raise SystemExit(__doc__)
    if decision is not None and decision not in CLASSES:
        raise SystemExit(f"--claude takes one of {', '.join(CLASSES)}, not {decision}")
    return dest, decision


def existing_text(link: Path) -> str:
    """What a reader loses if this path is replaced. A dangling link holds nothing."""
    try:
        return link.read_text()
    except OSError:
        return ""


def install_link(index: Path, link: Path, decision: str | None) -> None:
    if link.is_symlink() and link.readlink() == Path("AGENTS.md"):
        print("CLAUDE.md -> AGENTS.md")
        return

    if not link.is_symlink() and not link.exists():
        link.symlink_to("AGENTS.md")
        print("CLAUDE.md -> AGENTS.md")
        return

    text = existing_text(link)
    if link.is_symlink():
        # Another tool's wiring rather than content this layer owns: the target is the
        # state, so repointing it is a change even when AGENTS.md holds the same bytes.
        carried = False
        reason = f"CLAUDE.md is a symlink to {link.readlink()}, which this layer does not own"
    else:
        carried = bool(text.strip()) and text.strip() in index.read_text()
        reason = "CLAUDE.md holds content AGENTS.md does not carry"

    if decision == "SKIP":
        print("CLAUDE.md left as it is; AGENTS.md is installed beside it")
        return

    if decision is None and not carried:
        raise SystemExit(
            f"conflict: {reason}; rerun with --claude MERGE, --claude OVERWRITE, or --claude SKIP"
        )

    if decision == "MERGE" and not carried and text.strip():
        index_text = index.read_text()
        separator = "" if index_text.endswith("\n") else "\n"
        index.write_text(index_text + separator + "\n" + text.strip() + "\n")
        print("merged CLAUDE.md into AGENTS.md")

    link.unlink()
    link.symlink_to("AGENTS.md")
    print("CLAUDE.md -> AGENTS.md")


def main() -> int:
    dest, decision = parse_args(sys.argv[1:])

    body = dest / "docs" / "agents" / "AGENTS.body.md"
    if not body.is_file():
        print("docs/agents: no AGENTS.body.md, nothing to install", file=sys.stderr)
        return 3

    index = dest / "AGENTS.md"
    if index.is_file() and MARKER in index.read_text():
        print("AGENTS.md already carries the body, leaving it alone")
    else:
        # A pre-existing AGENTS.md without the body is bd's own, or another tool's.
        # The body goes first so it is what a reader sees, and any marked block that
        # follows is preserved.
        existing = index.read_text() if index.is_file() else ""
        index.write_text(body.read_text() + ("\n" + existing if existing.strip() else ""))
        print("wrote AGENTS.md from docs/agents/AGENTS.body.md")

    install_link(index, dest / "CLAUDE.md", decision)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
