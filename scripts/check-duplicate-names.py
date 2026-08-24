#!/usr/bin/env python3
"""Fail when two plugins contribute the same capability name.

OMP identifies a skill, agent, rule, command, or prompt by its bare `name` and
deduplicates across every configured source, keeping the first match. Two plugins
shipping one name therefore shadow each other silently. `omp plugin doctor`
inspects a single installed plugin, so it cannot see a collision inside this
repository. This script does.
"""

from __future__ import annotations

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
}

FRONTMATTER_NAME = re.compile(r"^name:\s*(\S+)\s*$", re.MULTILINE)


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


def plugin_roots() -> list[Path]:
    """Every top-level directory that carries at least one capability directory."""
    roots = []
    for entry in sorted(REPO.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if entry.name in {"scripts", "examples"}:
            continue
        if any((entry / cap.split("/")[0]).is_dir() for cap, _ in CAPABILITIES.values()):
            roots.append(entry)
    return roots


def collect() -> dict[tuple[str, str], list[str]]:
    """Map (capability, name) to the plugin-relative paths that declare it."""
    seen: dict[tuple[str, str], list[str]] = defaultdict(list)
    for root in plugin_roots():
        for capability, (pattern, how) in CAPABILITIES.items():
            for path in sorted(root.glob(pattern)):
                if how == "parent-dir":
                    name = path.parent.name
                elif how == "stem":
                    name = path.stem
                else:
                    name = frontmatter_name(path) or path.stem
                seen[(capability, name)].append(str(path.relative_to(REPO)))
    return seen


def main() -> int:
    roots = plugin_roots()
    if not roots:
        print("no plugin directories found; nothing to check")
        return 0

    collisions = {key: paths for key, paths in collect().items() if len(paths) > 1}
    for (capability, name), paths in sorted(collisions.items()):
        print(f"collision: {capability} '{name}' declared {len(paths)} times")
        for path in paths:
            print(f"  {path}")

    total = sum(len(paths) for paths in collect().values())
    print(f"checked {total} capability names across {len(roots)} plugin(s)")
    if collisions:
        print(f"FAIL: {len(collisions)} colliding name(s)")
        return 1
    print("PASS: every capability name is unique")
    return 0


if __name__ == "__main__":
    sys.exit(main())
