#!/usr/bin/env python3
"""Copy package-owned journey formulas into a Beads workspace."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

FORMULAS_DIR = Path(__file__).resolve().parents[1] / "formulas"


def formula_sources() -> tuple[Path, ...]:
    """Return the package-owned formula files in deterministic order."""
    sources = tuple(sorted(FORMULAS_DIR.glob("*.formula.toml")))
    if not sources:
        raise RuntimeError(f"no formula files found in {FORMULAS_DIR}")
    return sources


def install_formulas(repo_root: Path, *, force: bool = False) -> tuple[int, int]:
    """Install formulas, refusing divergent destinations unless forced."""
    root = repo_root.resolve()
    beads_dir = root / ".beads"
    if not beads_dir.is_dir() or beads_dir.is_symlink():
        raise RuntimeError(f"not a Beads workspace: {root}")

    destination_dir = beads_dir / "formulas"
    if destination_dir.is_symlink() or (
        destination_dir.exists() and not destination_dir.is_dir()
    ):
        raise RuntimeError(f"unsafe formula destination: {destination_dir}")

    sources = formula_sources()
    unchanged: set[Path] = set()
    unsafe: list[Path] = []
    conflicts: list[Path] = []
    for source in sources:
        destination = destination_dir / source.name
        if destination.is_symlink() or (
            destination.exists() and not destination.is_file()
        ):
            unsafe.append(destination)
        elif destination.is_file() and destination.read_bytes() == source.read_bytes():
            unchanged.add(source)
        elif destination.exists():
            conflicts.append(destination)

    if unsafe:
        paths = ", ".join(str(path) for path in unsafe)
        raise RuntimeError(f"unsafe formula destinations: {paths}")
    if conflicts and not force:
        paths = ", ".join(str(path) for path in conflicts)
        raise RuntimeError(f"refusing to overwrite divergent formula files: {paths}")

    destination_dir.mkdir(parents=True, exist_ok=True)
    copied = 0
    for source in sources:
        if source in unchanged:
            continue
        shutil.copy2(source, destination_dir / source.name, follow_symlinks=False)
        copied += 1
    return copied, len(unchanged)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo_root", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)

    try:
        copied, unchanged = install_formulas(args.repo_root, force=args.force)
    except (OSError, RuntimeError) as error:
        print(f"ERROR {error}", file=sys.stderr)
        return 2
    print(f"formulas: {copied} copied, {unchanged} unchanged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
