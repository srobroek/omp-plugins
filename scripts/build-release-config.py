#!/usr/bin/env python3
"""Generate `release-please-config.json` and its manifest from the plugin manifests.

release-please only bumps files it is pointed at directly, and this repository has
one entry per plugin, so the config is derived rather than hand-maintained. Run it
whenever a plugin is added or removed; CI checks the result is current.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CONFIG = REPO / "release-please-config.json"
MANIFEST = REPO / ".release-please-manifest.json"

# Grouped releases: one release PR across all plugins. Separate PRs would mean up
# to 31 open PRs per cycle. Tags read `<component>--v<version>`.
BASE = {
    "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
    "separate-pull-requests": False,
    "tag-separator": "--",
    "include-component-in-tag": True,
    "changelog-sections": [
        {"type": "feat", "section": "Features"},
        {"type": "fix", "section": "Bug Fixes"},
        {"type": "perf", "section": "Performance"},
        {"type": "refactor", "section": "Refactors"},
        {"type": "docs", "section": "Documentation"},
        {"type": "chore", "section": "Chores", "hidden": True},
        {"type": "test", "section": "Tests", "hidden": True},
        {"type": "ci", "section": "CI/CD", "hidden": True},
    ],
}


def plugin_versions() -> dict[str, str]:
    versions = {}
    for path in sorted(REPO.glob("*/.omp-plugin/plugin.json")):
        manifest = json.loads(path.read_text(encoding="utf-8"))
        versions[manifest["name"]] = manifest["version"]
    return versions


def build() -> tuple[str, str]:
    versions = plugin_versions()
    packages = {
        # `simple` is the release type for a markdown directory with no build step.
        name: {
            "release-type": "simple",
            "component": name,
            "changelog-path": "CHANGELOG.md",
            # The version lives in the plugin manifest; `scripts/build-catalog.py`
            # then aggregates all of them into the catalog OMP actually reads.
            #
            # `extra-files` paths are resolved relative to the PACKAGE directory, not
            # the repository root. A repo-root-relative path here silently doubles the
            # prefix (`safety/safety/.omp-plugin/plugin.json`) and the bump lands in a
            # file that does not exist.
            "extra-files": [{"type": "json", "path": ".omp-plugin/plugin.json", "jsonpath": "$.version"}],
        }
        for name in versions
    }
    config = json.dumps({**BASE, "packages": packages}, indent=2) + "\n"
    manifest = json.dumps({name: version for name, version in versions.items()}, indent=2) + "\n"
    return config, manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail when the generated files are stale")
    args = parser.parse_args()

    config, manifest = build()

    if args.check:
        stale = [
            str(path.relative_to(REPO))
            for path, expected in ((CONFIG, config), (MANIFEST, manifest))
            if not path.exists() or path.read_text(encoding="utf-8") != expected
        ]
        if stale:
            print("FAIL: release-please files are stale:", ", ".join(stale), file=sys.stderr)
            print("Run: python3 scripts/build-release-config.py", file=sys.stderr)
            return 1
        print(f"PASS: release-please config covers {len(plugin_versions())} plugin(s)")
        return 0

    CONFIG.write_text(config, encoding="utf-8")
    MANIFEST.write_text(manifest, encoding="utf-8")
    print(f"wrote release-please config for {len(plugin_versions())} plugin(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
