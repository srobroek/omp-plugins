#!/usr/bin/env python3
"""Assemble `.omp-plugin/marketplace.json` from the per-plugin manifests.

OMP compares `plugins[].version` in the single top-level catalog when deciding
whether a plugin can be upgraded; an entry with no `version` is invisible to that
comparer. release-please, however, only bumps files it is pointed at directly, so
each plugin owns its version in `<plugin>/.omp-plugin/plugin.json` and this script
aggregates the 31 of them into the one file OMP reads.

`--check` verifies the committed catalogs match what this would produce, which is
what CI runs: it catches a hand-edited catalog drifting from the manifests.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CATALOGS = (
    REPO / ".omp-plugin" / "marketplace.json",
    # Same bytes, so Claude Code reads the same catalog. OMP prefers `.omp-plugin/`.
    REPO / ".claude-plugin" / "marketplace.json",
)

HEADER = {
    "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
    "name": "srobroek-omp",
    "owner": {"name": "Sjors Robroek"},
    "metadata": {
        "description": "Language, topic, and workflow plugins for oh-my-pi.",
    },
}


def manifests() -> list[dict[str, object]]:
    """Every plugin manifest in the repository, in catalog order."""
    found = []
    for path in sorted(REPO.glob("*/.omp-plugin/plugin.json")):
        found.append(json.loads(path.read_text(encoding="utf-8")))
    return found


def build() -> dict[str, object]:
    plugins = []
    for manifest in manifests():
        if manifest.get("publish") is False:
            continue
        entry = {
            "name": manifest["name"],
            "description": manifest["description"],
            "source": f"./{manifest['name']}",
            "version": manifest["version"],
        }
        if "category" in manifest:
            entry["category"] = manifest["category"]
        plugins.append(entry)
    return {**HEADER, "plugins": plugins}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail when a catalog is stale")
    args = parser.parse_args()

    expected = json.dumps(build(), indent=2) + "\n"

    if args.check:
        stale = [
            str(path.relative_to(REPO))
            for path in CATALOGS
            if not path.exists() or path.read_text(encoding="utf-8") != expected
        ]
        if stale:
            print("FAIL: catalog does not match the plugin manifests:", ", ".join(stale), file=sys.stderr)
            print("Run: python3 scripts/build-catalog.py", file=sys.stderr)
            return 1
        print(f"PASS: catalogs match {len(build()['plugins'])} plugin manifest(s)")
        return 0

    for path in CATALOGS:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(expected, encoding="utf-8")
    print(f"wrote {len(CATALOGS)} catalog(s) with {len(build()['plugins'])} plugin entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
