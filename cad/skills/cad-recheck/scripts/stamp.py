#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6.0", "jsonschema>=4.23"]
# ///
"""Write or verify the CAD design recheck record for the staged index."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import platform
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


def cad_record_root() -> Path:
    installed = Path(__file__).resolve().parent / "cad-record"
    skill_tree = Path(__file__).resolve().parents[2] / "cad-record"
    for candidate in (installed, skill_tree):
        if (candidate / "scripts" / "validate.py").is_file():
            return candidate
    raise RuntimeError(f"cannot find cad-record/scripts/validate.py; checked {installed} and {skill_tree}")


CAD_RECORD_ROOT = cad_record_root()
CAD_RECORD_SCRIPTS = CAD_RECORD_ROOT / "scripts"


def _load_module(name: str, path: Path):
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]

layout = _load_module("cad_record_layout", CAD_RECORD_SCRIPTS / "layout.py")
validate = _load_module("cad_record_validate", CAD_RECORD_SCRIPTS / "validate.py")




def staged_product(root: Path, stage: str | None = None) -> dict[str, Any]:
    """Read the index version of product.yaml to grade layout paths at the staged stage."""
    try:
        raw = git("show", ":hw/product.yaml", cwd=root).decode("utf-8")
        product = yaml.safe_load(raw)
    except (RuntimeError, UnicodeError, yaml.YAMLError) as error:
        if stage is None:
            raise RuntimeError(f"cannot read staged hw/product.yaml: {error}") from error
        product = {"flow": {"stage": stage}}
    return product if isinstance(product, dict) else {}


def require_clean_layout(root: Path, product: dict[str, Any]) -> None:
    part_records = {}
    for part_path in sorted((root / "hw" / "parts").glob("*/part.yaml")):
        try:
            part = yaml.safe_load(part_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, yaml.YAMLError) as error:
            raise RuntimeError(f"cannot read {part_path}: {error}") from error
        if isinstance(part, dict) and isinstance(part.get("PN"), str):
            part_records[part["PN"]] = (part, str(part_path))
    findings: list[dict[str, str]] = []
    validate.check_layout(root / "hw", product, part_records, findings)
    blocking = validate.blocking(findings)
    if blocking:
        first = blocking[0]
        raise RuntimeError(f"CAD layout has {len(blocking)} blocking finding(s): {first['path']}: {first['message']}")

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
    return versions


def load_checks(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot read checks JSON {path}: {error}") from error


def require_complete(checks: Any, path: Path) -> None:
    """Refuse a partial check result, such as cad-model `check --changed-only` (`scope.complete: false`)."""
    scope = checks.get("scope") if isinstance(checks, dict) else None
    if isinstance(scope, dict) and scope.get("complete") is False:
        raise RuntimeError(f"{path} is a partial check ({scope.get('kind', 'partial')} scope, complete: false); "
                           "run the full check (cad_model.py check vN without --changed-only, --since-version or --pair) "
                           "and stamp that result")


def record(stage: str, checks_path: Path, passed: bool, root: Path) -> dict[str, Any]:
    if stage not in validate.stages():
        raise RuntimeError(f"unknown stage {stage!r}; expected one of: {', '.join(validate.stages())}")
    require_clean_layout(root, staged_product(root, stage))
    checks = load_checks(checks_path)
    require_complete(checks, checks_path)
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
    parser.add_argument("--stage", choices=validate.stages(), help="stage for a newly written recheck stamp")
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
            try:
                product_data = git("show", ":hw/product.yaml", cwd=root).decode("utf-8")
            except (RuntimeError, UnicodeError) as error:
                raise RuntimeError(f"cannot read staged hw/product.yaml: {error}") from error
            try:
                product = yaml.safe_load(product_data)
            except yaml.YAMLError as error:
                raise RuntimeError(f"cannot parse staged hw/product.yaml: {error}") from error
            if not isinstance(product, dict):
                raise RuntimeError("staged hw/product.yaml must be a mapping")
            flow = product.get("flow")
            if not isinstance(flow, dict):
                raise RuntimeError("staged hw/product.yaml is missing flow")
            current_stage = flow.get("stage")
            threshold = flow.get("recheck_from")
            if not isinstance(current_stage, str) or current_stage not in validate.stages():
                raise RuntimeError("staged hw/product.yaml has a missing or unknown flow.stage")
            if not isinstance(threshold, str) or threshold not in validate.stages():
                raise RuntimeError("staged hw/product.yaml has a missing or unknown flow.recheck_from")
            require_clean_layout(root, product)
            if validate.stages().index(current_stage) < validate.stages().index(threshold):
                print(json.dumps({"passed": True, "required": False, "stage": current_stage}))
                return 0
            try:
                record_data = json.loads(git("show", ":hw/.cad/recheck.json", cwd=root).decode("utf-8"))
            except (RuntimeError, UnicodeError, json.JSONDecodeError) as error:
                raise RuntimeError(f"no staged hw/.cad/recheck.json exists or cannot read it: {error}") from error
            if not isinstance(record_data, dict):
                raise RuntimeError("recheck stamp must be a JSON object")
            actual_hash = staged_tree_hash(root)
            if record_data.get("stage") != current_stage:
                raise RuntimeError("the recheck stamp stage does not match staged hw/product.yaml flow.stage")
            if record_data.get("stage") not in validate.stages():
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
