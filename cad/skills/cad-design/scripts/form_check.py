# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Fidelity self-check over per-part STEP files: B-rep validity, form metrics, joint bores.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-design/scripts/form_check.py --hw HW --parts-dir DIR [--fidelity F0|F1|F2|F3]
        [--joint-tol 0.05] [--cnc-tool-radius 1.0] [--fdm-min-radius 1.0]

Parts: one STEP per part in DIR, named `<PN>.step` (cad-motion `--parts-dir`
rules). Process comes from hw/parts/<PN>/part.yaml (`fdm`, `cnc`, `purchased`); a bought part
(`make_buy: buy`, such as a pin made to drawing) is checked in its bought form, as `purchased`.
Joints: hw/assembly.yaml. When DIR holds build_reference.py's `build.json`, its
in-memory facts per part feed the two kernel checks below.

Per part (stdout JSON `parts`):
    valid                  BRepCheck_Analyzer verdict on the STEP read-back
    solids, volume_mm3, area_mm2
    kernel_valid           BRepCheck verdict on the in-memory shape (build.json)
    readback_rel_error     |STEP volume - in-memory volume| / in-memory volume (build.json)
    axis_planar_fraction   area share of planar faces normal to X, Y or Z
    blend_faces            convex cylinder and torus faces of radius <= 10 mm that turn
                           through <= 120 degrees (fillets, not lug ends or shafts)
    freeform_faces         B-spline, Bezier, revolved, extruded or offset faces
    min_convex_radius      smallest convex blend radius (FDM edge rule)
    min_concave_radius     smallest concave cylinder radius that is no bore wall
                           (cad-model holes.bore_walls): the CNC corner rule

Checks (each failure is one `findings` entry):
    brep_invalid            any fidelity: a part is not a valid B-rep, in the STEP
                            read-back (`source: step`) or in memory (`source: kernel`;
                            a STEP read-back can heal an unorientable face)
    step_readback           any fidelity: readback_rel_error above cad-model's 1e-6;
                            loose fillet edges (0.01 to 0.1 mm tolerance) move it ~1e-5
    joint_bore_missing      F1+: a joint's parent or child has no cylinder face whose
                            axis is parallel to the joint axis and passes within
                            --joint-tol of the joint origin; made parts need a bore
                            (concave), purchased parts a shank (convex)
    block_like              F2+, made parts: axis_planar_fraction >= 0.80, or no
                            blend and no freeform face
    fdm_exterior_radius     F2+, fdm parts: min_convex_radius < --fdm-min-radius
    cnc_internal_radius     F2+, cnc parts: min_concave_radius < --cnc-tool-radius

stdout: JSON {status, fidelity, parts, joints, findings}. stderr: diagnostics.
Exit 0 = no findings, 1 = findings, 2 = usage or infrastructure error.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import traceback
from pathlib import Path
from typing import Any

POSE_PATH = Path(__file__).resolve().parents[2] / "cad-motion" / "scripts" / "pose.py"
CAD_MODEL_SCRIPTS = Path(__file__).resolve().parents[2] / "cad-model" / "scripts"
KERNEL_FACTS = "build.json"
FIDELITY = ("F0", "F1", "F2", "F3")
BLOCK_PLANAR_FRACTION = 0.80
BLEND_MAX_RADIUS = 10.0
BLEND_MAX_SPAN = math.radians(120.0)  # a fillet turns through its edge angle; a lug end turns 180 degrees
AXIS_TOL = 1e-4  # sine of the allowed angle between a cylinder axis and a joint axis


