# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Pose an assembly at given joint values and write the posed STEP AP242.

Usage:
    uv run --script pose.py --hw HW (--step ASSEMBLY.step | --parts-dir DIR)
        [--attach PN=PARENT_PN ...] [--set J-###=VALUE ...] --out POSED.step

Joint record: hw/assembly.yaml `joints`. Supported types: revolute (values in
degrees), prismatic (values in mm) and fixed. `origin` (mm) and `axis` are in
assembly coordinates at the zero pose, where every joint value is 0.

Geometry, exactly one of:
    --step FILE      one assembly STEP; every leaf product whose name starts
                     with a PN (`LMP-0003` or `LMP-0003 Lower link`) is a part.
                     Instance placements are flattened into assembly
                     coordinates; a PN instanced more than once is rejected.
    --parts-dir DIR  one STEP per part, named `<PN>.step` or
                     `<PN> <anything>.step` (`.stp` also accepted). The part
                     keeps the file's PN-first product name; an unnamed file
                     is named `<PN> <title>` from hw/parts/<PN>/part.yaml.
Every part is modeled in place: assembly coordinates at the zero pose.

Kinematics: the ground is the one part that is never a joint child; its
transform is the identity. Each joint maps its child as
T_child = T_parent * M(value), where M is the rotation by `value` degrees
(right hand) about `axis` through `origin` for a revolute joint, the
translation by `value` mm along `axis` for a prismatic joint, and the
identity for a fixed joint. A part with geometry but no joint must be
connected with a fixed joint in assembly.yaml or `--attach PN=PARENT_PN`.
A movable joint without `--set` takes its `nominal` value.

The posed STEP keeps every part's product name and in-place geometry and
carries the pose in the instance placements under one top assembly.

stdout: JSON. stderr: diagnostics (OCCT translator output included).
Exit 0 = posed STEP written, 1 = a value is outside its joint's [min, max]
(no STEP is written), 2 = usage or infrastructure error.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import re
import sys
import traceback
from collections.abc import Iterable, Iterator, Mapping
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

Vec = tuple[float, float, float]


class MotionError(RuntimeError):
    """The inputs cannot be used; maps to exit 2."""


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
    nominal: float

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


@dataclass(frozen=True)
class Assembly:
    joints: tuple[Joint, ...]
    listed_parts: tuple[str, ...]  # subassembly parts, file order


def _vector(value: Any, where: str) -> Vec:
    if not (isinstance(value, list) and len(value) == 3 and all(_is_number(v) for v in value)):
        raise MotionError(f"{where} must be a list of three numbers")
    return (float(value[0]), float(value[1]), float(value[2]))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def make_joint(raw: Mapping[str, Any]) -> Joint:
    """Validate one assembly.yaml joint mapping."""
    jid = raw.get("id")
    if not isinstance(jid, str):
        raise MotionError(f"joint without a string id: {raw!r}")
    kind = raw.get("type")
    if kind not in UNITS:
        raise MotionError(f"{jid}: joint type {kind!r} is not supported; use one of {sorted(UNITS)}")
    for key in ("parent", "child"):
        if not isinstance(raw.get(key), str):
            raise MotionError(f"{jid}: {key} must be a part number")
    if raw["parent"] == raw["child"]:
        raise MotionError(f"{jid}: parent and child are both {raw['parent']}")
    axis = _vector(raw.get("axis"), f"{jid}.axis")
    norm = math.sqrt(sum(v * v for v in axis))
    if norm < 1e-12:
        raise MotionError(f"{jid}: axis has zero length")
    limits = {}
    for key in ("min", "max", "nominal"):
        if not _is_number(raw.get(key)):
            raise MotionError(f"{jid}: {key} must be a number")
        limits[key] = float(raw[key])
    if limits["min"] > limits["max"]:
        raise MotionError(f"{jid}: min {limits['min']} exceeds max {limits['max']}")
    if not limits["min"] <= limits["nominal"] <= limits["max"]:
        raise MotionError(f"{jid}: nominal {limits['nominal']} is outside [{limits['min']}, {limits['max']}]")
    return Joint(
        id=jid, type=kind, parent=raw["parent"], child=raw["child"],
        axis=(axis[0] / norm, axis[1] / norm, axis[2] / norm),
        origin=_vector(raw.get("origin"), f"{jid}.origin"), **limits,
    )


def load_assembly(hw: Path) -> Assembly:
    import yaml

    path = hw / "assembly.yaml"
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise MotionError(f"cannot read {path}: {error}") from error
    if not isinstance(data, dict) or not isinstance(data.get("joints"), list):
        raise MotionError(f"{path}: expected a mapping with a `joints` list")
    joints = tuple(make_joint(raw) if isinstance(raw, dict) else _bad_joint(raw) for raw in data["joints"])
    ids = [j.id for j in joints]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise MotionError(f"{path}: duplicate joint ids {duplicates}")
    listed: list[str] = []
    for sub in data.get("subassemblies") or []:
        for pn in (sub.get("parts") or []) if isinstance(sub, dict) else []:
            if isinstance(pn, str) and pn not in listed:
                listed.append(pn)
    return Assembly(joints, tuple(listed))


def _bad_joint(raw: Any) -> Joint:
    raise MotionError(f"joint entry is not a mapping: {raw!r}")


def attach_joints(specs: Iterable[str]) -> list[Joint]:
    """Turn `PN=PARENT_PN` options into fixed joints."""
    joints = []
    for spec in specs:
        child, sep, parent = spec.partition("=")
        if not sep or not PN_PREFIX.fullmatch(child) or not PN_PREFIX.fullmatch(parent):
            raise MotionError(f"--attach expects PN=PARENT_PN, got {spec!r}")
        joints.append(Joint(f"attach:{child}", "fixed", parent, child, (0.0, 0.0, 1.0), (0.0, 0.0, 0.0), 0.0, 0.0, 0.0))
    return joints


@dataclass(frozen=True)
class Chain:
    """A kinematic tree rooted at the ground part; joints are parent-before-child."""

    root: str
    joints: tuple[Joint, ...]

    @property
    def parts(self) -> tuple[str, ...]:
        return (self.root, *(j.child for j in self.joints))

    @property
    def movable(self) -> tuple[Joint, ...]:
        return tuple(j for j in self.joints if j.movable)

    def joint(self, jid: str) -> Joint:
        for joint in self.joints:
            if joint.id == jid:
                return joint
        raise MotionError(f"unknown joint {jid}")

    def adjacent_pairs(self) -> set[frozenset[str]]:
        return {frozenset((j.parent, j.child)) for j in self.joints}

    def path(self, pn: str) -> list[Joint]:
        """Joints from the root to `pn`."""
        incoming = {j.child: j for j in self.joints}
        path: list[Joint] = []
        while pn in incoming:
            path.append(incoming[pn])
            pn = incoming[pn].parent
        return path[::-1]

    def complete(self, values: Mapping[str, float]) -> dict[str, float]:
        """Every movable joint's value, defaulting to nominal."""
        movable = {j.id for j in self.movable}
        for jid in values:
            if jid not in movable:
                raise MotionError(f"{jid} is not a movable joint; movable joints: {sorted(movable)}")
        return {j.id: float(values.get(j.id, j.nominal)) for j in self.movable}

    def limit_findings(self, values: Mapping[str, float]) -> list[dict[str, Any]]:
        findings = []
        for joint in self.movable:
            value = values[joint.id]
            if not joint.min <= value <= joint.max:
                findings.append({
                    "check": "joint_limit", "joint": joint.id, "value": value,
                    "min": joint.min, "max": joint.max, "unit": joint.unit,
                    "message": f"{joint.id} value {value} {joint.unit} is outside [{joint.min}, {joint.max}]",
                })
        return findings

    def transforms(self, values: Mapping[str, float]) -> dict[str, Rigid]:
        placed = {self.root: Rigid.identity()}
        for joint in self.joints:
            value = values[joint.id] if joint.movable else 0.0
            placed[joint.child] = placed[joint.parent] @ joint.motion(value)
        return placed


def build_chain(joints: Iterable[Joint], parts: Iterable[str] = ()) -> Chain:
    """Order the joints into a tree over the joint parts plus `parts`."""
    joints = list(joints)
    incoming: dict[str, Joint] = {}
    for joint in joints:
        if joint.child in incoming:
            raise MotionError(f"{joint.child} is the child of both {incoming[joint.child].id} and {joint.id}")
        incoming[joint.child] = joint
    nodes = list(dict.fromkeys([*(n for j in joints for n in (j.parent, j.child)), *parts]))
    roots = [n for n in nodes if n not in incoming]
    if not roots:
        raise MotionError("the joints form a cycle; no part is the ground")
    if len(roots) > 1:
        ground = next((r for r in roots if any(j.parent == r for j in joints)), roots[0])
        loose = [r for r in roots if r != ground]
        raise MotionError(
            f"parts not connected to the ground {ground}: {loose}; connect each with a fixed joint "
            "in assembly.yaml or --attach PN=PARENT_PN"
        )
    ordered: list[Joint] = []
    frontier = [roots[0]]
    while frontier:
        parent = frontier.pop(0)
        for joint in joints:
            if joint.parent == parent:
                ordered.append(joint)
                frontier.append(joint.child)
    if len(ordered) != len(joints):
        raise MotionError("the joints form a cycle that is not connected to the ground")
    return Chain(roots[0], tuple(ordered))


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
    pn: str
    name: str  # STEP product name, PN first
    shape: Any  # TopoDS_Shape in assembly coordinates at the zero pose


@contextlib.contextmanager
def stdout_to_stderr() -> Iterator[None]:
    """Route OCCT's console output away from the JSON channel."""
    sys.stdout.flush()
    saved = os.dup(1)
    try:
        os.dup2(2, 1)
        yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)


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


