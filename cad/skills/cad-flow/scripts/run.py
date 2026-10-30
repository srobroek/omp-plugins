#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Launch any CAD PEP 723 script in uv's environment shared by its dependencies.

Usage: uv run --script skill://cad-flow/scripts/run.py <skill>/scripts/<script.py> [args...]

The target path is relative to cad/skills/. `cadmodel.scriptenv` reads the target's
PEP 723 header and starts it with `--with-requirements`, which keys uv's cache by
the dependency set and interpreter rather than the target file's path.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

SKILLS = Path(__file__).resolve().parents[2]
MODEL_SCRIPTS = SKILLS / "cad-model" / "scripts"
sys.path.insert(0, str(MODEL_SCRIPTS))
from cadmodel import scriptenv  # noqa: E402 - standard-library-only helper


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args:
        print(__doc__.splitlines()[2], file=sys.stderr)
        return 2

    target = Path(args[0])
    if not target.is_absolute():
        target = SKILLS / target
    target = target.resolve()
    try:
        target.relative_to(SKILLS)
    except ValueError:
        print(f"run.py: target must be under {SKILLS}: {target}", file=sys.stderr)
        return 2
    if not target.is_file():
        print(f"run.py: target script not found: {target}", file=sys.stderr)
        return 2

    command = scriptenv.script_command(target, *args[1:])
    try:
        os.execvp(command[0], command)
    except OSError as error:
        print(f"run.py: could not start {command[0]}: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
