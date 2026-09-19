#!/usr/bin/env python3
"""Deliberately promote one managed OMP asset into this repository.

The managed-skills store is machine-local, has no remote, and is read-only here.
This command never removes or edits that source. It previews by default; use
--apply for an explicit adoption and --update for an explicit replacement.
"""

from __future__ import annotations

import argparse
import difflib
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MANAGED = Path.home() / ".omp" / "agent" / "managed-skills"


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Promote a managed skill or rule into this repository. Dry-run is "
            "the default. Reads ~/.omp/agent/managed-skills only; never edits "
            "or deletes that machine-local source."
        )
    )
    p.add_argument("name", nargs="?", help="managed asset name; omit to list promotion candidates")
    p.add_argument("--plugin", help="destination plugin directory (chosen by the maintainer)")
    p.add_argument("--kind", choices=("skill", "rule"), default="skill")
    p.add_argument("--topic", help="rule topic used after the plugin prefix")
    p.add_argument("--apply", action="store_true", help="adopt the previewed files")
    p.add_argument("--update", action="store_true", help="explicitly replace an existing destination")
    return p


def files_in_repo(name: str) -> list[Path]:
    found: list[Path] = []
    for path in REPO.glob("*/skills/*/SKILL.md"):
        if path.parent.name == name:
            found.append(path)
    for path in REPO.glob("*/rules/*.md"):
        if path.stem == name:
            found.append(path)
    return sorted(found)


def list_candidates() -> int:
    if not MANAGED.is_dir():
        print(f"managed source not found: {MANAGED}", file=sys.stderr)
        return 2
    skills = sorted(p for p in MANAGED.iterdir() if p.is_dir() and (p / "SKILL.md").is_file())
    if not skills:
        print("No managed skills found.")
        return 0
    for directory in skills:
        name = directory.name
        existing = files_in_repo(name)
        state = "already exists: " + ", ".join(str(p.relative_to(REPO)) for p in existing) if existing else "unpromoted"
        print(f"{name}\t{state}")
    return 0


def source_for(name: str, kind: str) -> Path:
    if kind == "skill":
        return MANAGED / name / "SKILL.md"
    candidates = (
        MANAGED / f"{name}.md",
        MANAGED / "rules" / f"{name}.md",
        MANAGED / name / "RULE.md",
        MANAGED / name / "SKILL.md",
    )
    for path in candidates:
        if path.is_file():
            return path
    return candidates[0]


def unified_diff(destination: Path, source: Path) -> str:
    old = destination.read_text(encoding="utf-8").splitlines(keepends=True)
    new = source.read_text(encoding="utf-8").splitlines(keepends=True)
    return "".join(difflib.unified_diff(old, new, fromfile=str(destination), tofile=str(source)))


def main() -> int:
    args = parser().parse_args()
    if args.name is None:
        return list_candidates()
    if not args.plugin:
        print("error: --plugin is required when promoting an asset", file=sys.stderr)
        return 2
    if args.update and not args.apply:
        print("error: --update requires --apply; preview the diff first", file=sys.stderr)
        return 2
    source = source_for(args.name, args.kind)
    if not source.is_file():
        print(f"error: managed {args.kind} not found: {source}", file=sys.stderr)
        return 2

    if args.kind == "skill":
        destination = REPO / args.plugin / "skills" / args.name / "SKILL.md"
        source_root = source.parent
    else:
        topic = args.topic or args.name
        destination = REPO / args.plugin / "rules" / f"{args.plugin}-{topic}.md"
        source_root = source
        if source.stem != destination.stem:
            print(f"Rule rename: {source.name} -> {destination.name}")

    if destination.exists():
        diff = unified_diff(destination, source if args.kind == "rule" else source)
        print(f"Destination exists: {destination.relative_to(REPO)}")
        print(diff or "(no content differences)\n")
        if not args.update:
            print("Refusing to overwrite. Re-run with --apply --update after reviewing the diff.")
            return 1
    else:
        print(f"Would write: {destination.relative_to(REPO)}")
        if args.kind == "skill":
            for path in sorted(source_root.rglob("*")):
                if path.is_file():
                    print(f"Would copy: {path.relative_to(MANAGED)}")
        else:
            print(f"Would copy unchanged: {source.relative_to(MANAGED)}")

    print(f"Maintainer action: choose plugin '{args.plugin}' and commit with scope 'feat({args.plugin}):'.")
    print("Maintainer action: open the pull request; this script does not choose, commit, release, or publish.")
    if not args.apply:
        return 0

    if args.kind == "skill":
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_root, destination.parent, dirs_exist_ok=True)
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    print(f"Adopted: {destination.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
