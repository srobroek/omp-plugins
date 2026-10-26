#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Write or verify the CAD design recheck record for the staged index."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STAGES = (
    "ground",
    "intent",
    "specify",
    "concept",
    "layout",
    "parts",
    "detail",
    "bom",
    "analysis",
    "critique",
    "reconcile",
    "design_freeze",
    "release",
)


def git(*args: str, cwd: Path) -> bytes:
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, check=False
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or f"git {' '.join(args)} failed ({result.returncode})")
    return result.stdout


def project_root(start: Path) -> Path:
    return Path(git("rev-parse", "--show-toplevel", cwd=start).decode().strip())


def staged_tree_hash(root: Path) -> str:
    """Hash index entries for hw/, except the generated recheck metadata."""
    entries = git("ls-files", "-s", "--", "hw/", cwd=root)
    digest = hashlib.sha256()
    for entry in entries.splitlines(keepends=True):
        _, separator, path = entry.partition(b"\t")
        if not separator or path.startswith(b"hw/.cad/"):
            continue
        digest.update(entry)
    return digest.hexdigest()


def command_version(command: str, *args: str) -> str | None:
    executable = shutil.which(command)
    if executable is None:
        return None
    try:
        result = subprocess.run(
            [executable, *args], capture_output=True, text=True, check=False, timeout=5
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode:
        return None
    version = (result.stdout or result.stderr).strip().splitlines()
    return version[0] if version else None


def tool_versions() -> dict[str, str]:
    versions = {"python": platform.python_version()}
    for name, command, args in (
        ("git", "git", ("--version",)),
        ("uv", "uv", ("--version",)),
        ("freecad", "freecadcmd", ("--version",)),
    ):
        version = command_version(command, *args)
        if version:
            versions[name] = version
    for distribution in ("cadquery", "build123d"):
        try:
            versions[distribution] = importlib.metadata.version(distribution)
        except importlib.metadata.PackageNotFoundError:
            pass
    return versions


def load_checks(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read checks JSON {path}: {error}") from error


def record(stage: str, checks_path: Path, passed: bool, root: Path) -> dict[str, Any]:
    if stage not in STAGES:
        raise RuntimeError(f"unknown stage {stage!r}; expected one of: {', '.join(STAGES)}")
    checks = load_checks(checks_path)
    return {
        "tree_hash": staged_tree_hash(root),
        "stage": stage,
        "checks": checks,
        "passed": passed,
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "tool_versions": tool_versions(),
    }


def write_record(data: dict[str, Any], root: Path) -> Path:
    directory = root / "hw" / ".cad"
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / "recheck.json"
    temporary = directory / ".recheck.json.tmp"
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    try:
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(destination)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=STAGES, help="stage for a newly written recheck stamp")
    parser.add_argument("--checks", type=Path, help="JSON check results")
    parser.add_argument("--passed", action="store_true", help="record that every required check passed")
    parser.add_argument("--verify", action="store_true", help="verify the staged stamp against the current staged hash")
    args = parser.parse_args()
    if args.verify:
        if args.stage is not None or args.checks is not None or args.passed:
            parser.error("--verify cannot be combined with --stage, --checks, or --passed")
        return args
    elif args.stage is None or args.checks is None:
        parser.error("--stage and --checks are required unless --verify is used")
    return args


def main() -> int:
    args = parse_args()
    try:
        start = Path.cwd()
        root = project_root(start)
        if args.verify:
            record_path = root / "hw" / ".cad" / "recheck.json"
            try:
                record_data = json.loads(git("show", ":hw/.cad/recheck.json", cwd=root).decode("utf-8"))
            except (RuntimeError, UnicodeError, json.JSONDecodeError) as error:
                raise RuntimeError(f"cannot read staged recheck stamp: {error}") from error
            if not isinstance(record_data, dict):
                raise RuntimeError("recheck stamp must be a JSON object")
            actual_hash = staged_tree_hash(root)
            try:
                product_data = git("show", ":hw/product.yaml", cwd=root).decode("utf-8")
            except (RuntimeError, UnicodeError) as error:
                raise RuntimeError(f"cannot read staged hw/product.yaml: {error}") from error
            current_stage = None
            in_flow = False
            for line in product_data.splitlines():
                if line.strip() == "flow:":
                    in_flow = True
                    continue
                if in_flow and line and not line[0].isspace():
                    break
                if in_flow and line.lstrip().startswith("stage:"):
                    current_stage = line.split(":", 1)[1].split("#", 1)[0].strip().strip("\"'")
                    break
            if current_stage is None or record_data.get("stage") != current_stage:
                raise RuntimeError("the recheck stamp stage does not match staged hw/product.yaml flow.stage")
            if record_data.get("stage") not in STAGES:
                raise RuntimeError("recheck stamp has an unknown stage")
            if record_data.get("passed") is not True:
                raise RuntimeError("the recheck stamp does not say passed: true")
            if record_data.get("tree_hash") != actual_hash:
                raise RuntimeError("the recheck stamp is stale for the staged hw/ tree")
            print(json.dumps({"passed": True, "tree_hash": actual_hash}))
            return 0
        checks_path = args.checks if args.checks.is_absolute() else start / args.checks
        data = record(args.stage, checks_path, args.passed, root)
        write_record(data, root)
        print(json.dumps(data, ensure_ascii=False, indent=2))
    except (OSError, RuntimeError) as error:
        print(f"cad-recheck stamp: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