def load_pose() -> Any:
    spec = importlib.util.spec_from_file_location("cad_motion_pose", POSE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["cad_motion_pose"] = module
    spec.loader.exec_module(module)
    return module


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(a):
    return math.sqrt(_dot(a, a))


def _xyz(v) -> tuple[float, float, float]:
    return (v.X(), v.Y(), v.Z())


def faces_of(shape: Any) -> list[Any]:
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    cast = getattr(TopoDS, "Face_s", None) or TopoDS.Face  # OCP 7.9 static vs OCP 8 namespace function
    faces = []
    while explorer.More():
        faces.append(cast(explorer.Current()))
        explorer.Next()
    return faces


def count_solids(shape: Any) -> int:
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count


def surface_sample(face: Any) -> tuple[Any, tuple[float, float, float], tuple[float, float, float], tuple[float, float, float, float]]:
    """Adaptor, a point and the outward (material-leaving) normal at the face's UV centre, and its UV bounds."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.BRepTools import BRepTools
    from OCP.TopAbs import TopAbs_REVERSED

    umin, umax, vmin, vmax = BRepTools.UVBounds_s(face)
    adaptor = BRepAdaptor_Surface(face)
    props = BRepLProp_SLProps(adaptor, (umin + umax) / 2.0, (vmin + vmax) / 2.0, 1, 1e-6)
    normal = _xyz(props.Normal()) if props.IsNormalDefined() else (0.0, 0.0, 0.0)
    if face.Orientation() == TopAbs_REVERSED:
        normal = (-normal[0], -normal[1], -normal[2])
    return adaptor, _xyz(props.Value()), normal, (umin, umax, vmin, vmax)


def face_area(face: Any) -> float:
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, props)
    return props.Mass()


def shape_volume(shape: Any) -> float:
    from cadmodel import occ

    return occ.volume(shape)  # the adaptive integration cad-model's check uses


def is_valid(shape: Any) -> bool:
    from OCP.BRepCheck import BRepCheck_Analyzer

    return bool(BRepCheck_Analyzer(shape).IsValid())


def measure(shape: Any) -> dict[str, Any]:
    """Form metrics plus the cylinders the joint check needs."""
    from cadmodel import holes
    from OCP.GeomAbs import (
        GeomAbs_BezierSurface,
        GeomAbs_BSplineSurface,
        GeomAbs_Cylinder,
        GeomAbs_OffsetSurface,
        GeomAbs_Plane,
        GeomAbs_SurfaceOfExtrusion,
        GeomAbs_SurfaceOfRevolution,
        GeomAbs_Torus,
    )

    freeform = {GeomAbs_BezierSurface, GeomAbs_BSplineSurface, GeomAbs_OffsetSurface,
                GeomAbs_SurfaceOfExtrusion, GeomAbs_SurfaceOfRevolution}
    total = axis_planar = 0.0
    blends = freeform_count = 0
    min_convex = min_concave = math.inf
    cylinders = []
    bores = holes.bore_walls(shape)  # a bore is drilled, not a corner a cutter leaves
    for face in faces_of(shape):
        area = face_area(face)
        total += area
        adaptor, point, normal, (umin, umax, vmin, vmax) = surface_sample(face)
        kind = adaptor.GetType()
        if kind == GeomAbs_Plane:
            n = _xyz(adaptor.Plane().Axis().Direction())
            if max(abs(c) for c in n) > 1.0 - 1e-6:
                axis_planar += area
        elif kind == GeomAbs_Cylinder:
            cylinder = adaptor.Cylinder()
            axis = cylinder.Axis()
            loc, direction = _xyz(axis.Location()), _xyz(axis.Direction())
            offset = _sub(point, loc)
            radial = _sub(offset, tuple(_dot(offset, direction) * c for c in direction))
            convex = _dot(normal, radial) > 0.0
            radius = cylinder.Radius()
            span = umax - umin
            cylinders.append({"location": loc, "direction": direction, "radius": radius, "convex": convex})
            if convex and span <= BLEND_MAX_SPAN and radius <= BLEND_MAX_RADIUS:
                blends += 1
                min_convex = min(min_convex, radius)
            elif not convex and not any(face.IsSame(wall) for wall in bores):
                min_concave = min(min_concave, radius)
        elif kind == GeomAbs_Torus:
            torus = adaptor.Torus()
            axis = torus.Axis()
            loc, direction = _xyz(axis.Location()), _xyz(axis.Direction())
            offset = _sub(point, loc)
            radial = _sub(offset, tuple(_dot(offset, direction) * c for c in direction))
            length = _norm(radial)
            if length > 1e-9:
                tube = tuple(loc[i] + radial[i] / length * torus.MajorRadius() for i in range(3))
                convex = _dot(normal, _sub(point, tube)) > 0.0
                if convex and vmax - vmin <= BLEND_MAX_SPAN and torus.MinorRadius() <= BLEND_MAX_RADIUS:
                    blends += 1
                    min_convex = min(min_convex, torus.MinorRadius())
        elif kind in freeform:
            freeform_count += 1
    return {
        "area_mm2": round(total, 3),
        "axis_planar_fraction": round(axis_planar / total, 4) if total else 1.0,
        "blend_faces": blends,
        "freeform_faces": freeform_count,
        "min_convex_radius": None if math.isinf(min_convex) else round(min_convex, 4),
        "min_concave_radius": None if math.isinf(min_concave) else round(min_concave, 4),
        "_cylinders": cylinders,
    }


def bore_offset(cylinders: list[dict[str, Any]], axis, origin, kind: str) -> dict[str, Any] | None:
    """The `kind` cylinder (bore or shank) parallel to the joint axis whose line passes closest to the origin."""
    best = None
    for cylinder in cylinders:
        if ("shank" if cylinder["convex"] else "bore") != kind or _norm(_cross(cylinder["direction"], axis)) > AXIS_TOL:
            continue
        offset = _norm(_cross(_sub(origin, cylinder["location"]), cylinder["direction"]))
        if best is None or offset < best["offset_mm"]:
            best = {"offset_mm": round(offset, 6), "radius": round(cylinder["radius"], 4), "kind": kind}
    return best


def processes(hw: Path) -> dict[str, str]:
    import yaml

    found = {}
    for record in sorted((hw / "parts").glob("*/part.yaml")):
        data = yaml.safe_load(record.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("process"), str):
            bought = data.get("make_buy") == "buy"   # made to drawing or catalogue: checked in its bought form
            found[record.parent.name] = "purchased" if bought else data["process"]
    return found


def kernel_facts(parts_dir: Path) -> dict[str, dict[str, Any]]:
    path = parts_dir / KERNEL_FACTS
    if not path.is_file():
        return {}
    parts = json.loads(path.read_text(encoding="utf-8")).get("parts", {})
    return {pn: row for pn, row in parts.items() if "kernel_valid" in row and "kernel_volume_mm3" in row}


def check(args: argparse.Namespace, pose: Any) -> dict[str, Any]:
    from cadmodel.check import READBACK_REL

    level = FIDELITY.index(args.fidelity)
    loaded = pose.load_definitions(args.hw, args.parts_dir)
    assembly = pose.load_assembly(args.hw)
    process = processes(args.hw)
    facts = kernel_facts(args.parts_dir)
    findings: list[dict[str, Any]] = []
    parts: dict[str, Any] = {}
    cylinders: dict[str, list[dict[str, Any]]] = {}
    for pn, part in sorted(loaded.items()):
        metrics = measure(part.shape)
        cylinders[pn] = metrics.pop("_cylinders")
        volume = shape_volume(part.shape)
        row = {"name": part.name, "process": process.get(pn), "valid": is_valid(part.shape),
               "solids": count_solids(part.shape), "volume_mm3": round(volume, 3), **metrics}
        parts[pn] = row
        if not row["valid"]:
            findings.append({"check": "brep_invalid", "part": pn, "source": "step"})
        if pn in facts:
            kernel_v = facts[pn]["kernel_volume_mm3"]
            row["kernel_valid"] = facts[pn]["kernel_valid"]
            row["readback_rel_error"] = abs(volume - kernel_v) / max(abs(kernel_v), 1e-12)
            if not row["kernel_valid"]:
                findings.append({"check": "brep_invalid", "part": pn, "source": "kernel",
                                 "errors": facts[pn].get("kernel_errors", [])})
            if row["readback_rel_error"] > READBACK_REL:
                findings.append({"check": "step_readback", "part": pn, "rel_error": row["readback_rel_error"],
                                 "max": READBACK_REL, "kernel_volume_mm3": kernel_v, "step_volume_mm3": volume})
        if level < 2 or row["process"] == "purchased":
            continue
        if row["axis_planar_fraction"] >= BLOCK_PLANAR_FRACTION or row["blend_faces"] + row["freeform_faces"] == 0:
            findings.append({"check": "block_like", "part": pn, "axis_planar_fraction": row["axis_planar_fraction"],
                             "blend_faces": row["blend_faces"], "freeform_faces": row["freeform_faces"]})
        if row["process"] == "fdm" and row["min_convex_radius"] is not None and row["min_convex_radius"] < args.fdm_min_radius:
            findings.append({"check": "fdm_exterior_radius", "part": pn, "radius": row["min_convex_radius"],
                             "min": args.fdm_min_radius})
        if row["process"] == "cnc" and row["min_concave_radius"] is not None and row["min_concave_radius"] < args.cnc_tool_radius:
            findings.append({"check": "cnc_internal_radius", "part": pn, "radius": row["min_concave_radius"],
                             "min": args.cnc_tool_radius})
    joints: dict[str, Any] = {}
    if level >= 1:
        for joint in assembly.joints:
            row = {"type": joint.type, "axis": list(joint.axis), "origin": list(joint.origin), "parts": {}}
            for oid in (joint.parent, joint.child):
                pn = assembly.pn(oid)
                ref = assembly.inventory.get(oid).ref if oid in assembly.inventory else pn
                # The joint frame is in assembly coordinates; a placed occurrence's bores are in its PN's frame.
                rest = (pose.Rigid.from_placement(assembly.inventory.get(oid).placement).inverse()
                        if oid in assembly.inventory else pose.Rigid.identity())
                axis = pose.Rigid(rest.rot, (0.0, 0.0, 0.0)).apply(joint.axis)
                kind = "shank" if process.get(pn) == "purchased" else "bore"
                found = bore_offset(cylinders[pn], axis, rest.apply(joint.origin), kind) if pn in cylinders else None
                row["parts"][ref] = found
                if found is None or found["offset_mm"] > args.joint_tol:
                    findings.append({"check": "joint_bore_missing", "joint": joint.id, "part": ref, "kind": kind,
                                     "nearest": found, "tol_mm": args.joint_tol})
            joints[joint.id] = row
    return {"status": "fail" if findings else "pass", "fidelity": args.fidelity, "parts": parts,
            "joints": joints, "findings": findings}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="cad-design fidelity self-check over per-part STEP files")
    parser.add_argument("--hw", type=Path, required=True)
    parser.add_argument("--parts-dir", type=Path, required=True)
    parser.add_argument("--fidelity", choices=FIDELITY, default="F2")
    parser.add_argument("--joint-tol", type=float, default=0.05)
    parser.add_argument("--cnc-tool-radius", type=float, default=1.0)
    parser.add_argument("--fdm-min-radius", type=float, default=1.0)
    args = parser.parse_args(argv)
    pose = load_pose()
    sys.path.insert(0, str(CAD_MODEL_SCRIPTS))
    try:
        with pose.stdout_to_stderr():
            report = check(args, pose)
    except pose.MotionError as error:
        print(json.dumps({"status": "error", "error": str(error)}))
        return 2
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"status": "error", "error": f"{type(error).__name__}: {error}"}))
        return 2
    print(json.dumps(report, indent=2))
    return 1 if report["findings"] else 0


if __name__ == "__main__":
    sys.exit(main())
