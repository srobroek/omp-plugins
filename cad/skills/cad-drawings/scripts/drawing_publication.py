"""cad-record layout loading and the shared sealed-bundle boundary for drawing producers."""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any, Mapping

LAYOUT_PY = Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "layout.py"


def layout() -> Any:
    name = "cad_record_layout"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, LAYOUT_PY)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load {LAYOUT_PY}")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


def prepare(hw: Path, requested: str, subject: str, output: Path | None, recipe: Mapping[str, Any],
            replace: bool) -> tuple[str, Path, Path, Path | None, bool]:
    """Verify the built input and either reuse a bundle, provide scratch, or stage publication."""
    api = layout()
    label, version_dir, record_dir = api.built_version(hw, requested)
    if output is not None:
        return label, version_dir, record_dir, api.scratch_path(hw, output, "--output-dir"), False
    params = {"V": label, "S": subject}
    existing = api.reusable(hw, "bundle.drawings", params, recipe, replace=replace)
    if existing is not None:
        return label, version_dir, record_dir, existing, True
    return label, version_dir, record_dir, api.staging(hw, "bundle.drawings"), True


def publish(hw: Path, label: str, subject: str, draft: Path, recipe: Mapping[str, Any], producer: str,
            replace: bool) -> Path:
    """Seal a passing package, retaining the intended readable destination in package.json."""
    api = layout()
    target = api.bundle_dir(hw, "drawings", label, subject)
    package = draft / "package.json"
    data = json.loads(package.read_text(encoding="utf-8"))
    data["output_dir"] = str(target)
    package.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    result = api.publish(hw, "bundle.drawings", {"V": label, "S": subject}, draft, recipe=recipe,
                         producer=producer, status="pass", replace=replace)
    return result.path


def discard_empty(draft: Path) -> None:
    """Remove only an unused staging directory; rejected package drafts remain in .cad-work."""
    if draft.is_dir() and not any(draft.iterdir()):
        shutil.rmtree(draft)
