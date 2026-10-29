"""Normalize built-version occurrence records for render, viewer and model check.

cad-record's layout owns version paths and manifests. This module only handles the occurrence
identity shared by consumers, including legacy schema-version-1 normalization.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

IDENTITY_ROWS = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]


class VersionError(RuntimeError):
    """An unsupported version manifest or inconsistent occurrence record."""


@dataclass(frozen=True)
class BuiltOccurrence:
    """One placed instance in a built version, with its GLB nodes and placements as 3x4 rows."""

    id: str
    pn: str
    ref: str
    group: str | None
    node_indices: tuple[int, ...]
    rest: list[list[float]]
    transform: list[list[float]]
    motion: list[list[float]]


def schema_version(document: Any, name: str) -> int:
    """Version 1 and schema version 2 are readable; a newer format is refused."""
    version = document.get("schema_version", 1) if isinstance(document, dict) else None
    if version not in (1, 2):
        raise VersionError(f"{name}: schema_version {version!r} is not one this plugin reads (1 or 2)")
    return version


def built_occurrences(part_map: dict[str, Any], manifest: dict[str, Any],
                      legacy_groups: dict[str, str] | None = None) -> dict[str, BuiltOccurrence]:
    """Every occurrence keyed by id; legacy v1 files normalize to one occurrence per PN."""
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
    """Joints use occurrence ids in v2; v1's assembly records use PN endpoints."""
    if schema_version(manifest, "manifest.json") == 1:
        return [joint for joint in legacy_joints if isinstance(joint, dict)]
    joints = manifest.get("joints")
    if not isinstance(joints, list):
        raise VersionError("manifest.json: schema_version 2 without a joints list")
    return joints
