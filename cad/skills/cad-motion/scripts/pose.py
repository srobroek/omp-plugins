# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Pose an assembly at given joint values and write the posed STEP AP242.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/pose.py --hw HW
        (--version vN|latest | --step ASSEMBLY.step | --parts-dir DIR)
        [--attach REF=PARENT_REF ...] [--set J-###=VALUE ...] --out POSED.step

Occurrences: hw/assembly.yaml places part definitions (PNs). An explicit
occurrence (`occurrences: [{id: ring-base, PN: LMP-0011, placement: ...}]`)
is one placement of its PN at a rest placement; a PN listed in a
subassembly's `parts` is one implicit occurrence whose id is the PN, at the
identity placement. A reference is `"@id"` for one occurrence, or a bare PN
when that PN has exactly one occurrence (cad-record assembly_data.py).

Joint record: hw/assembly.yaml `joints`, whose parent and child are
references. Supported types: revolute (values in degrees), prismatic (values
in mm) and fixed. `origin` (mm) and `axis` are in assembly coordinates at the
zero pose, where every joint value is 0.

Geometry, exactly one of:
    --version VER    a cad-model version: the per-PN definition STEPs in
                     HW/versions/<VER>/parts. `latest` is the label
                     HW/versions/latest.json names; the version must be built
                     (manifest.json present).
    --step FILE      one assembly STEP; every leaf product whose name starts
                     with a PN (`LMP-0003` or `LMP-0003 Lower link`) is a part
                     definition, read from the referred product, and each of
                     its components one placement at its cumulative location.
                     A component named `<product> [@id]` is the occurrence
                     `@id`, whose location must equal its rest placement; any
                     other component is its PN's implicit occurrence, placed
                     where the STEP puts it. A PN instanced more than once
                     without `[@id]` names is rejected. A cad-model version's
                     assembly.step is posed at the joints' nominal values;
                     when one is non-zero it is refused (its manifest.json
                     tells), since posing it again would apply the nominal
                     twice. Use --version instead.
    --parts-dir DIR  one STEP per part definition, named `<PN>.step` or
                     `<PN> <anything>.step` (`.stp` also accepted). The part
                     keeps the file's PN-first product name; an unnamed file
                     is named `<PN> <title>` from hw/parts/<PN>/part.yaml.
A part's frame is its part.yaml `model_frame`: `assembly_zero`, the default,
is modeled in place (assembly coordinates at the zero pose) and has one
identity-placed occurrence; `part_local` is modeled about its own origin, and
each occurrence's rest placement puts it into the assembly.

Kinematics: the ground is the one occurrence that is never a joint child.
Each occurrence i has a motion D_i: D_ground is the identity, and a joint
maps its child as D_child = D_parent * M(value), where M is the rotation by
`value` degrees (right hand) about `axis` through `origin` for a revolute
joint, the translation by `value` mm along `axis` for a prismatic joint, and
the identity for a fixed joint. The occurrence's placement T_i = D_i * P_i,
with P_i its rest placement, is applied once to its definition geometry.
An occurrence with geometry but no joint must be connected with a fixed joint
in assembly.yaml or `--attach REF=PARENT_REF`; attaching a PN that has no
occurrence adds its identity singleton. An independent movable joint without
`--set` takes its `nominal` value.

Couplings (coupling.py): a movable joint with a `coupling` is dependent. It
authors no `nominal`; its value derives from its driver joint through a linear
law, a periodic profile, or a slider-crank mechanism, after the independent
values are set. `--set` takes independent joints only; setting a dependent one
is a usage error. Every derived value is checked against its joint's limits.

The posed STEP holds one product per PN definition, named `<PN> <title>`,
placed once per occurrence under one top assembly; an explicit occurrence's
component is named `<PN> <title> [@id]`.

stdout: JSON. stderr: diagnostics (OCCT translator output included).
Exit 0 = posed STEP written, 1 = a value is outside its joint's [min, max]
(no STEP is written), 2 = usage or infrastructure error.
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import functools
import importlib.util
import json
import math
import os
import re
import shutil
import sys
import traceback
from collections.abc import Callable, Iterable, Iterator, Mapping
from hashlib import sha256
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PN_PREFIX = re.compile(r"^([A-Z]{2,5}-\d{4})(?![0-9])")
UNITS = {"revolute": "deg", "prismatic": "mm", "fixed": ""}
STEP_SUFFIXES = (".step", ".stp")
# Relative target of the adaptive volume integration, the one volume rule of cad-motion and cad-model.
# With BRepGProp's default fixed-order Gauss rule the in-memory and STEP read-back volumes of one valid
# fluted housing (LMP-0004) differed by 5.6e-6 relative, above the 1e-6 read-back bound; the adaptive
# rule agreed to 1.6e-11.
VOLUME_EPS = 1e-9
# The one interference rule of cad-motion `sweep` and cad-model `check` (`interference` below): a
# shared volume above INTERFERENCE_MM3 interferes. Shapes farther apart than OVERLAP_GATE_MM share
# no volume, so the Boolean is skipped. FUZZY_MM is the Boolean fuzzy value: the kernel's own
# precision, so a Boolean never glues distinct faces.
INTERFERENCE_MM3 = 1e-3
OVERLAP_GATE_MM = 1e-6
FUZZY_MM = 1e-7
# BRepExtrema_DistShapeShape's point-in-solid tolerance (its SolidTreatment, OCCT 8.0.1), which
# `interference` applies inside compounds as well. Bounding boxes farther apart than SOLID_GAP_MM
# (the tolerance plus as much again for rounding) leave no point within it of the other shape.
CONTAINMENT_TOL_MM = 1e-3
SOLID_GAP_MM = 2 * CONTAINMENT_TOL_MM
VERSION_LABEL = re.compile(r"^v([1-9][0-9]*)$")  # a cad-model version label: v1, v2, ...
# An explicit occurrence's STEP component and GLB node name: `<PN> <title> [@id]`.
OCCURRENCE_TAG = re.compile(r" \[@([a-z][a-z0-9_-]*)\]$")
# A STEP component location matches a rest placement within these bounds (mm, rotation-matrix entries).
PLACEMENT_TOL_MM, PLACEMENT_TOL_ROT = 1e-6, 1e-9
# Motion coordinates and exported STEP lengths are millimetres.
STEP_LENGTH_UNIT = "MM"
ASSEMBLY_DATA_PATH = Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "assembly_data.py"
COUPLING_PATH = Path(__file__).resolve().with_name("coupling.py")

Vec = tuple[float, float, float]


class MotionError(RuntimeError):
    """The inputs cannot be used; maps to exit 2."""


def _load_module(name: str, path: Path) -> Any:
    """A kernel-free sibling module, loaded once per process under `name`."""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"{path} not found")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


LAYOUT = _load_module("cad_record_layout", Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "layout.py")
# cad-record's occurrence normalizer, the one reader of assembly.yaml occurrences, and the coupling laws.
assembly_data = _load_module("cad_record_assembly_data", ASSEMBLY_DATA_PATH)
coupling = _load_module("cad_motion_coupling", COUPLING_PATH)

# --------------------------------------------------------------------------- rigid transforms


