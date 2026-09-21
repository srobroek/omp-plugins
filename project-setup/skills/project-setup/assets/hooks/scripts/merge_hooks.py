#!/usr/bin/env python3
"""Merge hook fragments into the root configuration without losing brownfield hooks.

    merge_hooks.py <dest>

prek reads exactly one config file and has no include directive, so the fragment
convention needs this step. It also skips dot-prefixed directories when
discovering, which makes `.pre-commit.d/` invisible to it until this runs.

In a monorepo each member carries a real `.pre-commit-config.yaml` and prek's
workspace mode unions them, namespacing hooks `<dir>:<hook-id>`. This merge is for
the single-directory case, where two layers cannot both own the root file.

Existing semantic configuration is loaded first and retained. A conflicting
revision, hook definition, malformed configuration, or unwritable target is
refused explicitly; identical entries are idempotently de-duplicated. Fragment
order is stable by name.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import yaml

HEADER = """\
# .pre-commit-config.yaml -- maintained from .pre-commit.d/ by `just hooks-merge`.
#
# Existing semantic configuration is retained when fragments are merged. Add or
# change a fragment in .pre-commit.d/ and rerun the command; conflicting revisions
# or hook definitions are refused rather than silently replacing an old entry.
#
# `default_install_hook_types` has to name every stage the hooks below use, or
# `prek install` writes no shim for the missing one and that hook never fires.
"""

# Every stage a fragment may declare. `prek install` writes one shim per entry in
# default_install_hook_types, so a stage absent from that list is a hook that
# silently never runs.
STAGE_ORDER = (
    "pre-commit",
    "commit-msg",
    "prepare-commit-msg",
    "pre-merge-commit",
    "post-checkout",
    "post-merge",
    "post-commit",
    "post-rewrite",
    "pre-push",
    "pre-rebase",
)


def load(fragment: Path) -> dict:
    try:
        data = yaml.safe_load(fragment.read_text()) or {}
    except yaml.YAMLError as exc:
        raise SystemExit(f"conflict: {fragment.name} is not valid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(
            f"conflict: {fragment.name} must be a mapping with a top-level 'repos:' key, "
            f"got {type(data).__name__}"
        )
    return data


def _conflict(message: str) -> None:
    raise SystemExit(f"conflict: {message}")


def _validate_entries(data: dict, source: str) -> list[dict]:
    entries = data.get("repos", [])
    if not isinstance(entries, list):
        _conflict(f"{source} has a non-list 'repos' value")
    for entry in entries:
        if not isinstance(entry, dict):
            _conflict(f"{source} has a non-mapping repository entry")
        if not entry.get("repo"):
            _conflict(f"{source} has a repository entry without 'repo'")
        hooks = entry.get("hooks", [])
        if not isinstance(hooks, list) or any(not isinstance(hook, dict) for hook in hooks):
            _conflict(f"{source} has a repository with malformed hooks")
    return entries


def _merge_excludes(config: dict, fragment_excludes: list[str]) -> None:
    if "exclude" not in config and not fragment_excludes:
        return
    existing = config.get("exclude")
    if existing is not None and not isinstance(existing, str):
        _conflict("'exclude' must be a regular expression string")
    values = [existing] if existing else []
    for pattern in fragment_excludes:
        # A previous run writes each fragment pattern as `(?:pattern)`. Avoid
        # nesting that same pattern again when the generated file is the input.
        if pattern in values or (existing and f"(?:{pattern})" in existing):
            continue
        values.append(pattern)
    if values:
        config["exclude"] = values[0] if len(values) == 1 else "|".join(f"(?:{value})" for value in values)


def merge(fragments: list[Path], existing: dict | None = None) -> tuple[dict, list[str]]:
    """Merge existing config first, then fragments, refusing semantic conflicts."""
    config = dict(existing or {})
    repos: dict[str, dict] = {}
    sources: dict[str, str] = {}
    warnings: list[str] = []
    fragment_excludes: list[str] = []

    def add_entries(entries: list[dict], source: str) -> None:
        for entry in entries:
            url = str(entry["repo"])
            rev = entry.get("rev", "")
            hooks = entry.get("hooks", [])
            if url not in repos:
                repos[url] = {key: value for key, value in entry.items() if key != "source"}
                repos[url]["hooks"] = list(hooks)
                sources[url] = source
                continue

            current = repos[url]
            previous = sources[url]
            old_rev = current.get("rev", "")
            if rev and old_rev and rev != old_rev:
                _conflict(f"{url} is pinned to {old_rev} by {previous} and {rev} by {source}")
            if rev and not old_rev:
                current["rev"] = rev

            for key, value in entry.items():
                if key in {"repo", "rev", "hooks", "source"}:
                    continue
                if key in current and current[key] != value:
                    _conflict(f"{url} has conflicting '{key}' values from {previous} and {source}")
                current.setdefault(key, value)

            seen = {hook.get("id"): hook for hook in current.get("hooks", [])}
            for hook in hooks:
                hook_id = hook.get("id")
                if hook_id in seen:
                    if seen[hook_id] != hook:
                        _conflict(f"{url} hook {hook_id!r} differs between {previous} and {source}")
                    continue
                current.setdefault("hooks", []).append(hook)
                seen[hook_id] = hook

    if existing is not None:
        add_entries(_validate_entries(existing, ".pre-commit-config.yaml"), ".pre-commit-config.yaml")
        old_stages = existing.get("default_install_hook_types", [])
        if not isinstance(old_stages, list) or any(not isinstance(stage, str) for stage in old_stages):
            _conflict("'default_install_hook_types' must be a list of stage names")
    else:
        old_stages = []

    for fragment in fragments:
        data = load(fragment)
        if data.get("exclude"):
            if not isinstance(data["exclude"], str):
                _conflict(f"{fragment.name} has a non-string 'exclude' value")
            fragment_excludes.append(data["exclude"])
        add_entries(_validate_entries(data, fragment.name), fragment.name)

    _merge_excludes(config, fragment_excludes)

    stages = set(old_stages)
    stages.update(
        stage
        for repo in repos.values()
        for hook in repo.get("hooks", [])
        for stage in hook.get("stages", ["pre-commit"])
    )
    unknown = stages - set(STAGE_ORDER)
    if unknown:
        _conflict(f"unknown hook stage(s): {', '.join(sorted(unknown))}")
    ordered_stages = [stage for stage in old_stages if stage in stages]
    ordered_stages.extend(stage for stage in STAGE_ORDER if stage in stages and stage not in ordered_stages)
    config["default_install_hook_types"] = ordered_stages
    config["repos"] = [repos[url] for url in sorted(repos)]
    return config, warnings


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2

    dest = Path(sys.argv[1])
    directory = dest / ".pre-commit.d"
    fragments = sorted(directory.glob("*.yaml")) if directory.is_dir() else []
    target = dest / ".pre-commit-config.yaml"
    if not fragments:
        print("no .pre-commit.d fragments, leaving .pre-commit-config.yaml alone")
        return 0

    existing = load(target) if target.is_file() else None
    config, warnings = merge(fragments, existing)
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if (target.exists() and not os.access(target, os.W_OK)) or (
        not target.exists() and not os.access(target.parent, os.W_OK)
    ):
        _conflict(f"cannot write {target.name} without overwriting brownfield configuration")

    target.write_text(
        HEADER
        + yaml.dump(
            config,
            default_flow_style=False,
            sort_keys=False,
            # A wrapped `entry:` still folds back to the same command, but it reads
            # as a broken shell line and every later edit rewraps the block, which
            # makes the diff noise rather than the change.
            width=10_000,
        )
    )
    stages = ", ".join(config["default_install_hook_types"])
    print(f"merged {len(fragments)} fragment(s) into .pre-commit-config.yaml ({stages})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
