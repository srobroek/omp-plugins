"""Joint animation and section planes from cad-motion's kinematic chain; kernel-free.

cad-motion owns the joint record and its limits: `pose.py` is loaded as a module and its
`Chain` validates values and computes part transforms; `plan.py` expands a motion plan case
into frames through the same Chain. OCP is never imported here.
"""

from __future__ import annotations

import importlib.util
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any
from . import LimitError, ViewerError, record

POSE_PATH = Path(__file__).resolve().parents[3] / "cad-motion" / "scripts" / "pose.py"
PLAN_PATH = POSE_PATH.with_name("plan.py")
MODULE_NAME = "cad_motion_pose"
PLAN_MODULE_NAME = "cad_motion_plan"
IDENTITY_EPS = 1e-9


def _module(name: str, path: Path) -> ModuleType:
    """A cad-motion module, loaded once per process."""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ViewerError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def pose_module() -> ModuleType:
    """cad-motion's pose.py, loaded once per process."""
    return _module(MODULE_NAME, POSE_PATH)


def plan_module() -> ModuleType:
    """cad-motion's plan.py (motion plans and their frames), loaded once per process."""
    return _module(PLAN_MODULE_NAME, PLAN_PATH)


def load_chain(hw: Path, version: Any | None = None) -> Any:
    """The occurrence chain at record rest placements, with built-version attachments and couplings."""
    pose = pose_module()
    try:
        assembly = (pose.load_assembly(hw) if version is None
                    else pose.load_assembly(version.hw, version.record_dir))
        attachments = pose.attach_joints(version.manifest.get("attach") or [], assembly) if version else []
        joints = [*assembly.joints, *attachments]
        return pose.build_chain(joints, assembly.occurrences, couplings=assembly.couplings)
    except (pose.MotionError, record.ViewerError) as error:
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

    def summary(self, at: float | None) -> dict[str, Any]:
        """What the host reports for this animation, held at fraction `at` when given."""
        return {"joint": self.joint, "unit": self.unit, "from": self.start, "to": self.end,
                "value_at": None if at is None else self.value_at(at)}


@dataclass(frozen=True)
class CaseAnimation:
    """A motion plan case played as one clip: every independent joint the plan moves drives its parts."""

    case: str
    fps: int
    segments: tuple[str, ...]
    drivers: tuple[str, ...]
    coverage: str
    settings: tuple[dict[str, float], ...]
    times: tuple[float, ...]
    tracks: tuple[Track, ...]

    def summary(self, at: float | None) -> dict[str, Any]:
        """What the host reports for this animation; `at` names the nearest frame's joint settings."""
        frame = None if at is None else round(at * (len(self.times) - 1))
        return {"case": self.case, "fps": self.fps, "segments": list(self.segments), "drivers": list(self.drivers),
                "coverage": self.coverage, "frame_at": frame,
                "settings_at": None if frame is None else self.settings[frame]}


def _tracks(chain: Any, shown: dict[str, Any], poses: list[dict[str, float]]) -> tuple[Track, ...]:
    """Per moving occurrence, the keys that compose onto its shown placement: position + t and
    quaternion * q, so t = t_pose - t_shown and q = R_shown^-1 R_pose."""
    missing = [chain.ref(oid) for oid in chain.ids if oid not in shown]
    if missing:
        raise ViewerError(f"parts in assembly.yaml but not in the version: {missing}")
    rows: dict[str, list[tuple[tuple[float, ...], tuple[float, ...]]]] = {oid: [] for oid in chain.ids}
    for complete in poses:
        transforms = chain.transforms(complete)
        for oid in chain.ids:
            target, base = transforms[oid], shown[oid]
            turn = (base.inverse() @ target).quaternion()  # quaternion_shown * q = rotation_pose
            rows[oid].append((tuple(target.trans[i] - base.trans[i] for i in range(3)), tuple(turn)))
    return tuple(
        Track(oid, tuple(t for t, _ in keys), tuple(q for _, q in keys))
        for oid, keys in rows.items()
        if any(max(abs(c) for c in t) > IDENTITY_EPS or abs(abs(q[3]) - 1.0) > IDENTITY_EPS for t, q in keys)
    )


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
    times = tuple(seconds * i / (steps - 1) for i in range(steps))
    return AnimationPlan(joint_id, joint.unit, start, end, values, times, _tracks(chain, shown, poses))


def plan_case_animation(chain: Any, shown: dict[str, Any], hw: Path, case: str) -> CaseAnimation:
    """The frames of motion plan `case` (plan.py: `default`, generated, or hw/motion/cases/<case>/plan.yaml)
    as tracks, one key per frame at the plan's fps. Every independent joint the plan moves drives its
    parts and every coupled joint follows. Raises LimitError when a frame puts a joint outside its limits;
    a coverage gap still plays and is reported in `coverage`."""
    plan = plan_module()
    try:
        effective = plan.load(chain, hw, pose_module().LAYOUT, case)
    except plan.PlanError as error:
        raise ViewerError(f"motion plan {case}: {error}") from error
    except pose_module().LAYOUT.LayoutError as error:
        raise ViewerError(str(error)) from error
    frames = plan.expand(chain, effective)
    report = plan.coverage(chain, effective, frames)
    if report["limit_findings"]:
        raise LimitError("; ".join(dict.fromkeys(f["message"] for f in report["limit_findings"])),
                         report["limit_findings"])
    tracks = _tracks(chain, shown, [frame.values for frame in frames])
    drivers = tuple(row["joint"] for row in report["independent"] if row["segments"])
    return CaseAnimation(effective["case"], effective["fps"], tuple(s["id"] for s in effective["segments"]), drivers,
                         report["status"], tuple(dict(frame.settings) for frame in frames),
                         tuple(frame.index / effective["fps"] for frame in frames), tracks)


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