@dataclass(frozen=True)
class Rigid:
    """A proper rigid transform x -> rot @ x + trans (rot as rows)."""

    rot: tuple[Vec, Vec, Vec]
    trans: Vec

    @staticmethod
    def identity() -> Rigid:
        return Rigid(((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)), (0.0, 0.0, 0.0))

    @staticmethod
    def rotation(axis: Vec, degrees: float, origin: Vec) -> Rigid:
        """Right-hand rotation about the unit `axis` through `origin`."""
        x, y, z = axis
        theta = math.radians(degrees)
        c, s = math.cos(theta), math.sin(theta)
        k = 1.0 - c
        rot = (
            (c + x * x * k, x * y * k - z * s, x * z * k + y * s),
            (y * x * k + z * s, c + y * y * k, y * z * k - x * s),
            (z * x * k - y * s, z * y * k + x * s, c + z * z * k),
        )
        moved = _mat_vec(rot, origin)
        return Rigid(rot, (origin[0] - moved[0], origin[1] - moved[1], origin[2] - moved[2]))

    @staticmethod
    def translation(axis: Vec, distance: float) -> Rigid:
        return Rigid(Rigid.identity().rot, (axis[0] * distance, axis[1] * distance, axis[2] * distance))

    @staticmethod
    def from_placement(placement: Any) -> Rigid:
        """An assembly_data.Placement: rotation about the local origin, then translation."""
        rotation = Rigid.rotation(placement.axis, placement.angle_deg, (0.0, 0.0, 0.0))
        return Rigid(rotation.rot, placement.translation_mm)

    def close_to(self, other: Rigid) -> bool:
        """Equal within PLACEMENT_TOL_MM (translation) and PLACEMENT_TOL_ROT (rotation entries)."""
        return (all(abs(a - b) <= PLACEMENT_TOL_ROT for ra, rb in zip(self.rot, other.rot) for a, b in zip(ra, rb))
                and all(abs(a - b) <= PLACEMENT_TOL_MM for a, b in zip(self.trans, other.trans)))

    @staticmethod
    def from_quaternion(q: Iterable[float], base: Iterable[float]) -> Rigid:
        """Build from a unit quaternion (x, y, z, w) and a translation."""
        x, y, z, w = (float(v) for v in q)
        n = math.sqrt(x * x + y * y + z * z + w * w)
        x, y, z, w = x / n, y / n, z / n, w / n
        rot = (
            (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
            (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
            (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
        )
        bx, by, bz = (float(v) for v in base)
        return Rigid(rot, (bx, by, bz))

    def __matmul__(self, other: Rigid) -> Rigid:
        rot = tuple(
            tuple(sum(self.rot[i][k] * other.rot[k][j] for k in range(3)) for j in range(3)) for i in range(3)
        )
        moved = _mat_vec(self.rot, other.trans)
        return Rigid(rot, (moved[0] + self.trans[0], moved[1] + self.trans[1], moved[2] + self.trans[2]))  # type: ignore[arg-type]

    def inverse(self) -> Rigid:
        rt = tuple(tuple(self.rot[j][i] for j in range(3)) for i in range(3))
        moved = _mat_vec(rt, self.trans)  # type: ignore[arg-type]
        return Rigid(rt, (-moved[0], -moved[1], -moved[2]))  # type: ignore[arg-type]

    def apply(self, point: Vec) -> Vec:
        moved = _mat_vec(self.rot, point)
        return (moved[0] + self.trans[0], moved[1] + self.trans[1], moved[2] + self.trans[2])

    def angle_degrees(self) -> float:
        """Magnitude of the rotation part."""
        cosine = (self.rot[0][0] + self.rot[1][1] + self.rot[2][2] - 1.0) / 2.0
        return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))

    def quaternion(self) -> tuple[float, float, float, float]:
        """Unit quaternion (x, y, z, w) of the rotation part."""
        (a, b, c), (d, e, f), (g, h, i) = self.rot
        trace = a + e + i
        if trace > 0:
            s = 2.0 * math.sqrt(trace + 1.0)
            return ((h - f) / s, (c - g) / s, (d - b) / s, 0.25 * s)
        if a >= e and a >= i:
            s = 2.0 * math.sqrt(1.0 + a - e - i)
            return (0.25 * s, (b + d) / s, (c + g) / s, (h - f) / s)
        if e >= i:
            s = 2.0 * math.sqrt(1.0 + e - a - i)
            return ((b + d) / s, 0.25 * s, (f + h) / s, (c - g) / s)
        s = 2.0 * math.sqrt(1.0 + i - a - e)
        return ((c + g) / s, (f + h) / s, 0.25 * s, (d - b) / s)

    def rows(self, digits: int = 6) -> list[list[float]]:
        """3x4 matrix rows [rot | trans], rounded for reports."""
        return [[round(v, digits) + 0.0 for v in (*self.rot[i], self.trans[i])] for i in range(3)]


def _mat_vec(rot: tuple[Vec, Vec, Vec], v: Vec) -> Vec:
    return (
        rot[0][0] * v[0] + rot[0][1] * v[1] + rot[0][2] * v[2],
        rot[1][0] * v[0] + rot[1][1] * v[1] + rot[1][2] * v[2],
        rot[2][0] * v[0] + rot[2][1] * v[1] + rot[2][2] * v[2],
    )


def _distance(a: Vec, b: Vec) -> float:
    return math.dist(a, b)


# --------------------------------------------------------------------------- joints and chain


@dataclass(frozen=True)
class Joint:
    id: str
    type: str
    parent: str
    child: str
    axis: Vec  # unit length
    origin: Vec
    min: float
    max: float
    nominal: float | None  # None for a coupled joint: its value derives from its coupling

    @property
    def movable(self) -> bool:
        return self.type != "fixed"

    @property
    def unit(self) -> str:
        return UNITS[self.type]

    def motion(self, value: float) -> Rigid:
        """Transform of the child relative to the parent at `value`."""
        if self.type == "revolute":
            return Rigid.rotation(self.axis, value, self.origin)
        if self.type == "prismatic":
            return Rigid.translation(self.axis, value)
        return Rigid.identity()

    def measure(self, relative: Rigid) -> tuple[float, float, float]:
        """Recover (value, residual_deg, residual_mm) from inv(T_parent) @ T_child.

        The residuals measure how far `relative` is from any motion this joint
        allows: zero when the child moved only along the joint's freedom.
        """
        if self.type == "revolute":
            r = relative.rot
            vee = (r[2][1] - r[1][2], r[0][2] - r[2][0], r[1][0] - r[0][1])
            sine = sum(a * v for a, v in zip(self.axis, vee)) / 2.0
            cosine = (r[0][0] + r[1][1] + r[2][2] - 1.0) / 2.0
            value = math.degrees(math.atan2(sine, cosine))
            value += 360.0 * round(((self.min + self.max) / 2.0 - value) / 360.0)  # unwrap toward the range
        elif self.type == "prismatic":
            value = sum(a * t for a, t in zip(self.axis, relative.trans))
        else:
            value = 0.0
        residual = self.motion(value).inverse() @ relative
        return value, residual.angle_degrees(), _distance(residual.apply(self.origin), self.origin)


def independent_joints(joints: Iterable[Joint], couplings: Any) -> tuple[Joint, ...]:
    """The author-settable joints: every movable joint without a coupling."""
    return tuple(j for j in joints if j.movable and j.id not in couplings.laws)


@dataclass(frozen=True, eq=False)
class Assembly:
    """The normalized record: occurrences and groups (an assembly_data.Inventory), joints whose
    parent and child are occurrence ids, the PN definitions with their model frames, and the
    joint couplings (a coupling.Couplings)."""

    inventory: Any  # assembly_data.Inventory
    joints: tuple[Joint, ...]
    frames: Mapping[str, str]  # PN -> part.yaml model_frame, for every part record
    couplings: Any = coupling.NONE  # coupling.Couplings

    @property
    def occurrences(self) -> tuple[Any, ...]:
        return self.inventory.occurrences

    @property
    def groups(self) -> tuple[Any, ...]:
        return self.inventory.groups

    @property
    def movable(self) -> tuple[Joint, ...]:
        return tuple(j for j in self.joints if j.movable)

    @property
    def independent(self) -> tuple[Joint, ...]:
        """The record's author-settable joints, whether or not every member has a joint path to the ground."""
        return independent_joints(self.joints, self.couplings)

    @property
    def definitions(self) -> tuple[str, ...]:
        """The PNs the occurrences instantiate, in record order."""
        return self.inventory.pns

    def resolve(self, ref: str, where: str = "") -> str:
        """The occurrence id `ref` names: `@id`, or a PN with exactly one occurrence."""
        try:
            return self.inventory.resolve(ref).id
        except assembly_data.UnresolvedReference as error:
            raise MotionError(f"{where}{error}") from None

    def attachable(self, ref: str, where: str = "") -> str:
        """`resolve`, except that a PN with no occurrence names its implicit identity singleton."""
        if not ref.startswith("@") and not self.inventory.of(ref):
            return ref
        return self.resolve(ref, where)

    def pn(self, occurrence_id: str) -> str:
        """The PN of an occurrence id; an id outside the record is an implicit singleton, its own PN."""
        return self.inventory.get(occurrence_id).pn if occurrence_id in self.inventory else occurrence_id


def _vector(value: Any, where: str) -> Vec:
    if not (isinstance(value, list) and len(value) == 3 and all(_is_number(v) for v in value)):
        raise MotionError(f"{where} must be a list of three numbers")
    return (float(value[0]), float(value[1]), float(value[2]))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def make_joint(raw: Mapping[str, Any], resolve: Callable[[str, str], str] | None = None) -> Joint:
    """Validate one assembly.yaml joint mapping; `resolve(ref, where)` turns parent and child into occurrence ids.

    A joint with a `coupling` authors no `nominal` (its Joint.nominal is None); coupling.parse checks the law.
    """
    jid = raw.get("id")
    if not isinstance(jid, str):
        raise MotionError(f"joint without a string id: {raw!r}")
    kind = raw.get("type")
    if kind not in UNITS:
        raise MotionError(f"{jid}: joint type {kind!r} is not supported; use one of {sorted(UNITS)}")
    for key in ("parent", "child"):
        if not isinstance(raw.get(key), str):
            raise MotionError(f"{jid}: {key} must be a part number or @occurrence reference")
    if raw["parent"] == raw["child"]:
        raise MotionError(f"{jid}: parent and child are both {raw['parent']}")
    parent, child = raw["parent"], raw["child"]
    if resolve is not None:
        parent, child = resolve(parent, f"{jid} parent: "), resolve(child, f"{jid} child: ")
    axis = _vector(raw.get("axis"), f"{jid}.axis")
    norm = math.sqrt(sum(v * v for v in axis))
    if norm < 1e-12:
        raise MotionError(f"{jid}: axis has zero length")
    coupled = "coupling" in raw
    if coupled and "nominal" in raw:
        raise MotionError(f"{jid}: a coupled joint derives its value from its coupling; remove its nominal")
    limits: dict[str, float | None] = {"nominal": None}
    for key in ("min", "max") if coupled else ("min", "max", "nominal"):
        if not _is_number(raw.get(key)):
            raise MotionError(f"{jid}: {key} must be a number")
        limits[key] = float(raw[key])
    if limits["min"] > limits["max"]:
        raise MotionError(f"{jid}: min {limits['min']} exceeds max {limits['max']}")
    if not coupled and not limits["min"] <= limits["nominal"] <= limits["max"]:
        raise MotionError(f"{jid}: nominal {limits['nominal']} is outside [{limits['min']}, {limits['max']}]")
    return Joint(
        id=jid, type=kind, parent=parent, child=child,
        axis=(axis[0] / norm, axis[1] / norm, axis[2] / norm),
        origin=_vector(raw.get("origin"), f"{jid}.origin"), **limits,
    )


def _part_records(hw: Path) -> dict[str, dict[str, Any]]:
    """Read the selected record's part metadata, keyed by part number directory."""
    import yaml

    records = {}
    for record in sorted((hw / "parts").glob("*/part.yaml")):
        try:
            data = yaml.safe_load(record.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(data, dict):
            records[record.parent.name] = data
    return records
def load_assembly(hw: Path, record_hw: Path | None = None) -> Assembly:
    """Normalize the selected assembly and the same-state part metadata."""
    import yaml

    record_hw = record_hw or hw
    path = record_hw / "assembly.yaml"
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise MotionError(f"cannot read {path}: {error}") from error
    if not isinstance(data, dict) or not isinstance(data.get("joints"), list):
        raise MotionError(f"{path}: expected a mapping with a `joints` list")
    frames = {pn: str(record.get("model_frame", assembly_data.DEFAULT_FRAME))
              for pn, record in _part_records(record_hw).items()}
    try:
        inventory = assembly_data.normalize(data, frames)
    except assembly_data.InventoryError as error:
        raise MotionError(f"{path}: {error}") from None
    assembly = Assembly(inventory, (), frames)
    joints = tuple(make_joint(raw, assembly.attachable) if isinstance(raw, dict) else _bad_joint(raw)
                   for raw in data["joints"])
    ids = [joint.id for joint in joints]
    duplicates = sorted({joint_id for joint_id in ids if ids.count(joint_id) > 1})
    if duplicates:
        raise MotionError(f"{path}: duplicate joint ids {duplicates}")
    try:
        couplings = coupling.parse(data)
    except coupling.CouplingError as error:
        raise MotionError(f"{path}: {error}") from None
    return Assembly(inventory, joints, frames, couplings)



def _bad_joint(raw: Any) -> Joint:
    raise MotionError(f"joint entry is not a mapping: {raw!r}")


def is_ref(text: str) -> bool:
    """A reference: a PN exactly, or `@` and an occurrence id."""
    return bool(PN_PREFIX.fullmatch(text) or (text.startswith("@") and assembly_data.OCCURRENCE_ID.fullmatch(text[1:])))


def attach_joints(specs: Iterable[str], assembly: Assembly) -> list[Joint]:
    """Turn `REF=PARENT_REF` options into fixed joints between occurrence ids.

    A PN with no occurrence names its identity singleton, an otherwise unlisted built part; a PN
    placed several times must be named by `@id`.
    """
    joints = []
    for spec in specs:
        child, sep, parent = spec.partition("=")
        if not sep or not is_ref(child) or not is_ref(parent):
            raise MotionError(f"--attach expects REF=PARENT_REF (a PN or @occurrence each), got {spec!r}")
        where = f"--attach {spec}: "
        joints.append(Joint(f"attach:{child}", "fixed", assembly.attachable(parent, where),
                            assembly.attachable(child, where), (0.0, 0.0, 1.0), (0.0, 0.0, 0.0), 0.0, 0.0, 0.0))
    return joints


def singleton(pn: str) -> Any:
    """A PN's implicit occurrence record: id PN, identity placement."""
    return assembly_data.Occurrence(pn, pn, assembly_data.IDENTITY, False)


@dataclass(frozen=True, eq=False)
class Chain:
    """A kinematic tree of occurrences rooted at the ground occurrence; joints are parent-before-child.

    `inventory` holds the chain's occurrence records (id, PN, explicit); `rests` their rest
    placements P_i, which an assembly STEP input may supply for implicit occurrences; `couplings`
    the laws of its dependent joints.
    """

    root: str
    joints: tuple[Joint, ...]
    inventory: Any  # assembly_data.Inventory of the chain's occurrences
    rests: Mapping[str, Rigid]
    couplings: Any = coupling.NONE  # coupling.Couplings

    @property
    def ids(self) -> tuple[str, ...]:
        """Occurrence ids: the ground, then each joint's child in tree order."""
        return (self.root, *(j.child for j in self.joints))

    def pn(self, occurrence_id: str) -> str:
        return self.inventory.get(occurrence_id).pn

    def ref(self, occurrence_id: str) -> str:
        """The copyable reference: `@id`, or the PN of an implicit singleton."""
        return self.inventory.get(occurrence_id).ref

    def resolve(self, ref: str, where: str = "") -> str:
        """The chain occurrence id `ref` names; a PN placed more than once is ambiguous."""
        try:
            return self.inventory.resolve(ref).id
        except assembly_data.UnresolvedReference as error:
            raise MotionError(f"{where}{error}") from None

    @property
    def movable(self) -> tuple[Joint, ...]:
        return tuple(j for j in self.joints if j.movable)

    @property
    def independent(self) -> tuple[Joint, ...]:
        """The author-settable joints: every movable joint without a coupling."""
        return independent_joints(self.joints, self.couplings)

    @property
    def dependent(self) -> tuple[Joint, ...]:
        """The coupled joints, in chain order; `complete` derives their values."""
        return tuple(j for j in self.movable if j.id in self.couplings.laws)

    def joint(self, jid: str) -> Joint:
        for joint in self.joints:
            if joint.id == jid:
                return joint
        raise MotionError(f"unknown joint {jid}")

    def adjacent_pairs(self) -> set[frozenset[str]]:
        return {frozenset((j.parent, j.child)) for j in self.joints}

    def path(self, occurrence_id: str) -> list[Joint]:
        """Joints from the root to `occurrence_id`."""
        incoming = {j.child: j for j in self.joints}
        path: list[Joint] = []
        while occurrence_id in incoming:
            path.append(incoming[occurrence_id])
            occurrence_id = incoming[occurrence_id].parent
        return path[::-1]

    def complete(self, settings: Mapping[str, float]) -> dict[str, float]:
        """The full coordinate map, in chain order: the independent joints at `settings`, the others at
        nominal, then every dependent joint derived through its coupling. Setting a dependent joint is refused."""
        independent = {j.id for j in self.independent}
        for jid in settings:
            if jid in self.couplings.laws:
                raise MotionError(f"{self.couplings.describe(jid)} and cannot be set; set an independent joint: "
                                  f"{sorted(independent)}")
            if jid not in independent:
                raise MotionError(f"{jid} is not a movable joint; movable joints: {sorted(independent)}")
        values = {j.id: float(settings.get(j.id, j.nominal)) for j in self.independent}
        try:
            derived = self.couplings.derive(values)
        except coupling.CouplingError as error:
            raise MotionError(str(error)) from None
        return {j.id: derived[j.id] for j in self.movable}

    def limit_findings(self, values: Mapping[str, float]) -> list[dict[str, Any]]:
        """A joint_limit finding per joint outside [min, max]; a derived value may pass a limit by
        coupling.LIMIT_EPS, its rounding."""
        findings = []
        for joint in self.movable:
            value = values[joint.id]
            derived = joint.id in self.couplings.laws
            slack = coupling.LIMIT_EPS if derived else 0.0
            if not joint.min - slack <= value <= joint.max + slack:
                via = f" (derived: {self.couplings.describe(joint.id)})" if derived else ""
                findings.append({
                    "check": "joint_limit", "joint": joint.id, "value": value,
                    "min": joint.min, "max": joint.max, "unit": joint.unit,
                    "message": f"{joint.id} value {value} {joint.unit} is outside [{joint.min}, {joint.max}]{via}",
                })
        return findings

    def motions(self, values: Mapping[str, float]) -> dict[str, Rigid]:
        """D_i per occurrence id: the joint motions from the ground, without rest placements."""
        moved = {self.root: Rigid.identity()}
        for joint in self.joints:
            value = values[joint.id] if joint.movable else 0.0
            moved[joint.child] = moved[joint.parent] @ joint.motion(value)
        return moved

    def transforms(self, values: Mapping[str, float]) -> dict[str, Rigid]:
        """T_i = D_i P_i per occurrence id: the placement of its definition geometry at `values` (a full map)."""
        return {occurrence_id: motion @ self.rests[occurrence_id] for occurrence_id, motion in self.motions(values).items()}

    def relative_transforms(self, values: Mapping[str, float],
                            pairs: Iterable[tuple[str, str]]) -> dict[tuple[str, str], Rigid]:
        """T_a^-1 T_b per occurrence pair (a, b) at `values` (a full map), composed from the pair's
        lowest common ancestor down: (M_a P_a)^-1 (M_b P_b), with M_i the joint motions from the
        ancestor to i. The joints above the ancestor move a and b alike and cancel, so they are left
        out: a pair whose own joints keep their values keeps the bits of its placement, whatever the
        rest of the chain does, and an exact measurement key finds every such repeat."""
        incoming = {j.child: j for j in self.joints}
        lineage: dict[str, list[Joint]] = {}
        composed: dict[tuple[int, str], Rigid] = {}  # (ancestor depth, i) -> M_i P_i

        def joints_to(oid: str) -> list[Joint]:
            if oid not in lineage:
                lineage[oid] = joints_to(incoming[oid].parent) + [incoming[oid]] if oid in incoming else []
            return lineage[oid]

        def from_ancestor(oid: str, depth: int) -> Rigid:
            if (depth, oid) not in composed:
                motion = None
                for joint in joints_to(oid)[depth:]:
                    step = joint.motion(values[joint.id] if joint.movable else 0.0)
                    motion = step if motion is None else motion @ step
                composed[(depth, oid)] = self.rests[oid] if motion is None else motion @ self.rests[oid]
            return composed[(depth, oid)]

        relative = {}
        for a, b in pairs:
            path_a, path_b = joints_to(a), joints_to(b)
            depth = 0
            while depth < min(len(path_a), len(path_b)) and path_a[depth] is path_b[depth]:
                depth += 1
            relative[(a, b)] = from_ancestor(a, depth).inverse() @ from_ancestor(b, depth)
        return relative


def build_chain(joints: Iterable[Joint], occurrences: Iterable[Any] = (),
                rests: Mapping[str, Rigid] | None = None, couplings: Any = coupling.NONE) -> Chain:
    """Order the joints into a tree over the joint endpoints plus `occurrences`.

    An occurrence is an assembly_data.Occurrence or a PN, which stands for its implicit singleton;
    so is a joint endpoint that is not among `occurrences`. `rests` overrides record placements.
    `couplings` (coupling.parse of the same record) must couple movable joints of `joints` only.
    """
    joints = list(joints)
    movable = {j.id for j in joints if j.movable}
    strays = sorted({n for jid, law in couplings.laws.items() for n in (jid, law.driver)} - movable)
    if strays:
        raise MotionError(f"couplings name joints that are not movable joints of this chain: {strays}")
    unbound = sorted(j.id for j in joints if j.movable and j.nominal is None and j.id not in couplings.laws)
    if unbound:
        raise MotionError(f"coupled joints {unbound} need the record's couplings (pass Assembly.couplings)")
    records: dict[str, Any] = {}
    for item in occurrences:
        record = singleton(item) if isinstance(item, str) else item
        records[record.id] = record
    for joint in joints:
        for node in (joint.parent, joint.child):
            if node not in records:
                if not PN_PREFIX.fullmatch(node):
                    raise MotionError(f"{joint.id}: {node!r} is no occurrence of this assembly")
                records[node] = singleton(node)
    order = list(dict.fromkeys([*(n for j in joints for n in (j.parent, j.child)), *records]))
    inventory = assembly_data.Inventory(tuple(records[n] for n in order))
    try:
        root, indices = assembly_data.joint_tree([(j.id, j.parent, j.child) for j in joints], order,
                                                 lambda node: inventory.get(node).ref)
    except assembly_data.InventoryError as error:
        raise MotionError(str(error)) from None
    placed = {n: rests[n] if rests is not None and n in rests else Rigid.from_placement(records[n].placement)
              for n in order}
    return Chain(root, tuple(joints[i] for i in indices), inventory, placed, couplings)


def parse_values(specs: Iterable[str]) -> dict[str, float]:
    values: dict[str, float] = {}
    for spec in specs:
        jid, sep, text = spec.partition("=")
        try:
            value = float(text)
        except ValueError:
            value = math.nan
        if not sep or not math.isfinite(value):
            raise MotionError(f"--set expects J-###=NUMBER, got {spec!r}")
        values[jid] = value
    return values


# --------------------------------------------------------------------------- STEP geometry (OCP)


@dataclass(frozen=True)
class Part:
    """One part definition: the geometry every occurrence of `pn` places."""

    pn: str
    name: str  # STEP product name, PN first
    shape: Any  # TopoDS_Shape in the PN's model frame, unlocated


@dataclass(frozen=True)
class Component:
    """One placed instance of a definition in an assembly STEP."""

    pn: str
    occurrence: str | None  # the id an `<product> [@id]` component name carries
    name: str  # the component's own name, or the product name when it has none
    location: Rigid  # cumulative from the STEP root
    path: tuple[str, ...]  # product names from the root assembly down to the definition


@dataclass(frozen=True)
class StepAssembly:
    """An assembly STEP read once: definitions by PN, separate from their cumulative placements."""

    definitions: dict[str, Part]
    components: tuple[Component, ...]


def component_name(part: Part, occurrence: Any) -> str | None:
    """The STEP component (and GLB node) name of an occurrence: `<product> [@id]`; None for a legacy singleton."""
    return f"{part.name} [@{occurrence.id}]" if occurrence.explicit else None


@contextlib.contextmanager
def stdout_to_stderr() -> Iterator[None]:
    """Route OCCT's console output away from the JSON channel.

    OCCT prints through C stdio, which holds the bytes when stdout is a pipe (fully buffered), so
    the buffers are flushed on both sides of the swap: what OCCT prints inside reaches stderr, not
    fd 1 at exit after the JSON."""
    _flush_stdout()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        yield
    finally:
        _flush_stdout()
        os.dup2(saved, 1)
        os.close(saved)


def _flush_stdout() -> None:
    sys.stdout.flush()
    _c_library().fflush(None)  # NULL: every C stdio output stream


@functools.cache
def _c_library() -> ctypes.CDLL:
    return ctypes.CDLL(None) if os.name == "posix" else ctypes.CDLL("ucrtbase")


def to_trsf(rigid: Rigid) -> Any:
    from OCP.gp import gp_Trsf

    trsf = gp_Trsf()
    (a, b, c), (d, e, f), (g, h, i) = rigid.rot
    x, y, z = rigid.trans
    trsf.SetValues(a, b, c, x, d, e, f, y, g, h, i, z)
    return trsf


def placed(shape: Any, rigid: Rigid) -> Any:
    """`shape` moved by `rigid`, sharing its geometry."""
    from OCP.TopLoc import TopLoc_Location

    return shape.Moved(TopLoc_Location(to_trsf(rigid)))


def volume_properties(shape: Any) -> Any:
    """`GProp_GProps` of `shape`'s volume (Mass, CentreOfMass), integrated adaptively to VOLUME_EPS."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props, VOLUME_EPS, False)
    return props


def shape_list(shapes: Iterable[Any]) -> Any:
    """An OCP list of shapes for the Boolean argument and tool setters."""
    try:  # OCP 8.0 binds NCollection lists under OCP.collections and drops TopTools_ListOfShape
        from OCP.collections import List_TopoDS_Shape as ShapeList
    except ImportError:  # OCP 7.9
        from OCP.TopTools import TopTools_ListOfShape as ShapeList

    result = ShapeList()
    for shape in shapes:
        result.Append(shape)
    return result


def _vertex_points(shape: Any) -> list[Any]:
    """The located points of `shape`'s vertices."""
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_VERTEX
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    points, explorer = [], TopExp_Explorer(shape, TopAbs_VERTEX)
    cast = getattr(TopoDS, "Vertex_s", None) or TopoDS.Vertex  # OCP 7.9 static vs OCP 8 namespace function
    while explorer.More():
        points.append(BRep_Tool.Pnt_s(cast(explorer.Current())))
        explorer.Next()
    return points


def _inside_compound(container: Any, other: Any) -> bool:
    """Whether a vertex of `other` lies inside a solid of the COMPOUND `container`.

    BRepExtrema_DistShapeShape detects containment only against a SOLID or COMPSOLID operand: its
    SolidTreatment classifies every vertex of the other operand against that solid, at
    CONTAINMENT_TOL_MM, and reports distance 0 for a vertex IN. Against a COMPOUND it measures the
    boundaries alone, so a part buried in a compound part, no faces touching, reads as clear. This
    is the same classification per solid of the compound; a solid whose bounding box holds none of
    the vertices cannot hold one IN.
    """
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_IN, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    points = _vertex_points(other)
    explorer = TopExp_Explorer(container, TopAbs_SOLID)
    while explorer.More():
        solid = explorer.Current()
        box = Bnd_Box()
        BRepBndLib.Add_s(solid, box, False)
        box.Enlarge(CONTAINMENT_TOL_MM)
        candidates = [point for point in points if not box.IsOut(point)]
        if candidates:
            classifier = BRepClass3d_SolidClassifier(solid)
            for point in candidates:
                classifier.Perform(point, CONTAINMENT_TOL_MM)
                if classifier.State() == TopAbs_IN:
                    return True
        explorer.Next()
    return False


def _contained(shape_a: Any, shape_b: Any) -> bool:
    """Whether one shape lies inside a solid of the other where BRepExtrema does not look: inside a
    COMPOUND operand (`_inside_compound`)."""
    from OCP.TopAbs import TopAbs_COMPOUND

    return ((shape_a.ShapeType() == TopAbs_COMPOUND and _inside_compound(shape_a, shape_b))
            or (shape_b.ShapeType() == TopAbs_COMPOUND and _inside_compound(shape_b, shape_a)))


def _one_member_compound(shape: Any) -> Any:
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    compound, builder = TopoDS_Compound(), BRep_Builder()
    builder.MakeCompound(compound)
    builder.Add(compound, shape)
    return compound


def interference(shape_a: Any, shape_b: Any, box_gap: float = 0.0, threads: bool = False) -> tuple[float, float]:
    """(minimum distance mm, shared volume mm^3) of two shapes in one frame.

    The distance is BRepExtrema's between the boundaries, and 0 when one shape lies inside the
    other: BRepExtrema finds that inside a SOLID or COMPSOLID, `_contained` inside a solid of a
    COMPOUND. The shared volume is the Boolean common, run non-destructively (the inputs, which posed parts
    share with every other pose, keep their tolerances) with fuzzy value FUZZY_MM, and measured with
    `volume_properties`; it is 0 without a Boolean when the shapes are farther apart than
    OVERLAP_GATE_MM. A shared volume above INTERFERENCE_MM3 is interference.

    `box_gap` is a lower bound the caller proved on the distance between the shapes' bounding boxes
    (0: unknown). Beyond SOLID_GAP_MM no vertex of either shape lies within CONTAINMENT_TOL_MM of the
    other, so containment is not looked for: b goes to BRepExtrema as a one-member COMPOUND, for
    which it skips its vertex-in-solid classification and measures the same boundary distance.

    `threads` lets BRepExtrema search on OCCT's thread pool. The value does not change: on and off
    were bitwise equal on every measured pair, the cad-motion tests among them. Worth it only in a
    process that has the cores to itself.
    """
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    apart = box_gap > SOLID_GAP_MM
    extrema = BRepExtrema_DistShapeShape()
    extrema.SetMultiThread(threads)
    extrema.LoadS1(shape_a)
    extrema.LoadS2(_one_member_compound(shape_b) if apart else shape_b)
    extrema.Perform()
    if not extrema.IsDone():
        raise MotionError("distance computation failed")
    distance = extrema.Value()
    if distance > OVERLAP_GATE_MM and not apart and _contained(shape_a, shape_b):
        distance = 0.0
    if distance > OVERLAP_GATE_MM:
        return distance, 0.0
    common = BRepAlgoAPI_Common()
    common.SetArguments(shape_list([shape_a]))
    common.SetTools(shape_list([shape_b]))
    common.SetNonDestructive(True)
    common.SetFuzzyValue(FUZZY_MM)
    common.Build()
    if not common.IsDone():  # Build leaves it not done on any kernel error
        raise MotionError("interference computation failed")
    return distance, max(0.0, volume_properties(common.Shape()).Mass())


def _read_single(path: Path) -> Any:
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_Reader

    with stdout_to_stderr():
        reader = STEPControl_Reader()
        if reader.ReadFile(str(path)) != IFSelect_RetDone:
            raise MotionError(f"cannot read STEP file {path}")
        reader.TransferRoots()
        shape = reader.OneShape()
    if shape.IsNull():
        raise MotionError(f"{path} holds no shape")
    return shape


def rigid_from_trsf(trsf: Any, where: str) -> Rigid:
    """A gp_Trsf as Rigid; a scaled or mirrored location is refused."""
    if abs(trsf.ScaleFactor() - 1.0) > 1e-9:
        raise MotionError(f"{where}: a component location with scale {trsf.ScaleFactor()} is not a rigid placement")
    rows = [[trsf.Value(r, c) for c in range(1, 5)] for r in range(1, 4)]
    return Rigid(tuple(tuple(row[:3]) for row in rows), tuple(row[3] for row in rows))  # type: ignore[arg-type]


def read_assembly_step(path: Path) -> StepAssembly:
    """Read an assembly STEP through XCAF: each PN's definition from its referred product label, and
    every component placing it, with its cumulative location and its product path from the root.

    A leaf product whose name does not start with a PN is ignored. Two different products named
    with one PN are refused: a PN is one definition.
    """
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopLoc import TopLoc_Location
    from OCP.XCAFApp import XCAFApp_Application
    from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ShapeTool
    from OCP.collections import Sequence_TDF_Label

    with stdout_to_stderr():
        doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
        XCAFApp_Application.GetApplication_s().InitDocument(doc)
        reader = STEPCAFControl_Reader()
        reader.SetNameMode(True)
        if reader.ReadFile(str(path)) != IFSelect_RetDone:
            raise MotionError(f"cannot read STEP file {path}")
        if not reader.Transfer(doc):
            raise MotionError(f"STEP transfer failed for {path}")
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def name(label: Any) -> str:
        attribute = TDataStd_Name()
        return attribute.Get().ToExtString() if label.FindAttribute(TDataStd_Name.GetID_s(), attribute) else ""

    definitions: dict[str, Part] = {}
    labels: dict[str, Any] = {}
    components: list[Component] = []

    def visit(label: Any, location: Any, trail: tuple[str, ...], instance: Any) -> None:
        if XCAFDoc_ShapeTool.IsAssembly_s(label):
            children = Sequence_TDF_Label()
            XCAFDoc_ShapeTool.GetComponents_s(label, children, False)
            for index in range(1, children.Length() + 1):
                component = children.Value(index)
                referred = TDF_Label()
                if XCAFDoc_ShapeTool.GetReferredShape_s(component, referred):
                    visit(referred, location.Multiplied(XCAFDoc_ShapeTool.GetLocation_s(component)),
                          (*trail, name(label)), component)
            return
        product = name(label)
        match = PN_PREFIX.match(product)
        if not match:
            return
        pn = match.group(1)
        if pn not in definitions:
            definitions[pn] = Part(pn, product, XCAFDoc_ShapeTool.GetShape_s(label))
            labels[pn] = label
        elif not labels[pn].IsEqual(label):
            raise MotionError(f"{path}: {pn} names two different product definitions")
        own = name(instance) if instance is not None else ""
        tag = OCCURRENCE_TAG.search(own)
        components.append(Component(pn, tag.group(1) if tag else None, own if tag else product,
                                    rigid_from_trsf(location.Transformation(), f"{path}: {product}"), trail))

    roots = Sequence_TDF_Label()
    tool.GetFreeShapes(roots)
    for index in range(1, roots.Length() + 1):
        visit(roots.Value(index), TopLoc_Location(), (), None)
    return StepAssembly(definitions, tuple(components))


def load_definitions(hw: Path, parts_dir: Path, record_hw: Path | None = None) -> dict[str, Part]:
    """Part definitions keyed by PN from one STEP per part."""
    if not parts_dir.is_dir():
        raise MotionError(f"parts directory not found: {parts_dir}")
    records = _part_records(record_hw or hw)
    found: dict[str, Part] = {}
    for path in sorted(parts_dir.iterdir()):
        match = PN_PREFIX.match(path.stem)
        if path.suffix.lower() not in STEP_SUFFIXES or not match:
            continue
        pn = match.group(1)
        if pn in found:
            raise MotionError(f"{parts_dir}: more than one STEP file for {pn}")
        named = read_assembly_step(path)
        if set(named.definitions) == {pn}:
            if len(named.components) != 1:
                raise MotionError(f"{path}: places {pn} {len(named.components)} times; a part STEP holds one definition")
            part, location = named.definitions[pn], named.components[0].location
            if location != Rigid.identity():  # a located single product keeps its in-file position
                from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform

                part = Part(pn, part.name, BRepBuilderAPI_Transform(part.shape, to_trsf(location), True).Shape())
            found[pn] = part  # the file's own product name, PN first
        elif not named.definitions:
            title = records.get(pn, {}).get("title")
            found[pn] = Part(pn, f"{pn} {title}" if isinstance(title, str) else pn, _read_single(path))
        else:
            raise MotionError(f"{path}: holds products of {sorted(named.definitions)}, expected only {pn}")
    return found


def bind_components(assembly: Assembly, step: StepAssembly, source: Path) -> dict[str, Rigid]:
    """Occurrence id -> the location of the STEP component that is that occurrence.

    A component named `<product> [@id]` is the explicit occurrence `@id`; an untagged component is
    its PN's implicit singleton, so a PN instanced more than once without tags is refused.
    """
    untagged: dict[str, int] = {}
    for component in step.components:
        if component.occurrence is None:
            untagged[component.pn] = untagged.get(component.pn, 0) + 1
    located: dict[str, Rigid] = {}
    for component in step.components:
        if component.occurrence is not None:
            occurrence = assembly.inventory.get(component.occurrence) if component.occurrence in assembly.inventory else None
            if occurrence is None or not occurrence.explicit or occurrence.pn != component.pn:
                raise MotionError(f"{source}: component {component.name!r} names no occurrence of {component.pn} "
                                  "in assembly.yaml")
            if occurrence.id in located:
                raise MotionError(f"{source}: occurrence {occurrence.ref} is instanced more than once")
            located[occurrence.id] = component.location
            continue
        if untagged[component.pn] > 1:
            raise MotionError(f"{source}: {component.pn} is instanced more than once without [@id] component names; "
                              "a posed part needs one instance per occurrence")
        explicit = [o.ref for o in assembly.inventory.of(component.pn) if o.explicit]
        if explicit:
            raise MotionError(f"{source}: a {component.pn} component carries no [@id] name, but assembly.yaml "
                              f"places {component.pn} as {', '.join(explicit)}")
        located[component.pn] = component.location
    return located


def assembly_chain(assembly: Assembly, definitions: Mapping[str, Part], extra_joints: Iterable[Joint] = (),
                   located: Mapping[str, Rigid] | None = None) -> Chain:
    """The chain over every occurrence that has geometry or a joint.

    A built PN with no occurrence is its identity singleton, which must then be attached. Rest
    placements come from the record; with `located` (an assembly STEP's bound components), an
    explicit occurrence must sit at its rest placement, and an implicit one rests where the STEP
    puts it.
    """
    joints = [*assembly.joints, *extra_joints]
    used = {n for j in joints for n in (j.parent, j.child)}
    inventory = assembly.inventory.extended([*definitions, *sorted(n for n in used if n not in assembly.inventory)])
    nodes = [o for o in inventory.occurrences if o.pn in definitions or o.id in used]
    rests: dict[str, Rigid] = {}
    for occurrence in nodes:
        record = Rigid.from_placement(occurrence.placement)
        if located is None or occurrence.pn not in definitions:
            rests[occurrence.id] = record
        elif occurrence.id not in located:
            raise MotionError(f"the assembly STEP has no component for {occurrence.ref}")
        elif occurrence.explicit and not located[occurrence.id].close_to(record):
            raise MotionError(f"the assembly STEP places {occurrence.ref} at {located[occurrence.id].rows()}, "
                              f"not at its rest placement {record.rows()}")
        else:
            rests[occurrence.id] = record if occurrence.explicit else located[occurrence.id]
    return build_chain(joints, nodes, rests, assembly.couplings)


def require_geometry(chain: Chain, definitions: Mapping[str, Part]) -> None:
    missing = [chain.ref(i) for i in chain.ids if chain.pn(i) not in definitions]
    if missing:
        raise MotionError(f"joint parts without geometry: {missing}")


def _new_document() -> tuple[Any, Any]:
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFApp import XCAFApp_Application
    from OCP.XCAFDoc import XCAFDoc_DocumentTool

    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    XCAFApp_Application.GetApplication_s().InitDocument(doc)
    return doc, XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())


def _set_name(label: Any, text: str) -> None:
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name

    TDataStd_Name.Set_s(label, TCollection_ExtendedString(text))


def _write_document(path: Path, doc: Any, tool: Any) -> None:
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.STEPCAFControl import STEPCAFControl_Controller, STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Controller
    from OCP.XSControl import XSControl_WorkSession

    tool.UpdateAssemblies()
    path.parent.mkdir(parents=True, exist_ok=True)
    with stdout_to_stderr():
        STEPCAFControl_Controller.Init_s()
        STEPControl_Controller.Init_s()
        for key, value in (("write.step.schema", "AP242DIS"), ("write.step.unit", STEP_LENGTH_UNIT)):
            if not Interface_Static.SetCVal_s(key, value):
                raise MotionError(f"cannot select {key}={value}")
        writer = STEPCAFControl_Writer(XSControl_WorkSession(), False)
        writer.SetNameMode(True)
        writer.SetColorMode(True)
        if not writer.Transfer(doc, STEPControl_AsIs) or writer.Write(str(path)) != IFSelect_RetDone:
            raise MotionError(f"cannot write {path}")


def write_part_step(path: Path, part: Part) -> None:
    """Write AP242 with one free product, the definition named `part.name`, in its own frame."""
    doc, tool = _new_document()
    _set_name(tool.AddShape(part.shape, False), part.name)
    _write_document(path, doc, tool)


def write_assembly_step(path: Path, top_name: str, definitions: Mapping[str, Part], occurrences: Iterable[Any],
                        placements: Mapping[str, Rigid]) -> None:
    """Write AP242: one product per PN definition and, under the top product `top_name`, one component per
    occurrence at `placements[occurrence.id]`. An explicit occurrence's component is named `<product> [@id]`."""
    from OCP.TopLoc import TopLoc_Location

    doc, tool = _new_document()
    top = tool.NewShape()
    _set_name(top, top_name)
    labels: dict[str, Any] = {}
    for occurrence in occurrences:
        part = definitions[occurrence.pn]
        if occurrence.pn not in labels:
            labels[occurrence.pn] = tool.AddShape(part.shape, False)
            _set_name(labels[occurrence.pn], part.name)
        component = tool.AddComponent(top, labels[occurrence.pn], TopLoc_Location(to_trsf(placements[occurrence.id])))
        tag = component_name(part, occurrence)
        if tag is not None:
            _set_name(component, tag)
    _write_document(path, doc, tool)


def product_id(hw: Path) -> str:
    import yaml

    try:
        data = yaml.safe_load((hw / "product.yaml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return "assembly"
    return str(data["id"]) if isinstance(data, dict) and data.get("id") else "assembly"


def write_posed(path: Path, hw: Path, chain: Chain, definitions: Mapping[str, Part],
                values: Mapping[str, float]) -> dict[str, Rigid]:
    """Write the posed assembly STEP at the full coordinate map `values`; return the occurrence placements."""
    transforms = chain.transforms(values)
    write_assembly_step(path, f"{product_id(hw)} posed", definitions, (chain.inventory.get(i) for i in chain.ids),
                        transforms)
    return transforms


# --------------------------------------------------------------------------- CLI


def _version(text: str) -> str:
    if text != "latest" and not VERSION_LABEL.match(text):
        raise argparse.ArgumentTypeError(f"expected vN or latest, got {text!r}")
    return text


def add_geometry_arguments(parser: argparse.ArgumentParser) -> None:
    """Options shared by the cad-motion scripts."""
    parser.add_argument("--hw", type=Path, required=True, help="hardware design record directory (hw/)")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--version", type=_version, metavar="vN|latest",
                        help="cad-model version whose parts/<PN>.step definitions to use")
    source.add_argument("--step", type=Path, help="zero-pose assembly STEP with PN-first product names")
    source.add_argument("--parts-dir", type=Path, help="directory with one <PN>.step definition per part")
    parser.add_argument("--attach", action="append", default=[], metavar="REF=PARENT_REF",
                        help="rigidly attach an occurrence without a joint (a PN or @id) to a parent (repeatable)")


def version_parts_dir(hw: Path, version: str, version_folder: Path | None = None) -> Path:
    """The verified zero-pose per-part STEP folder of a built cad-model version."""
    if version_folder is None:
        _, version_folder, _ = LAYOUT.built_version(hw, version)
    return version_folder / "parts"


def input_sha256(version_folder: Path) -> str:
    """Hash the verified version manifest, which inventories the record and geometry inputs."""
    return sha256((version_folder / "manifest.json").read_bytes()).hexdigest()

def refuse_posed_version_step(step: Path) -> None:
    """Refuse a cad-model version's assembly.step posed away from the zero pose.

    `cad_model.py run` writes assembly.step at the joints' nominal values and records them in the
    sibling manifest.json; posing that file again would apply the nominal twice.
    """
    manifest = step.parent / "manifest.json"
    if step.name != "assembly.step" or not manifest.is_file():
        return
    try:
        values = json.loads(manifest.read_text(encoding="utf-8"))["pose"]["values"]
        moved = {jid: value for jid, value in values.items() if value != 0}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return  # not a cad-model manifest
    if moved:
        label = step.parent.name
        raise MotionError(
            f"{step} is cad-model's assembly.step, posed at the nominal {moved}, not the zero pose; "
            f"use --version {label} or --parts-dir {step.parent / 'parts'}"
        )


def load_inputs(args: argparse.Namespace) -> tuple[Assembly, Chain, dict[str, Part]]:
    """Read the selected version's immutable assembly and part-record snapshot."""
    record_hw = getattr(args, "record_hw", args.hw)
    assembly = load_assembly(args.hw, record_hw)
    located = None
    if args.step is not None:
        refuse_posed_version_step(args.step)
        if not args.step.is_file():
            raise MotionError(f"STEP file not found: {args.step}")
        step = read_assembly_step(args.step)
        definitions, located = step.definitions, bind_components(assembly, step, args.step)
    else:
        parts_dir = (version_parts_dir(args.hw, args.version, getattr(args, "version_dir", None))
                     if args.version else args.parts_dir)
        definitions = load_definitions(args.hw, parts_dir, record_hw)
    if not definitions:
        raise MotionError("no part geometry found; product or file names must start with a PN")
    chain = assembly_chain(assembly, definitions, attach_joints(args.attach, assembly), located)
    require_geometry(chain, definitions)
    return assembly, chain, definitions


def placements_report(chain: Chain, transforms: Mapping[str, Rigid]) -> dict[str, list[list[float]]]:
    """3x4 placement rows per occurrence id."""
    return {occurrence_id: transforms[occurrence_id].rows() for occurrence_id in chain.ids}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pose an assembly and write the posed STEP AP242")
    add_geometry_arguments(parser)
    parser.add_argument("--set", action="append", default=[], metavar="J-###=VALUE",
                        help="independent joint value in deg (revolute) or mm (prismatic); repeatable")
    parser.add_argument("--case", default="pose", help="case id for the immutable motion bundle")
    parser.add_argument("--replace", action="store_true", help="retain and replace a different recipe")
    parser.add_argument("--out", type=Path, help="STEP path for scratch; only .cad-work paths are allowed")
    args = parser.parse_args(argv)
    try:
        version, record_hw, version_dir = None, args.hw, None
        if args.version:
            version, version_dir, record_hw = LAYOUT.built_version(args.hw, args.version)
            args.version, args.version_dir, args.record_hw = version, version_dir, record_hw
            if args.out is not None:
                raise MotionError("--out is only allowed for scratch inputs; versioned pose publishes to hw/motion")
            recipe = {"operation": "pose", "case": args.case, "options": {"set": list(args.set)},
                      "attach": list(args.attach), "inputs_sha256": input_sha256(version_dir)}
            reused = LAYOUT.reusable(args.hw, "bundle.motion", {"V": version, "S": args.case}, recipe,
                                     replace=args.replace)
            if reused is not None:
                result = json.loads((reused / "result.json").read_text(encoding="utf-8"))
                result.update(bundle=str(reused), reused=True)
                print(json.dumps(result, indent=2))
                return 1 if result.get("status") == "fail" else 0
        else:
            if args.out is None:
                raise MotionError("--out is required for scratch inputs")
            args.out = LAYOUT.scratch_path(args.hw, args.out, "--out")
            if args.out.exists():
                raise MotionError(f"--out already exists; refusing to overwrite scratch output: {args.out}")
        assembly, chain, definitions = load_inputs(args)
        values = chain.complete(parse_values(args.set))
        findings = chain.limit_findings(values)
        result: dict[str, Any] = {"status": "fail" if findings else "pass", "values": values,
                                  "product": product_id(record_hw),
                                  "independent": [j.id for j in chain.independent],
                                  "derived": {j.id: chain.couplings.describe(j.id) for j in chain.dependent},
                                  "units": {j.id: j.unit for j in chain.movable}, "findings": findings,
                                  "no_geometry": [pn for pn in assembly.definitions if pn not in definitions],
                                  "occurrences": {oid: chain.pn(oid) for oid in chain.ids}}
        if not findings and version:
            stage = LAYOUT.staging(args.hw, "bundle.motion")
            try:
                transforms = write_posed(stage / "pose.step", record_hw, chain, definitions, values)
                result["placements"] = placements_report(chain, transforms)
                result["out"] = str(LAYOUT.bundle_dir(args.hw, "motion", version, args.case) / "pose.step")
                (stage / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
                published = LAYOUT.publish(args.hw, "bundle.motion", {"V": version, "S": args.case}, stage,
                                           recipe=recipe, producer="cad-motion pose.py", status=result["status"],
                                           replace=args.replace)
                result.update(bundle=str(published.path), reused=published.reused)
            except Exception:
                shutil.rmtree(stage, ignore_errors=True)
                raise
        elif not findings:
            transforms = write_posed(args.out, record_hw, chain, definitions, values)
            result["placements"] = placements_report(chain, transforms)
            result["out"] = str(args.out)
    except (MotionError, OSError, LAYOUT.LayoutError, LAYOUT.PublishConflict) as error:
        print(f"pose: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 1 if findings else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # an OCCT or FreeCAD failure is infrastructure, never a check result
        traceback.print_exc()
        sys.exit(2)
