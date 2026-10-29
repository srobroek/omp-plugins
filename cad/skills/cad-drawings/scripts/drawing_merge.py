#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["defusedxml>=0.7.1", "pyyaml>=6.0", "jsonschema>=4.23"]
# ///
"""Merge a reviewed drawing draft's ``drawing`` block into the part's part.yaml.

Usage: drawing_merge.py HW [--version vN] --part PN --draft DIR/PN/drawing_intent.draft.yaml

The command an agent runs instead of copying the block by hand. It refuses, and leaves part.yaml as
it was, when:

- the draft is for another part or has no ``drawing`` block (exit 2);
- the block still holds a ``REVIEW`` placeholder (``draft_unreviewed``);
- the version has no ``drawing_features`` hook for the part (``drawing_intent_missing``), or the hook
  returns no locator for a feature the block names in ``features``, ``datum_features``,
  ``views[].feature``, ``dimensions[].features`` and ``.at`` or ``geometric_tolerances[].features``
  (``feature_not_found``): write the hook and rebuild first, then draft again for its names;
- the merged record fails cad-record's validator (``invalid_drawing_intent``), or the version no longer
  matches its sources (``source_mismatch``, exit 2), as ``drawing_contract.load_context`` checks it.

Otherwise it replaces part.yaml's top-level ``drawing`` key, or appends one, and keeps every other
line as written. Exit 0 merged, 1 refused, 2 invalid input.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import drawing_contract  # noqa: E402
from drawing_draft import REVIEW  # noqa: E402

TOP_KEY = re.compile(r"drawing\s*:")


def placeholders(value: Any, path: str = "drawing") -> list[str]:
    """The paths in the block that still hold a review placeholder."""
    if isinstance(value, str):
        return [path] if value.startswith(REVIEW) else []
    if isinstance(value, Mapping):
        return [p for key, item in value.items() for p in placeholders(item, f"{path}.{key}")]
    if isinstance(value, list):
        return [p for index, item in enumerate(value) for p in placeholders(item, f"{path}[{index}]")]
    return []


def named_features(block: Mapping[str, Any]) -> dict[str, list[str]]:
    """Every semantic feature ID the block names, with where it names it."""
    named: dict[str, list[str]] = {}

    def add(where: str, name: Any) -> None:
        named.setdefault(str(name), []).append(where)

    for name in block.get("features") or {}:
        add("features", name)
    for label, datum in (block.get("datum_features") or {}).items():
        add(f"datum_features.{label}", (datum or {}).get("feature"))
    for view in block.get("views") or []:
        if "feature" in view:
            add(f"views.{view.get('id')}", view["feature"])
    for group in ("dimensions", "geometric_tolerances"):
        for entry in block.get(group) or []:
            for name in [*(entry.get("features") or []), *([entry["at"]] if entry.get("at") else [])]:
                add(f"{group}.{entry.get('id')}", name)
    return named


def replace_drawing(text: str, block: Mapping[str, Any]) -> str:
    """``text`` (a part.yaml) with its top-level ``drawing`` key set to ``block``; every other line as written."""
    dumped = yaml.safe_dump({"drawing": dict(block)}, sort_keys=False, width=120, default_flow_style=None,
                            allow_unicode=True)
    lines = text.splitlines(keepends=True)
    start = next((i for i, line in enumerate(lines) if TOP_KEY.match(line)), None)
    if start is None:
        return text + ("" if not text or text.endswith("\n") else "\n") + dumped
    end = start + 1
    while end < len(lines) and (lines[end][:1] in (" ", "\t") or not lines[end].strip()):
        end += 1
    while end > start + 1 and not lines[end - 1].strip():   # blank lines before the next key stay
        end -= 1
    return "".join(lines[:start]) + dumped + "".join(lines[end:])


def _write(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.merge")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def merge(hw: Path, version_dir: Path, pn: str, draft: Mapping[str, Any]) -> tuple[dict[str, Any], int]:
    """Merge ``draft``'s drawing block into ``pn``'s part.yaml, or refuse and leave it unchanged."""
    record_path = hw / "parts" / pn / "part.yaml"

    def report(status: str, findings: list[dict[str, Any]], code: int, **extra: Any) -> tuple[dict[str, Any], int]:
        return {"status": status, "part": pn, "part_yaml": str(record_path), "findings": findings, **extra}, code

    block = draft.get("drawing")
    if draft.get("part") != pn or not isinstance(block, Mapping):
        return report("error", [{"code": "invalid_input", "message": f"the draft is not a drawing draft for {pn}"}], 2)
    unreviewed = [{"code": "draft_unreviewed", "message": f"{path} is still a {REVIEW} placeholder"}
                  for path in placeholders(block)]
    if unreviewed:
        return report("refused", unreviewed, 1)
    before = record_path.read_text(encoding="utf-8")
    merged = replace_drawing(before, block)
    old, new = yaml.safe_load(before) or {}, yaml.safe_load(merged)
    if new.get("drawing") != block or {k: v for k, v in new.items() if k != "drawing"} != \
            {k: v for k, v in old.items() if k != "drawing"}:
        return report("error", [{"code": "invalid_input", "message": f"{record_path} does not round-trip the merge"}], 2)
    _write(record_path, merged)
    try:
        locators = drawing_contract.load_context(hw, version_dir).part(pn).features
    except drawing_contract.ContractError as exc:
        _write(record_path, before)
        found = [{"code": exc.code, "message": str(exc)}, *(dict(f) for f in exc.findings)]
        return report("refused" if exc.code == "invalid_drawing_intent" else "error", found,
                      1 if exc.code == "invalid_drawing_intent" else 2)
    if locators is None:
        _write(record_path, before)
        return report("refused", [{"code": "drawing_intent_missing", "message": f"{version_dir.name} has no "
                                   f"drawing_features hook result for {pn}: write the hook, rebuild, and draft again"}], 1)
    unknown = [{"code": "feature_not_found", "feature": name,
                "message": f"{name} ({', '.join(where)}) is not a locator the {pn} drawing_features hook returns"}
               for name, where in sorted(named_features(block).items()) if name not in locators]
    if unknown:
        _write(record_path, before)
        return report("refused", unknown, 1)
    return report("pass", [], 0, version=version_dir.name, features=len(block.get("features") or {}),
                  dimensions=len(block.get("dimensions") or []))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("hw", type=Path)
    parser.add_argument("--version")
    parser.add_argument("--part", required=True)
    parser.add_argument("--draft", type=Path, required=True)
    args = parser.parse_args(argv)
    hw = args.hw.resolve()
    api = drawing_contract.layout_api()
    try:
        _, version_dir, _ = api.built_version(hw, args.version or "latest")
        draft = yaml.safe_load(args.draft.read_text(encoding="utf-8"))
    except (api.LayoutError, OSError, ValueError, KeyError, yaml.YAMLError) as exc:
        print(json.dumps({"status": "error", "part": args.part, "findings": [{"code": "invalid_input",
                                                                              "message": str(exc)}]}, indent=2))
        return 2
    result, code = merge(hw, version_dir, args.part, draft if isinstance(draft, Mapping) else {})
    print(json.dumps(result, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
