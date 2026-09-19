#!/usr/bin/env python3
"""Fail when two plugins contribute the same capability name.

OMP identifies a skill, agent, rule, command, or prompt by its bare `name` and
deduplicates across every configured source, keeping the first match. Two plugins
shipping one name therefore shadow each other silently. `omp plugin doctor`
inspects a single installed plugin, so it cannot see a collision inside this
repository. This script does.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# capability -> (glob relative to a plugin root, how the name is derived)
CAPABILITIES = {
    "skill": ("skills/*/SKILL.md", "parent-dir"),
    "agent": ("agents/*.md", "frontmatter-or-stem"),
    "command": ("commands/*.md", "stem"),
    "rule": ("rules/*.md", "frontmatter-or-stem"),
    "prompt": ("prompts/*.md", "stem"),
    "tools": ("src/tools/*.ts", "tool-name"),
    "formulas": (".beads/formulas/*.toml", "stem"),
}

FRONTMATTER_NAME = re.compile(r"^name:\s*(\S+)\s*$", re.MULTILINE)
TOOL_NAME = re.compile(r'name:\s*"([a-z_]+)"')


def plugin_roots(root: Path = REPO) -> list[Path]:
    """Return plugin roots below *root*, including *root* when it is a plugin."""
    root = root.resolve()
    capability_dirs = {"skills", "agents", "commands", "rules", "prompts", "src/tools", ".beads/formulas"}
    if any((root / directory).is_dir() for directory in capability_dirs):
        return [root]

    roots = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if entry.name in {"scripts", "examples"}:
            continue
        if any((entry / directory).is_dir() for directory in capability_dirs):
            roots.append(entry)
    return roots


def collect(roots: list[Path], relative_to: Path = REPO) -> dict[tuple[str, str], list[str]]:
    """Map (capability, name) to the paths that declare it."""
    seen: dict[tuple[str, str], list[str]] = defaultdict(list)
    relative_to = relative_to.resolve()
    for root in roots:
        for capability, (pattern, how) in CAPABILITIES.items():
            for path in sorted(root.glob(pattern)):
                if how == "parent-dir":
                    name = path.parent.name
                elif how == "stem":
                    name = path.stem
                elif how == "tool-name":
                    match = TOOL_NAME.search(path.read_text(encoding="utf-8", errors="replace"))
                    if not match:
                        continue
                    name = match.group(1)
                else:
                    name = frontmatter_name(path) or path.stem
                try:
                    display_path = str(path.relative_to(relative_to))
                except ValueError:
                    display_path = str(path.relative_to(root))
                seen[(capability, name)].append(display_path)
    return seen


def frontmatter_name(path: Path) -> str | None:
    """Return the `name` field when the file opens with a frontmatter block."""
    text = path.read_text(encoding="utf-8", errors="replace")
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    match = FRONTMATTER_NAME.search(text[3:end])
    return match.group(1) if match else None




def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, action="append", help="plugin tree or direct plugin root (repeatable)"
    )
    args = parser.parse_args(argv)
    scan_roots = args.root or [REPO]
    seen: dict[tuple[str, str], list[str]] = defaultdict(list)
    roots: list[Path] = []
    for scan_root in scan_roots:
        found = plugin_roots(scan_root)
        roots.extend(found)
        for key, paths in collect(found, scan_root).items():
            seen[key].extend(paths)

    if not roots:
        print("no plugin directories found; nothing to check")
        return 0

    collisions = {key: paths for key, paths in seen.items() if len(paths) > 1}
    for (capability, name), paths in sorted(collisions.items()):
        print(f"collision: {capability} '{name}' declared {len(paths)} times")
        for path in paths:
            print(f"  {path}")

    total = sum(len(paths) for paths in seen.values())
    print(f"checked {total} capability names across {len(roots)} plugin(s)")
    if collisions:
        print(f"FAIL: {len(collisions)} colliding name(s)")
        return 1
    print("PASS: every capability name is unique")
    return 0


if __name__ == "__main__":
    sys.exit(main())
