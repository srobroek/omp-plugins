"""Which files make up one built cad-model version of a hardware record, and its occurrences.

cad-model owns the layout (`skill://cad-model/references/outputs.md`): `hw/versions/latest.json`
names the newest version and its files, relative to `hw/`; an older `vN` keeps the same file names
under `hw/versions/vN/`. Stdlib only, so every consumer can import it: render.py and cad-viewer
both resolve versions here. Load it by path (importlib) and register it in `sys.modules` before
running it, as dataclasses need the module there; materials.py is shared the same way.

`built_occurrences` and `built_joints` are the one reader of a version's occurrence identity: a
schema_version 2 part map and manifest name occurrences; an immutable version 1 file, written
before occurrences existed, reads as one occurrence per PN whose id is the PN.
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
SCHEMA_VERSION = 2  # part-map.json, manifest.json and metrics.json; a file without the key is version 1
IDENTITY_ROWS = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]


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


@dataclass(frozen=True)
class BuiltOccurrence:
    """One placed instance in a built version, with its GLB nodes and its placements as 3x4 rows."""

    id: str
    pn: str
    ref: str  # `@id`, or the PN of a legacy singleton
    group: str | None  # subassembly id
    node_indices: tuple[int, ...]
    rest: list[list[float]]  # P: the rest placement of the PN's definition geometry
    transform: list[list[float]]  # T = D P at the pose the version was built in
    motion: list[list[float]]  # D: the joint motion alone


def schema_version(document: Any, name: str) -> int:
    """1 or 2; a newer format is refused, since an older plugin cannot read it."""
    version = document.get("schema_version", 1) if isinstance(document, dict) else None
    if version not in (1, SCHEMA_VERSION):
        raise VersionError(f"{name}: schema_version {version!r} is not one this plugin reads (1 or {SCHEMA_VERSION})")
    return version


def built_occurrences(part_map: dict[str, Any], manifest: dict[str, Any],
                      legacy_groups: dict[str, str] | None = None) -> dict[str, BuiltOccurrence]:
    """Every occurrence of a version, keyed by id, in part-map order.

    Version 1 files read as one occurrence per part-map PN at the identity rest placement, with
    `legacy_groups` (PN -> subassembly id) supplying the grouping the old manifest did not record.
    """
    if schema_version(part_map, "part-map.json") != schema_version(manifest, "manifest.json"):
        raise VersionError("part-map.json and manifest.json have different schema versions")
    pose = manifest.get("pose") if isinstance(manifest.get("pose"), dict) else {}
    transforms = pose.get("transforms") or {}
    try:
        if schema_version(manifest, "manifest.json") == 1:
            groups = legacy_groups or {}
            return {pn: BuiltOccurrence(pn, pn, pn, groups.get(pn), tuple(entry["node_indices"]), IDENTITY_ROWS,
                                        transforms[pn], transforms[pn])
                    for pn, entry in part_map["parts"].items()}
        records, motions = manifest["occurrences"], pose["motions"]
        return {oid: BuiltOccurrence(oid, entry["PN"], records[oid]["ref"], records[oid].get("group"),
                                     tuple(entry["node_indices"]), records[oid]["rest"], transforms[oid], motions[oid])
                for oid, entry in part_map["occurrences"].items()}
    except (KeyError, TypeError) as error:
        raise VersionError(f"part-map.json and manifest.json disagree on the occurrences: missing {error}") from error


def built_joints(manifest: dict[str, Any], legacy_joints: list[Any]) -> list[dict[str, Any]]:
    """The version's joints with parent and child as occurrence ids; version 1 reads assembly.yaml's (PN endpoints)."""
    if schema_version(manifest, "manifest.json") == 1:
        return [j for j in legacy_joints if isinstance(j, dict)]
    joints = manifest.get("joints")
    if not isinstance(joints, list):
        raise VersionError("manifest.json: schema_version 2 without a joints list")
    return joints
