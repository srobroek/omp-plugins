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
in-memory facts per part feed the two kernel checks below. `product.yaml` can override
minimum wall through `manufacturing.min_wall_mm`.

Per part (stdout JSON `parts`):
    form_class             part.yaml value (solid when absent)
    min_wall               F2 shortest sampled inward ray, with location
    valid                  BRepCheck_Analyzer verdict on the STEP read-back
    solids, volume_mm3, area_mm2
    kernel_valid           BRepCheck verdict on the in-memory shape (build.json)
    axis_planar_fraction   area share of planar faces normal to X, Y or Z
    obb_fill_fraction      solid volume / oriented bounding-box volume
    obb_thickness_fraction shortest OBB extent / second-shortest OBB extent
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
    block_like              F2+, made solid parts only: (axis_planar_fraction >= 0.80 or
                            blend_faces + freeform_faces == 0), with both OBB exemptions
    min_wall                F2+, made parts: sampled minimum below FDM 1.2 mm or override
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
BLOCK_MIN_FILL_FRACTION = 0.20
BLOCK_MAX_THICKNESS_FRACTION = 0.10
BLEND_MAX_RADIUS = 10.0
BLEND_MAX_SPAN = math.radians(120.0)  # a fillet turns through its edge angle; a lug end turns 180 degrees
AXIS_TOL = 1e-4  # sine of the allowed angle between a cylinder axis and a joint axis
MIN_WALL_BY_PROCESS = {"fdm": 1.2}
WALL_SAMPLE_SUBDIVISIONS = 4
WALL_RAY_OFFSET_MM = 1e-5
WALL_CLASSIFY_TOL_MM = 1e-7


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
def solids_of(shape: Any) -> list[Any]:
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    cast = getattr(TopoDS, "Solid_s", None) or TopoDS.Solid
    solids = []
    while explorer.More():
        solids.append(cast(explorer.Current()))
        explorer.Next()
    return solids


def minimum_wall(shape: Any, minimum_mm: float) -> dict[str, Any] | None:
    """Minimum chord between opposing faces sampled on a 4×4 UV grid.

    Samples within one required wall thickness of trim boundaries are skipped. Ray
    exits must cross from inside to outside and have distinct supporting faces with
    normals within 20° of antiparallel. The grid is not a certified global minimum.
    """
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepIntCurveSurface import BRepIntCurveSurface_Inter
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Dir, gp_Lin, gp_Pnt, gp_Vec
    from OCP.TopAbs import TopAbs_IN, TopAbs_OUT, TopAbs_REVERSED
    from OCP.TopoDS import TopoDS

    cast = getattr(TopoDS, "Face_s", None) or TopoDS.Face
    best: tuple[float, tuple[float, float, float]] | None = None
    intersector = BRepIntCurveSurface_Inter()
    for solid in solids_of(shape):
        classifier = BRepClass3d_SolidClassifier(solid)
        for face in faces_of(solid):
            surface = BRepAdaptor_Surface(face, True)
            umin, umax, vmin, vmax = BRepTools.UVBounds_s(face)
            if not all(math.isfinite(value) for value in (umin, umax, vmin, vmax)):
                continue
            for ui in range(1, WALL_SAMPLE_SUBDIVISIONS + 1):
                u = umin + (umax - umin) * ui / (WALL_SAMPLE_SUBDIVISIONS + 1)
                for vi in range(1, WALL_SAMPLE_SUBDIVISIONS + 1):
                    v = vmin + (vmax - vmin) * vi / (WALL_SAMPLE_SUBDIVISIONS + 1)
                    point, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
                    surface.D1(u, v, point, du, dv)
                    trim = BRepClass_FaceClassifier()
                    trim.Perform(face, point, WALL_CLASSIFY_TOL_MM)
                    if trim.State() != TopAbs_IN:
                        continue
                    edge_margin = min((u - umin) * du.Magnitude(), (umax - u) * du.Magnitude(),
                                     (v - vmin) * dv.Magnitude(), (vmax - v) * dv.Magnitude())
                    if edge_margin < minimum_mm:
                        continue
                    props = BRepLProp_SLProps(surface, u, v, 1, WALL_CLASSIFY_TOL_MM)
                    if not props.IsNormalDefined():
                        continue
                    normal = gp_Vec(props.Normal().XYZ())
                    if face.Orientation() == TopAbs_REVERSED:
                        normal.Reverse()
                    normal.Normalize()
                    inward = gp_Dir(-normal.X(), -normal.Y(), -normal.Z())
                    origin = gp_Pnt(point.X() - WALL_RAY_OFFSET_MM * normal.X(),
                                    point.Y() - WALL_RAY_OFFSET_MM * normal.Y(),
                                    point.Z() - WALL_RAY_OFFSET_MM * normal.Z())
                    classifier.Perform(origin, WALL_CLASSIFY_TOL_MM)
                    if classifier.State() != TopAbs_IN:
                        continue
                    intersector.Init(solid, gp_Lin(origin, inward), WALL_CLASSIFY_TOL_MM)
                    while intersector.More():
                        thickness = intersector.W() - WALL_RAY_OFFSET_MM
                        exit_face = cast(intersector.Face())
                        if thickness > WALL_RAY_OFFSET_MM and not exit_face.IsSame(face):
                            hit = intersector.Pnt()
                            u_hit, v_hit = intersector.U(), intersector.V()
                            exit_surface = BRepAdaptor_Surface(exit_face, True)
                            _, du_hit, dv_hit = gp_Pnt(), gp_Vec(), gp_Vec()
                            exit_surface.D1(u_hit, v_hit, gp_Pnt(), du_hit, dv_hit)
                            exit_props = BRepLProp_SLProps(exit_surface, u_hit, v_hit, 1, WALL_CLASSIFY_TOL_MM)
                            if exit_props.IsNormalDefined():
                                exit_normal = gp_Vec(exit_props.Normal().XYZ())
                                if exit_face.Orientation() == TopAbs_REVERSED:
                                    exit_normal.Reverse()
                                exit_normal.Normalize()
                                before = gp_Pnt(hit.X() - 1e-4 * inward.X(), hit.Y() - 1e-4 * inward.Y(),
                                                hit.Z() - 1e-4 * inward.Z())
                                after = gp_Pnt(hit.X() + 1e-4 * inward.X(), hit.Y() + 1e-4 * inward.Y(),
                                               hit.Z() + 1e-4 * inward.Z())
                                classifier.Perform(before, WALL_CLASSIFY_TOL_MM)
                                inside_before = classifier.State() == TopAbs_IN
                                classifier.Perform(after, WALL_CLASSIFY_TOL_MM)
                                outside_after = classifier.State() == TopAbs_OUT
                                if (normal.Dot(exit_normal) <= -0.94 and inside_before and outside_after
                                        and (best is None or thickness < best[0])):
                                    best = (thickness, (point.X(), point.Y(), point.Z()))
                        intersector.Next()
    if best is None:
        return None
    return {"thickness_mm": round(best[0], 6), "location_mm": [round(value, 6) for value in best[1]]}


