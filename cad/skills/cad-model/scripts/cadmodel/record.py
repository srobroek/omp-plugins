"""The cad-record layout module, loaded from its sibling skill, and the record snapshot a version is built from."""

from __future__ import annotations

import hashlib
import importlib.util
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping

LAYOUT_SCRIPT = Path(__file__).resolve().parents[3] / "cad-record" / "scripts" / "layout.py"
RECORD_FILES = ("product.yaml", "interfaces.yaml", "assembly.yaml")  # hw/ files a version snapshots when present


def load_layout() -> Any:
    """cad-record `layout.py` under the name `cad_record_layout`, shared with validate.py (references/layout-api.md)."""
    name = "cad_record_layout"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, LAYOUT_SCRIPT)
        if spec is None or spec.loader is None:
            raise ImportError(f"cad-record layout.py not found at {LAYOUT_SCRIPT}")
        sys.modules[name] = importlib.util.module_from_spec(spec)  # its dataclasses look the module up here
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


def snapshot(hw: Path, pns: Iterable[str]) -> dict[str, bytes]:
    """The bytes of the record files a version is built from, keyed by their path below hw/: the
    product, interface and assembly records that exist, and parts/<PN>/part.yaml of each PN."""
    names = [name for name in RECORD_FILES if (hw / name).is_file()]
    names += [f"parts/{pn}/part.yaml" for pn in sorted(pns) if (hw / "parts" / pn / "part.yaml").is_file()]
    return {name: (hw / name).read_bytes() for name in names}


def write_snapshot(folder: Path, files: Mapping[str, bytes]) -> dict[str, str]:
    """Write `files` below `folder` (a version's record/) and return each path's sha256."""
    hashes = {}
    for name, data in sorted(files.items()):
        target = folder / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    return hashes
