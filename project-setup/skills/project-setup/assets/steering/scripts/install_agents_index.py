#!/usr/bin/env python3
"""Install AGENTS.md from the rendered body, and point CLAUDE.md at it.

    install_agents_index.py <dest> [--claude MERGE|OVERWRITE|SKIP] [--agents MERGE|OVERWRITE|SKIP]

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

An AGENTS.md that is already a symlink is another tool's wiring. Writing through it
would mutate the target rather than a regular file in the destination root. That
destination needs its own class, passed as `--agents`, never assumed:

    MERGE       replace the symlink with a regular file holding the body, then
                the previous target text
    OVERWRITE   replace the symlink with a regular file holding only the body
    SKIP        leave the symlink exactly as it is, and install only CLAUDE.md
"""

from __future__ import annotations

import sys
from pathlib import Path

MARKER = "## Read for"
CLASSES = ("MERGE", "OVERWRITE", "SKIP")


def parse_args(argv: list[str]) -> tuple[Path, str | None, str | None]:
    dest: Path | None = None
    claude: str | None = None
    agents: str | None = None
    rest = list(argv)
    while rest:
        argument = rest.pop(0)
        if argument == "--claude":
            if not rest:
                raise SystemExit("--claude needs one of MERGE, OVERWRITE, SKIP")
            claude = rest.pop(0).upper()
        elif argument.startswith("--claude="):
            claude = argument.split("=", 1)[1].upper()
        elif argument == "--agents":
            if not rest:
                raise SystemExit("--agents needs one of MERGE, OVERWRITE, SKIP")
            agents = rest.pop(0).upper()
        elif argument.startswith("--agents="):
            agents = argument.split("=", 1)[1].upper()
        elif argument.startswith("-"):
            raise SystemExit(f"unknown option {argument}")
        elif dest is None:
            dest = Path(argument)
        else:
            raise SystemExit(f"unexpected argument {argument}")
    if dest is None:
        raise SystemExit(__doc__)
    if claude is not None and claude not in CLASSES:
        raise SystemExit(f"--claude takes one of {', '.join(CLASSES)}, not {claude}")
    if agents is not None and agents not in CLASSES:
        raise SystemExit(f"--agents takes one of {', '.join(CLASSES)}, not {agents}")
    return dest, claude, agents


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
        if index.is_symlink():
            raise SystemExit(
                "conflict: AGENTS.md is still a symlink; cannot merge CLAUDE.md through it"
            )
        index_text = index.read_text()
        separator = "" if index_text.endswith("\n") else "\n"
        index.write_text(index_text + separator + "\n" + text.strip() + "\n")
        print("merged CLAUDE.md into AGENTS.md")


    link.unlink()
    link.symlink_to("AGENTS.md")
    print("CLAUDE.md -> AGENTS.md")


def install_index(index: Path, body: Path, decision: str | None) -> None:
    if index.is_symlink():
        reason = (
            f"AGENTS.md is a symlink to {index.readlink()}, which this layer does not own"
        )
        if decision is None:
            raise SystemExit(
                f"conflict: {reason}; rerun with --agents MERGE, --agents OVERWRITE, or --agents SKIP"
            )
        if decision == "SKIP":
            print("AGENTS.md left as it is")
            return
        existing = existing_text(index) if decision == "MERGE" else ""
        index.unlink()
        payload = body.read_text()
        if decision == "MERGE" and existing.strip():
            separator = "" if payload.endswith("\n") else "\n"
            payload = payload + separator + "\n" + existing.strip() + "\n"
            print("replaced AGENTS.md symlink; merged previous target into the new file")
        else:
            print("replaced AGENTS.md symlink with docs/agents/AGENTS.body.md")
        index.write_text(payload)
        return

    if index.is_file() and MARKER in index.read_text():
        print("AGENTS.md already carries the body, leaving it alone")
        return

    existing = index.read_text() if index.is_file() else ""
    index.write_text(body.read_text() + ("\n" + existing if existing.strip() else ""))
    print("wrote AGENTS.md from docs/agents/AGENTS.body.md")


def main() -> int:
    dest, claude, agents = parse_args(sys.argv[1:])

    body = dest / "docs" / "agents" / "AGENTS.body.md"
    if not body.is_file():
        print("docs/agents: no AGENTS.body.md, nothing to install", file=sys.stderr)
        return 3

    index = dest / "AGENTS.md"
    install_index(index, body, agents)
    install_link(index, dest / "CLAUDE.md", claude)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
