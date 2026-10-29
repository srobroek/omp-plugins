"""Load cad-record's layout API for version-bound viewer capture publication."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, Mapping

LAYOUT_PY = Path(__file__).resolve().parents[3] / "cad-record" / "scripts" / "layout.py"


def layout() -> Any:
    name = "cad_record_layout"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, LAYOUT_PY)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load {LAYOUT_PY}")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


def reusable(hw: Path, version: str, subject: str, recipe: Mapping[str, Any], replace: bool) -> Path | None:
    return layout().reusable(hw, "bundle.captures", {"V": version, "S": subject}, recipe, replace=replace)


def staging(hw: Path) -> Path:
    return layout().staging(hw, "bundle.captures")


def publish(hw: Path, version: str, subject: str, staged: Path, recipe: Mapping[str, Any], replace: bool) -> Path:
    result = layout().publish(hw, "bundle.captures", {"V": version, "S": subject}, staged, recipe=recipe,
                              producer="cad-viewer viewer.py capture", status="pass", replace=replace)
    return result.path