def _part_titles(hw: Path) -> dict[str, str]:
    import yaml

    titles = {}
    for record in sorted((hw / "parts").glob("*/part.yaml")):
        try:
            data = yaml.safe_load(record.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(data, dict) and isinstance(data.get("title"), str):
            titles[record.parent.name] = data["title"]
    return titles


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


def _read_assembly(path: Path) -> dict[str, Part]:
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
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

    found: dict[str, Part] = {}

    def visit(label: Any, location: Any) -> None:
        if XCAFDoc_ShapeTool.IsAssembly_s(label):
            components = Sequence_TDF_Label()
            XCAFDoc_ShapeTool.GetComponents_s(label, components, False)
            for index in range(1, components.Length() + 1):
                component = components.Value(index)
                referred = TDF_Label()
                if XCAFDoc_ShapeTool.GetReferredShape_s(component, referred):
                    visit(referred, location.Multiplied(XCAFDoc_ShapeTool.GetLocation_s(component)))
            return
        product = name(label)
        match = PN_PREFIX.match(product)
        if not match:
            return
        pn = match.group(1)
        if pn in found:
            raise MotionError(f"{path}: {pn} is instanced more than once; a posed part needs one instance")
        shape = XCAFDoc_ShapeTool.GetShape_s(label)
        if not location.IsIdentity():
            shape = BRepBuilderAPI_Transform(shape, location.Transformation(), True).Shape()
        found[pn] = Part(pn, product, shape)

    roots = Sequence_TDF_Label()
    tool.GetFreeShapes(roots)
    for index in range(1, roots.Length() + 1):
        visit(roots.Value(index), TopLoc_Location())
    return found


def load_parts(hw: Path, step: Path | None = None, parts_dir: Path | None = None) -> dict[str, Part]:
    """Part geometry keyed by PN, from one assembly STEP or one STEP per part."""
    if (step is None) == (parts_dir is None):
        raise MotionError("give exactly one of --step or --parts-dir")
    if step is not None:
        if not step.is_file():
            raise MotionError(f"STEP file not found: {step}")
        found = _read_assembly(step)
    else:
        assert parts_dir is not None
        if not parts_dir.is_dir():
            raise MotionError(f"parts directory not found: {parts_dir}")
        titles = _part_titles(hw)
        found = {}
        for path in sorted(parts_dir.iterdir()):
            match = PN_PREFIX.match(path.stem)
            if path.suffix.lower() not in STEP_SUFFIXES or not match:
                continue
            pn = match.group(1)
            if pn in found:
                raise MotionError(f"{parts_dir}: more than one STEP file for {pn}")
            named = _read_assembly(path)
            if set(named) == {pn}:
                found[pn] = named[pn]  # the file's own product name, PN first
            elif not named:
                title = titles.get(pn)
                found[pn] = Part(pn, f"{pn} {title}" if title else pn, _read_single(path))
            else:
                raise MotionError(f"{path}: holds products of {sorted(named)}, expected only {pn}")
    if not found:
        raise MotionError("no part geometry found; product or file names must start with a PN")
    return found


def require_geometry(chain: Chain, parts: Mapping[str, Part]) -> None:
    missing = [pn for pn in chain.parts if pn not in parts]
    if missing:
        raise MotionError(f"joint parts without geometry: {missing}")


def write_step(path: Path, top_name: str | None, items: Iterable[tuple[Part, Rigid]]) -> None:
    """Write AP242: each part a named product placed by its transform under `top_name`.

    With `top_name` None the parts are written as free products in place (one
    part per file is the per-part STEP form); their transforms must be identity.
    """
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Interface import Interface_Static
    from OCP.STEPCAFControl import STEPCAFControl_Controller, STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Controller
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDocStd import TDocStd_Document
    from OCP.TopLoc import TopLoc_Location
    from OCP.XCAFApp import XCAFApp_Application
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.XSControl import XSControl_WorkSession

    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    XCAFApp_Application.GetApplication_s().InitDocument(doc)
    tool = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    top = None
    if top_name is not None:
        top = tool.NewShape()
        TDataStd_Name.Set_s(top, TCollection_ExtendedString(top_name))
    for part, rigid in items:
        if top is None and rigid != Rigid.identity():
            raise MotionError(f"{part.pn}: a free product cannot carry a placement")
        label = tool.AddShape(part.shape, False)
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(part.name))
        if top is not None:
            tool.AddComponent(top, label, TopLoc_Location(to_trsf(rigid)))
    tool.UpdateAssemblies()
    path.parent.mkdir(parents=True, exist_ok=True)
    with stdout_to_stderr():
        STEPCAFControl_Controller.Init_s()
        STEPControl_Controller.Init_s()
        if not Interface_Static.SetCVal_s("write.step.schema", "AP242DIS"):
            raise MotionError("cannot select the AP242 schema")
        writer = STEPCAFControl_Writer(XSControl_WorkSession(), False)
        writer.SetNameMode(True)
        writer.SetColorMode(True)
        if not writer.Transfer(doc, STEPControl_AsIs) or writer.Write(str(path)) != IFSelect_RetDone:
            raise MotionError(f"cannot write {path}")


