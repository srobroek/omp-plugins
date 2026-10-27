"""Joint animation and section planes from cad-motion's kinematic chain; kernel-free.

cad-motion owns the joint record and its limits: `pose.py` is loaded as a module and its
`Chain` validates values and computes part transforms. OCP is never imported here.
"""

from __future__ import annotations

import importlib.util
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from . import LimitError, ViewerError

POSE_PATH = Path(__file__).resolve().parents[3] / "cad-motion" / "scripts" / "pose.py"
MODULE_NAME = "cad_motion_pose"
IDENTITY_EPS = 1e-9


def pose_module() -> ModuleType:
    """cad-motion's pose.py, loaded once per process."""
    if MODULE_NAME in sys.modules:
        return sys.modules[MODULE_NAME]
    spec = importlib.util.spec_from_file_location(MODULE_NAME, POSE_PATH)
    if spec is None or spec.loader is None:
        raise ViewerError(f"cannot load {POSE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


def load_chain(hw: Path) -> Any:
    """The occurrence chain of hw/assembly.yaml, at the record's rest placements, with its couplings."""
    pose = pose_module()
    try:
        assembly = pose.load_assembly(hw)
        return pose.build_chain(assembly.joints, assembly.occurrences, couplings=assembly.couplings)
    except pose.MotionError as error:
        raise ViewerError(str(error)) from error


def rigid_from_rows(rows: list[list[float]]) -> Any:
    """A cad-motion Rigid from 3x4 rows [rot | trans], as manifest.json `pose.transforms` stores them."""
    pose = pose_module()
    rot = tuple(tuple(float(v) for v in row[:3]) for row in rows)
    return pose.Rigid(rot, tuple(float(row[3]) for row in rows))  # type: ignore[arg-type]


@dataclass(frozen=True)
class Track:
    id: str  # occurrence id
    translations: tuple[tuple[float, float, float], ...]
    quaternions: tuple[tuple[float, float, float, float], ...]  # (x, y, z, w)


@dataclass(frozen=True)
class AnimationPlan:
    joint: str
    unit: str
    start: float
    end: float
    values: tuple[float, ...]
    times: tuple[float, ...]
    tracks: tuple[Track, ...]

    def value_at(self, fraction: float) -> float:
        return self.start + (self.end - self.start) * fraction


def plan_animation(chain: Any, shown: dict[str, Any], joint_id: str, start: float, end: float,
                   steps: int = 13, seconds: float = 4.0) -> AnimationPlan:
    """Keyframes that move each occurrence from its shown placement to the swept pose.

    `shown` maps occurrence id -> the Rigid it is displayed at. The viewer keeps that placement as the
    occurrence's group transform (position, quaternion) and composes a track onto it as position + t and
    quaternion * q, so t = t_pose - t_shown and q = R_shown^-1 R_pose. `joint_id` is an independent joint;
    the other independent joints stay at their nominal value, and every coupled joint follows its
    coupling at each keyframe, so the parts it moves get tracks too.
    Raises LimitError when `start` or `end`, or a coordinate derived from them, is outside its joint's [min, max].
    """
    pose = pose_module()
    if steps < 2:
        raise ViewerError("--steps must be at least 2")
    if not (seconds > 0 and math.isfinite(seconds)):
        raise ViewerError("--seconds must be a positive number")
    try:
        joint = chain.joint(joint_id)
    except pose.MotionError as error:
        raise ViewerError(str(error)) from error
    if not joint.movable:
        raise ViewerError(f"{joint_id} is a fixed joint; animate a movable joint: "
                          f"{[j.id for j in chain.independent]}")
    if joint_id in chain.couplings.laws:
        raise ViewerError(f"{chain.couplings.describe(joint_id)}; animate its driver, an independent joint: "
                          f"{[j.id for j in chain.independent]}")
    for value in (start, end):
        if not math.isfinite(value):
            raise ViewerError(f"{joint_id}: joint values must be finite numbers")
    values = tuple(start + (end - start) * i / (steps - 1) for i in range(steps))
    try:
        poses = [chain.complete({joint_id: value}) for value in values]
    except pose.MotionError as error:
        raise ViewerError(str(error)) from error
    findings = [f for complete in poses for f in chain.limit_findings(complete)]
    if findings:
        raise LimitError("; ".join(dict.fromkeys(f["message"] for f in findings)), findings)
    missing = [chain.ref(oid) for oid in chain.ids if oid not in shown]
    if missing:
        raise ViewerError(f"parts in assembly.yaml but not in the version: {missing}")
    times = tuple(seconds * i / (steps - 1) for i in range(steps))
    rows: dict[str, list[tuple[tuple[float, ...], tuple[float, ...]]]] = {oid: [] for oid in chain.ids}
    for complete in poses:
        transforms = chain.transforms(complete)
        for oid in chain.ids:
            target, base = transforms[oid], shown[oid]
            turn = (base.inverse() @ target).quaternion()  # quaternion_shown * q = rotation_pose
            rows[oid].append((tuple(target.trans[i] - base.trans[i] for i in range(3)), tuple(turn)))
    tracks = tuple(
        Track(oid, tuple(t for t, _ in keys), tuple(q for _, q in keys))
        for oid, keys in rows.items()
        if any(max(abs(c) for c in t) > IDENTITY_EPS or abs(abs(q[3]) - 1.0) > IDENTITY_EPS for t, q in keys)
    )
    return AnimationPlan(joint_id, joint.unit, start, end, values, times, tracks)


def section_plane(chain: Any, shown: dict[str, Any], joint_id: str) -> dict[str, Any]:
    """A cutting plane that contains `joint_id`'s axis at the shown pose.

    The normal is the world axis most perpendicular to the joint axis, orthogonalised against it;
    `point` is the joint origin, so the plane runs lengthwise through the joint pin.
    """
    pose = pose_module()
    try:
        joint = chain.joint(joint_id)
    except pose.MotionError as error:
        raise ViewerError(str(error)) from error
    parent = shown.get(joint.parent)
    if parent is None:
        raise ViewerError(f"{joint_id}: parent {chain.ref(joint.parent)} is not in the version")
    motion = parent @ chain.rests[joint.parent].inverse()  # the joint frame moves with D, not D P
    point = motion.apply(joint.origin)
    moved = motion.apply(tuple(joint.origin[i] + joint.axis[i] for i in range(3)))
    axis = tuple(moved[i] - point[i] for i in range(3))
    basis = min(((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
                key=lambda b: abs(sum(b[i] * axis[i] for i in range(3))))
    along = sum(basis[i] * axis[i] for i in range(3))
    normal = tuple(basis[i] - along * axis[i] for i in range(3))
    length = math.sqrt(sum(c * c for c in normal))
    return {"joint": joint_id, "point": list(point), "axis": list(axis),
            "normal": [c / length for c in normal]}
