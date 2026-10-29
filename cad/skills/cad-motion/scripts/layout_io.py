"""Thin helpers for consumers of cad-record's canonical layout API."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from hashlib import sha256
from pathlib import Path
from typing import Any, Mapping

LAYOUT_PATH = Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "layout.py"


def api() -> Any:
    name = "cad_record_layout"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, LAYOUT_PATH)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {LAYOUT_PATH}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def version(hw: Path, requested: str) -> tuple[str, Path, Path]:
    layout = api()
    version = layout.latest(hw) if requested == "latest" else requested
    if version is None:
        raise layout.LayoutError("no built version: latest.json is absent")
    directory = layout.version_dir(hw, version)
    if not (directory / "manifest.json").is_file():
        raise layout.LayoutError(f"--version {version}: {directory} is not built")
    problems = layout.verify(directory)
    if problems:
        raise layout.LayoutError(f"--version {version}: integrity failure: {'; '.join(problems)}")
    record = layout.resolve(hw, "version.record", V=version)
    if not (record / "product.yaml").is_file():
        raise layout.LayoutError(f"--version {version}: record snapshot missing; rebuild this version")
    return version, directory, record


def scratch_output(hw: Path, path: Path, option: str) -> Path:
    layout = api()
    target = Path(path).resolve()
    try:
        relative = layout.relative(hw, target)
    except layout.LayoutError as error:
        raise layout.LayoutError(f"{option} must be under {hw.parent / '.cad-work'}, not {target}") from error
    if not relative.startswith(".cad-work/"):
        raise layout.LayoutError(f"{option} must be under {hw.parent / '.cad-work'}, not {target}")
    return target


def fingerprint(*paths: Path) -> str:
    digest = sha256()
    for path in paths:
        digest.update(path.name.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def reuse(hw: Path, entry: str, version: str, case: str, recipe: Mapping[str, Any], replace: bool,
          result_name: str = "result.json"):
    layout = api()
    target = layout.bundle_dir(hw, entry.removeprefix("bundle."), version, case)
    if not os.path.lexists(target):
        return None
    try:
        manifest = json.loads((target / "manifest.json").read_text(encoding="utf-8")) if not target.is_symlink() else None
    except (OSError, ValueError):
        manifest = None
    version_sha = sha256((layout.version_dir(hw, version) / "manifest.json").read_bytes()).hexdigest()
    if (not target.is_symlink() and not layout.verify(target) and isinstance(manifest, dict)
            and manifest.get("recipe_sha256") == layout.recipe_sha256(recipe)
            and manifest.get("version_manifest_sha256") == version_sha):
        try:
            return target, json.loads((target / result_name).read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise layout.LayoutError(f"{target}: cannot read {result_name}: {error}") from error
    if not replace:
        raise layout.PublishConflict(f"{target} exists with another recipe or fails verification; use --replace")
    return None


def publish(hw: Path, entry: str, version: str, case: str, stage: Path, recipe: Mapping[str, Any],
            producer: str, status: str, replace: bool):
    return api().publish(hw, entry, {"V": version, "S": case}, stage, recipe=recipe, producer=producer,
                        status=status, replace=replace)
