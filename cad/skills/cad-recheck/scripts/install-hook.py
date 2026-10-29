#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Install the CAD recheck pre-commit hook in a hardware project."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
import os


def git(*args: str, cwd: Path) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=False)
    if result.returncode:
        detail = result.stderr.strip() or f"git {' '.join(args)} failed ({result.returncode})"
        raise RuntimeError(detail)
    return result.stdout.rstrip("\n")


def configured_hooks_paths(root: Path) -> list[Path]:
    result = subprocess.run(["git", "config", "--get-all", "core.hooksPath"], cwd=root,
                            text=True, capture_output=True, check=False)
    if result.returncode == 1:
        return []
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "cannot read core.hooksPath")
    return [(Path(value) if Path(value).is_absolute() else root / value).resolve()
            for value in result.stdout.splitlines()]


def existing_hooks(hooks_dir: Path) -> list[Path]:
    if not hooks_dir.is_dir():
        return []
    return [entry for entry in hooks_dir.iterdir() if not entry.name.endswith(".sample")]


def install(project: Path, source: Path, stamp_source: Path, *, force: bool = False) -> Path:
    root = Path(git("rev-parse", "--show-toplevel", cwd=project)).resolve()
    hooks_dir = root / ".githooks"
    if not force and any(path != hooks_dir.resolve() for path in configured_hooks_paths(root)):
        configured = ", ".join(str(path) for path in configured_hooks_paths(root))
        raise RuntimeError(f"core.hooksPath is set elsewhere ({configured}); refusing to replace it. "
                           "Integrate the CAD hook with existing hooks, or pass --force.")
    git_hooks = Path(git("rev-parse", "--git-path", "hooks", cwd=root))
    if not git_hooks.is_absolute():
        git_hooks = root / git_hooks
    occupied = existing_hooks(git_hooks.resolve())
    if not force and occupied:
        raise RuntimeError(f"existing non-sample hooks found in {git_hooks}: {', '.join(map(str, occupied))}; "
                           "refusing to disable them. Integrate the CAD hook with existing hooks, or pass --force.")
    hooks_dir.mkdir(parents=True, exist_ok=True)
    hook, stamp = hooks_dir / "pre-commit", hooks_dir / "cad-recheck-stamp.py"
    for target in (hook, stamp):
        if target.exists() and not target.is_file():
            raise RuntimeError(f"cannot replace non-file path: {target}")
    if not force and hook.exists() and hook.read_bytes() != source.read_bytes():
        raise RuntimeError(f"refusing to overwrite existing hook with different contents: {hook}")
    shutil.copyfile(source, hook)
    shutil.copyfile(stamp_source, stamp)
    record_root = source.parents[2] / "cad-record"
    motion_scripts = source.parents[2] / "cad-motion" / "scripts"
    hook_motion = hooks_dir / "cad-motion" / "scripts"
    hook_motion.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(motion_scripts / "coupling.py", hook_motion / "coupling.py")
    hook_layout = hooks_dir / "cad-record"
    (hook_layout / "scripts").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(record_root / "scripts" / "layout.py", hook_layout / "scripts" / "layout.py")
    shutil.copyfile(record_root / "layout.json", hook_layout / "layout.json")
    shutil.copyfile(stamp_source, stamp)
    stamp_text = stamp.read_text(encoding="utf-8").replace(
        'CAD_RECORD_SCRIPTS = Path(__file__).resolve().parents[2] / "cad-record" / "scripts"',
        'CAD_RECORD_SCRIPTS = Path(__file__).resolve().parent / "cad-record" / "scripts"')
    stamp.write_text(stamp_text, encoding="utf-8")
    for target in (hook, stamp, hook_layout / "scripts" / "layout.py"):
        target.chmod(target.stat().st_mode | 0o111)
    git("config", "core.hooksPath", ".githooks", cwd=root)
    return hook


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd(), help="hardware project git repository")
    parser.add_argument("--force", action="store_true", help="replace hooksPath and ignore existing git hooks")
    args = parser.parse_args()
    scripts = Path(__file__).resolve().parent
    try:
        hook = install(args.project.resolve(), scripts / "pre-commit", scripts / "stamp.py", force=args.force)
    except (OSError, RuntimeError) as error:
        print(f"cad-recheck install-hook: {error}", file=sys.stderr)
        return 2
    print(f"Installed {hook} and configured core.hooksPath=.githooks")
    print("Commit .githooks/ so the hook and its stamp tool are available in other checkouts.")
    if args.force:
        print("--force may disable hooks that were configured previously.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())