def product_id(hw: Path) -> str:
    import yaml

    try:
        data = yaml.safe_load((hw / "product.yaml").read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return "assembly"
    return str(data["id"]) if isinstance(data, dict) and data.get("id") else "assembly"


def write_posed(path: Path, hw: Path, chain: Chain, parts: Mapping[str, Part], values: Mapping[str, float]) -> dict[str, Rigid]:
    """Write the posed assembly STEP; return the part transforms."""
    transforms = chain.transforms(values)
    write_step(path, f"{product_id(hw)} posed", ((parts[pn], transforms[pn]) for pn in chain.parts))
    return transforms


# --------------------------------------------------------------------------- CLI


def add_geometry_arguments(parser: argparse.ArgumentParser) -> None:
    """Options shared by the cad-motion scripts."""
    parser.add_argument("--hw", type=Path, required=True, help="hardware design record directory (hw/)")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--step", type=Path, help="assembly STEP with PN-first product names")
    source.add_argument("--parts-dir", type=Path, help="directory with one <PN>.step per part")
    parser.add_argument("--attach", action="append", default=[], metavar="PN=PARENT_PN",
                        help="rigidly attach a part without a joint to a parent part (repeatable)")


def load_inputs(args: argparse.Namespace) -> tuple[Assembly, Chain, dict[str, Part]]:
    """Read the joint record and geometry and build the connected chain."""
    assembly = load_assembly(args.hw)
    parts = load_parts(args.hw, args.step, args.parts_dir)
    chain = build_chain([*assembly.joints, *attach_joints(args.attach)], parts)
    require_geometry(chain, parts)
    return assembly, chain, parts


def placements_report(chain: Chain, transforms: Mapping[str, Rigid]) -> dict[str, list[list[float]]]:
    return {pn: transforms[pn].rows() for pn in chain.parts}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pose an assembly and write the posed STEP AP242")
    add_geometry_arguments(parser)
    parser.add_argument("--set", action="append", default=[], metavar="J-###=VALUE",
                        help="joint value in deg (revolute) or mm (prismatic); repeatable")
    parser.add_argument("--out", type=Path, required=True, help="posed STEP AP242 path")
    args = parser.parse_args(argv)
    try:
        assembly, chain, parts = load_inputs(args)
        values = chain.complete(parse_values(args.set))
        findings = chain.limit_findings(values)
        result: dict[str, Any] = {
            "status": "fail" if findings else "pass",
            "values": values,
            "units": {j.id: j.unit for j in chain.movable},
            "findings": findings,
            "no_geometry": [pn for pn in assembly.listed_parts if pn not in parts],
        }
        if not findings:
            transforms = write_posed(args.out, args.hw, chain, parts, values)
            result["placements"] = placements_report(chain, transforms)
            result["out"] = str(args.out)
    except (MotionError, OSError) as error:
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
