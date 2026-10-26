"""Which files make up one built cad-model version of a hardware record.

cad-model owns the layout (`skill://cad-model/references/outputs.md`): `hw/versions/latest.json`
names the newest version and its files, relative to `hw/`; an older `vN` keeps the same file names
under `hw/versions/vN/`. Stdlib only, so every consumer can import it: render.py and cad-viewer
both resolve versions here. Load it by path (importlib) and register it in `sys.modules` before
running it, as dataclasses need the module there; materials.py is shared the same way.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

LABEL = re.compile(r"^v[1-9][0-9]*$")
# latest.json key -> file name inside versions/<label>/
FILES = {"assembly_step": "assembly.step", "glb": "assembly.glb", "metrics": "metrics.json",
         "part_map": "part-map.json", "manifest": "manifest.json"}


class VersionError(RuntimeError):
    """The version is not built, or latest.json is malformed."""


@dataclass(frozen=True)
class VersionFiles:
    label: str
    files: dict[str, Path]  # every FILES key -> an existing file

    @property
    def parts_dir(self) -> Path:
        """The per-part STEP folder beside assembly.step."""
        return self.files["assembly_step"].parent / "parts"


def resolve(hw: Path, version: str = "latest") -> VersionFiles:
    """The files of `latest` or a `vN` label; raises VersionError unless every one exists."""
    versions = hw / "versions"
    latest_path = versions / "latest.json"
    latest = _read_latest(latest_path) if latest_path.is_file() else None
    if version == "latest":
        if latest is None:
            raise VersionError(f"{latest_path} not found; build a version with cad-model run first")
        label = latest.get("label")
        if not isinstance(label, str) or not LABEL.match(label):
            raise VersionError(f"{latest_path}: `label` must be vN, got {label!r}")
    elif LABEL.match(version):
        label = version
    else:
        raise VersionError(f"version must be latest or vN, got {version!r}")
    if latest is not None and latest.get("label") == label:
        missing = [key for key in FILES if not isinstance(latest.get(key), str)]
        if missing:
            raise VersionError(f"{latest_path}: missing {missing}")
        files = {key: hw / latest[key] for key in FILES}
    else:
        files = {key: versions / label / name for key, name in FILES.items()}
    absent = [str(path) for path in files.values() if not path.is_file()]
    if absent:
        raise VersionError(f"version {label}: missing {absent}")
    return VersionFiles(label, files)


def _read_latest(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise VersionError(f"cannot read {path}: {error}") from error
    if not isinstance(data, dict):
        raise VersionError(f"{path}: expected a JSON object")
    return data
