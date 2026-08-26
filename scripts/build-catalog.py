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
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CATALOGS = (
    REPO / ".omp-plugin" / "marketplace.json",
    # Same bytes, so Claude Code reads the same catalog. OMP prefers `.omp-plugin/`.
    REPO / ".claude-plugin" / "marketplace.json",
)

# Third-party plugins advertised alongside our own. They are hand-maintained in that file
# because nothing in the repository can derive them; every other entry is derived.
THIRD_PARTY = REPO / "scripts" / "third-party-plugins.json"

VALID_SOURCE_KINDS = {"github", "git-subdir", "url"}

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


# Every source kind OMP's resolver accepts, mapped to the fields it requires as
# non-empty strings. `npm` is absent deliberately: OMP throws on it.
SOURCE_REQUIRED_FIELDS = {
    "github": ("repo",),
    "git-subdir": ("url", "path"),
    "url": ("url",),
}

# OMP addresses a plugin as `<name>@<marketplace>`, so a name carrying `@`, whitespace,
# or a path separator is unaddressable.
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")


def _fail(message: str) -> None:
    raise SystemExit(f"{THIRD_PARTY.name}: {message}")


def _require_string(entry_name: str, container: dict[str, object], field: str, label: str) -> None:
    value = container.get(field)
    if not isinstance(value, str) or not value.strip():
        _fail(f"{entry_name!r} {label} `{field}` must be a non-empty string, got {value!r}")


def third_party() -> list[dict[str, object]]:
    """Validated third-party catalog entries, or none when the file is absent.

    An ABSENT file is not an error: a fresh checkout that advertises nothing third-party
    still builds a valid catalog of local packages.

    A PRESENT file must be well formed. Treating a malformed one as empty would silently
    republish the catalog without every advertised entry, which reads as a successful
    build and removes plugins consumers install by name.
    """
    if not THIRD_PARTY.is_file():
        return []

    try:
        data = json.loads(THIRD_PARTY.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        _fail(f"is not valid JSON: {err}")
    if not isinstance(data, dict):
        _fail(f"must contain a JSON object, got {type(data).__name__}")
    if "plugins" not in data:
        # `data.get("plugins", [])` would make a typo here look like an empty advertisement
        # list and quietly drop every entry.
        _fail("is missing the `plugins` key; remove the file to advertise nothing")
    entries = data["plugins"]
    if not isinstance(entries, list):
        _fail(f"`plugins` must be a list, got {type(entries).__name__}")

    seen: set[str] = set()
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            _fail(f"entry {position} must be an object, got {type(entry).__name__}")

        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            _fail(f"entry {position} needs a non-empty string `name`")
        if not NAME_PATTERN.match(name):
            _fail(f"{name!r} is not addressable as `<name>@<marketplace>`")
        if name in seen:
            _fail(f"duplicate entry {name!r}")
        seen.add(name)

        _require_string(name, entry, "description", "entry")
        # OMP compares `plugins[].version` when deciding upgradability, so an entry
        # without one is invisible to that comparer.
        _require_string(name, entry, "version", "entry")

        source = entry.get("source")
        if not isinstance(source, dict):
            _fail(f"{name!r} needs a `source` object, got {type(source).__name__}")
        kind = source.get("source")
        if kind not in SOURCE_REQUIRED_FIELDS:
            _fail(
                f"{name!r} has unsupported source kind {kind!r}; "
                f"expected one of {sorted(SOURCE_REQUIRED_FIELDS)}"
            )
        for field in SOURCE_REQUIRED_FIELDS[kind]:
            _require_string(name, source, field, f"{kind} source")

    return entries


def build() -> dict[str, object]:
    plugins = []
    local_names = set()
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
        local_names.add(manifest["name"])
        plugins.append(entry)

    for entry in third_party():
        # A third-party name colliding with a local package makes one of the two
        # unreachable through `omp plugin install <name>@srobroek-omp`.
        if entry["name"] in local_names:
            raise SystemExit(f"{THIRD_PARTY.name}: {entry['name']!r} collides with a local package")
        advertised = {
            "name": entry["name"],
            "description": entry["description"],
            "source": entry["source"],
            "version": entry["version"],
        }
        for optional in ("category", "license"):
            if optional in entry:
                advertised[optional] = entry[optional]
        plugins.append(advertised)

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