def count_solids(shape: Any) -> int:
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    count = 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count
def part_form_class(hw: Path, pn: str) -> str:
    """Read the form-class contract through one accessor; absent defaults to solid."""
    import yaml

    path = hw / "parts" / pn / "part.yaml"
    data = yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else None
    value = data.get("form_class") if isinstance(data, dict) else None
    return value if value in {"solid", "frame", "plate", "skeleton", "shell"} else "solid"


def minimum_wall_thresholds(hw: Path) -> dict[str, float]:
    """Built-in minima with product.yaml manufacturing.min_wall_mm overrides."""
    import yaml

    path = hw / "product.yaml"
    product = yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else None
    manufacturing = product.get("manufacturing") if isinstance(product, dict) else None
    overrides = manufacturing.get("min_wall_mm") if isinstance(manufacturing, dict) else None
    thresholds = dict(MIN_WALL_BY_PROCESS)
    if not isinstance(overrides, dict):
        return thresholds
    for key, value in overrides.items():
        process = key.strip().lower() if isinstance(key, str) else None
        if process in {"fdm", "cnc"} and isinstance(value, (int, float)) and math.isfinite(value) and value > 0:
            thresholds[process] = float(value)
    return thresholds


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
    from cadmodel import holes, occ
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
    obb_extents, _ = occ.oriented_bbox(shape)
    obb_volume = math.prod(obb_extents)
    shortest, second_shortest = sorted(obb_extents)[:2]
    thickness_fraction = shortest / second_shortest if second_shortest else 0.0
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
        "_obb_volume_mm3": obb_volume,
        "_obb_thickness_fraction": thickness_fraction,
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
    wall_thresholds = minimum_wall_thresholds(args.hw)
    form_classes = {pn: part_form_class(args.hw, pn) for pn in loaded}
    findings: list[dict[str, Any]] = []
    parts: dict[str, Any] = {}
    cylinders: dict[str, list[dict[str, Any]]] = {}
    for pn, part in sorted(loaded.items()):
        metrics = measure(part.shape)
        cylinders[pn] = metrics.pop("_cylinders")
        obb_volume = metrics.pop("_obb_volume_mm3")
        thickness_fraction = metrics.pop("_obb_thickness_fraction")
        volume = shape_volume(part.shape)
        row = {"name": part.name, "process": process.get(pn), "form_class": form_classes[pn],
               "valid": is_valid(part.shape), "solids": count_solids(part.shape),
               "volume_mm3": round(volume, 3),
               "obb_fill_fraction": round(volume / obb_volume, 4) if obb_volume else 0.0,
               "obb_thickness_fraction": round(thickness_fraction, 4), **metrics}
        if not row["valid"]:
            findings.append({"check": "brep_invalid", "part": pn, "source": "step"})
        parts[pn] = row
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
        if level < 2:
            continue
        if row["process"] == "purchased":
            row["min_wall"] = None
            continue
        required_wall = wall_thresholds.get(row["process"])
        wall = minimum_wall(part.shape, required_wall or 0.0)
        row["min_wall"] = wall
        if wall is not None and required_wall is not None and wall["thickness_mm"] < required_wall:
            findings.append({"check": "min_wall", "part": pn, "thickness_mm": wall["thickness_mm"],
                             "location_mm": wall["location_mm"], "min_mm": required_wall})
        has_blocky_faces = (row["axis_planar_fraction"] >= BLOCK_PLANAR_FRACTION
                            or row["blend_faces"] + row["freeform_faces"] == 0)
        if (form_classes[pn] == "solid" and has_blocky_faces
                and row["obb_fill_fraction"] >= BLOCK_MIN_FILL_FRACTION
                and row["obb_thickness_fraction"] > BLOCK_MAX_THICKNESS_FRACTION):
            findings.append({"check": "block_like", "part": pn, "axis_planar_fraction": row["axis_planar_fraction"],
                             "blend_faces": row["blend_faces"], "freeform_faces": row["freeform_faces"],
                             "obb_fill_fraction": row["obb_fill_fraction"],
                             "obb_thickness_fraction": row["obb_thickness_fraction"]})
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
