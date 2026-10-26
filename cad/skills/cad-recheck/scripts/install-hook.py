#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Install the CAD recheck pre-commit hook in a hardware project."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def git(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, text=True, capture_output=True, check=False
    )
    if result.returncode:
        detail = result.stderr.strip() or f"git {' '.join(args)} failed ({result.returncode})"
        raise RuntimeError(detail)
    return result.stdout.rstrip("\n")


def install(project: Path, source: Path, stamp_source: Path) -> Path:
    root = Path(git("rev-parse", "--show-toplevel", cwd=project)).resolve()
    hooks_dir = root / ".githooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    hook = hooks_dir / "pre-commit"
    stamp = hooks_dir / "cad-recheck-stamp.py"
    for target in (hook, stamp):
        if target.exists() and not target.is_file():
            raise RuntimeError(f"cannot replace non-file path: {target}")
    if hook.exists() and hook.read_bytes() != source.read_bytes():
        raise RuntimeError(f"refusing to overwrite existing hook with different contents: {hook}")
    shutil.copyfile(source, hook)
    shutil.copyfile(stamp_source, stamp)
    hook.chmod(hook.stat().st_mode | 0o111)
    stamp.chmod(stamp.stat().st_mode | 0o111)
    git("config", "core.hooksPath", ".githooks", cwd=root)
    return hook


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd(), help="hardware project git repository")
    args = parser.parse_args()
    scripts = Path(__file__).resolve().parent
    try:
        hook = install(args.project.resolve(), scripts / "pre-commit", scripts / "stamp.py")
    except (OSError, RuntimeError) as error:
        print(f"cad-recheck install-hook: {error}", file=sys.stderr)
        return 2
    print(f"Installed {hook} and configured core.hooksPath=.githooks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
