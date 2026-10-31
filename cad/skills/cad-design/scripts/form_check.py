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
in-memory facts per part feed the two kernel checks below. `product.yaml`
`manufacturing.min_wall_mm` overrides the minimum wall per process (`fdm`, `cnc`; each
above 0 mm); an invalid override is an error (exit 2), never a silent default.

Per part (stdout JSON `parts`):
    form_class             part.yaml value (solid when absent)
    min_wall               F2+: {required_mm} alone when the process has no minimum
                           (purchased, or cnc without an override); else the scan:
                           thickness_mm and location_mm (null when no wall was
                           measured), faces, faces_sampled, samples, measured, tapered,
                           shallow with shallow_thickness_mm and shallow_location_mm,
                           capped_faces, spacing_mm and seconds (see minimum_wall)
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
    min_wall                F2+, a process with a minimum (fdm 1.2 mm, or the override):
                            the shortest sampled wall is below it
    min_wall_unmeasured     F2+, the same parts: no sample reached an opposing face, so
                            the scan proves nothing
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
import time
import traceback
from collections.abc import Iterator
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
MIN_WALL_BY_PROCESS = {"fdm": 1.2}  # built-in minimum wall, mm: a 0.4 mm FDM nozzle's three perimeters
MIN_WALL_PROCESSES = ("fdm", "cnc")  # the keys product.yaml manufacturing.min_wall_mm may set
WALL_SPACING_FRACTION = 0.5  # sample spacing along each UV direction, as a fraction of the minimum wall
WALL_FACE_SAMPLE_CAP = 4096  # samples per face; a larger face is sampled coarser and counted in capped_faces
WALL_METRIC_PROBES = 8  # first-derivative probes per UV direction that size a face's sample grid
WALL_EDGE_SKIP_TOLERANCES = 4.0  # samples this many B-rep tolerances from a trim boundary are skipped
WALL_EDGE_SKIP_MIN_MM = 1e-4
WALL_OPPOSING_DOT = -0.94  # an exit normal within 20 degrees of antiparallel to the sample normal
WALL_SAME_EXIT_MM = 1e-6  # hits this close along a ray are one exit, through an edge or a vertex
WALL_PERSIST_REACH = 2.0  # in minimum walls: how thick a neighbour through the same exit face may be
WALL_PROBE_REACH = 3.0  # in minimum walls, per axis: no persistence probe strays farther from its sample
WALL_RAY_OFFSET_MM = 1e-5
WALL_CLASSIFY_TOL_MM = 1e-7


class RecordError(Exception):
    """A design-record value form_check reads is invalid."""


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


def unit_normal(surface: Any, u: float, v: float, reversed_: bool) -> tuple[Any, Any]:
    """The point and outward (material-leaving) unit normal at (u, v); None where the normal is undefined."""
    from OCP.gp import gp_Pnt, gp_Vec

    point, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
    surface.D1(u, v, point, du, dv)
    normal = du.Crossed(dv)
    magnitude = normal.Magnitude()
    if magnitude <= 1e-9 * du.Magnitude() * dv.Magnitude():  # a pole, an apex or a degenerate patch
        return point, None
    normal.Divide(magnitude)
    if reversed_:
        normal.Reverse()
    return point, normal


class FaceSamples:
    """Wall samples on one trimmed face: the cell centres of a UV grid no coarser than `spacing`.

    The fastest parametric speed over a WALL_METRIC_PROBES² probe grid sizes each UV
    direction, so the grid is no coarser than `spacing` where the surface stretches
    most; WALL_FACE_SAMPLE_CAP bounds the samples per face (`capped`). The grid spans
    the face's full UV range, so a periodic seam does not decide where samples land, and
    a seam is no trim boundary. A point within WALL_EDGE_SKIP_TOLERANCES of the face's
    B-rep tolerance (its edges and vertices included) from a trim boundary is no sample.
    """

    def __init__(self, face: Any, bounds: tuple[float, float, float, float], spacing: float) -> None:
        from OCP.BRep import BRep_Tool
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        from OCP.IntTools import IntTools_FClass2d
        from OCP.TopAbs import TopAbs_EDGE, TopAbs_REVERSED, TopAbs_VERTEX

        self.surface = BRepAdaptor_Surface(face, True)
        self.reversed = face.Orientation() == TopAbs_REVERSED
        self.bounds = bounds
        tolerance = max(BRep_Tool.Tolerance_s(face), BRep_Tool.MaxTolerance_s(face, TopAbs_EDGE),
                        BRep_Tool.MaxTolerance_s(face, TopAbs_VERTEX))
        skip = max(WALL_EDGE_SKIP_TOLERANCES * tolerance, WALL_EDGE_SKIP_MIN_MM)
        # Points within `skip` of a trim boundary classify ON.
        self.trim = IntTools_FClass2d(face, min(self.surface.UResolution(skip), self.surface.VResolution(skip)))
        self.nu, self.nv, self.capped = self._cells(spacing)

    def _cells(self, spacing: float) -> tuple[int, int, bool]:
        from OCP.gp import gp_Pnt, gp_Vec

        umin, umax, vmin, vmax = self.bounds
        point, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
        speed_u = speed_v = 0.0
        for i in range(WALL_METRIC_PROBES):
            for j in range(WALL_METRIC_PROBES):
                self.surface.D1(umin + (umax - umin) * (i + 0.5) / WALL_METRIC_PROBES,
                                vmin + (vmax - vmin) * (j + 0.5) / WALL_METRIC_PROBES, point, du, dv)
                speed_u, speed_v = max(speed_u, du.Magnitude()), max(speed_v, dv.Magnitude())
        nu = max(1, math.ceil(speed_u * (umax - umin) / spacing))
        nv = max(1, math.ceil(speed_v * (vmax - vmin) / spacing))
        if nu * nv <= WALL_FACE_SAMPLE_CAP:
            return nu, nv, False
        scale = math.sqrt(WALL_FACE_SAMPLE_CAP / (nu * nv))
        nu, nv = max(1, int(nu * scale)), max(1, int(nv * scale))
        return min(nu, WALL_FACE_SAMPLE_CAP // nv), nv, True

    def at(self, u: float, v: float) -> tuple[Any, Any] | None:
        """The point and outward unit normal at (u, v); None outside the trimmed face or without a normal."""
        from OCP.gp import gp_Pnt2d
        from OCP.TopAbs import TopAbs_IN

        if self.trim.Perform(gp_Pnt2d(u, v)) != TopAbs_IN:
            return None
        point, normal = unit_normal(self.surface, u, v, self.reversed)
        return None if normal is None else (point, normal)

    def grid(self) -> Iterator[tuple[float, float, Any, Any]]:
        """(u, v, point, outward unit normal) at every cell centre inside the trimmed face."""
        umin, umax, vmin, vmax = self.bounds
        for i in range(self.nu):
            u = umin + (umax - umin) * (i + 0.5) / self.nu
            for j in range(self.nv):
                v = vmin + (vmax - vmin) * (j + 0.5) / self.nv
                sample = self.at(u, v)
                if sample is not None:
                    yield u, v, sample[0], sample[1]


class SolidRays:
    """Rays through one solid, each tested only against the faces near the face it samples.

    focus() loads the faces whose bounding boxes come within a radius of one face, once
    per face, so a ray's cost follows the faces near it rather than the whole solid.
    """

    def __init__(self, solid: Any) -> None:
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib

        self.faces = faces_of(solid)
        self.boxes = []
        whole = Bnd_Box()
        for face in self.faces:
            box = Bnd_Box()
            BRepBndLib.Add_s(face, box, False)  # from the geometry: a mesh's box can miss the surface between nodes
            self.boxes.append(box)
            whole.Add(box)
        self.reach = math.sqrt(whole.SquareExtent())  # no chord through the solid is longer
        self.intersector: Any = None

    def focus(self, index: int, radius: float) -> None:
        """Load the faces whose bounding boxes come within `radius` of face `index` for the rays that follow."""
        from OCP.BRep import BRep_Builder
        from OCP.Bnd import Bnd_Box
        from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
        from OCP.TopoDS import TopoDS_Compound

        near = Bnd_Box()
        near.Add(self.boxes[index])
        near.Enlarge(radius)
        compound, builder = TopoDS_Compound(), BRep_Builder()
        builder.MakeCompound(compound)
        for face, box in zip(self.faces, self.boxes):
            if not near.IsOut(box):
                builder.Add(compound, face)
        self.intersector = IntCurvesFace_ShapeIntersector()
        self.intersector.Load(compound, WALL_CLASSIFY_TOL_MM)

    def crossings(self, start: Any, direction: Any, limit: float, count: int) -> list[tuple[float, list[tuple[Any, Any]]]]:
        """The first `count` boundary crossings of a ray within `limit`: (ray parameter, [(face, outward normal)]).

        Hits within WALL_SAME_EXIT_MM of each other are one crossing, through an edge or a vertex.
        """
        from OCP.BRepAdaptor import BRepAdaptor_Surface
        from OCP.gp import gp_Dir, gp_Lin
        from OCP.TopAbs import TopAbs_REVERSED

        hits = self.intersector
        hits.Perform(gp_Lin(start, gp_Dir(direction)), 0.0, limit)
        hits.SortResult()
        found: list[tuple[float, list[tuple[Any, Any]]]] = []
        for index in range(1, hits.NbPnt() + 1):
            w = hits.WParameter(index)
            if not found or w > found[-1][0] + WALL_SAME_EXIT_MM:
                if len(found) == count:
                    break
                found.append((w, []))
            face = hits.Face(index)
            _, normal = unit_normal(BRepAdaptor_Surface(face, False), hits.UParameter(index), hits.VParameter(index),
                                    face.Orientation() == TopAbs_REVERSED)
            if normal is not None:
                found[-1][1].append((face, normal))
        return found

    def chord(self, point: Any, normal: Any, limit: float) -> tuple[float | None, list[Any]]:
        """The length of the inward ray from a surface point to its first exit within `limit`, and the exit faces.

        (math.inf, []) when the ray stays in the solid that far. (None, []) when no face
        it leaves through there opposes `normal`: a taper, an acute edge wedge or a side
        face. Otherwise the exit faces listed are the ones that oppose `normal`.
        """
        found = self.crossings(point.Translated(normal.Multiplied(-WALL_RAY_OFFSET_MM)), normal.Reversed(), limit, 1)
        if not found:
            return math.inf, []
        exit_w, exits = found[0]
        opposing = [face for face, exit_normal in exits if normal.Dot(exit_normal) <= WALL_OPPOSING_DOT]
        return (exit_w + WALL_RAY_OFFSET_MM, opposing) if opposing else (None, [])  # the ray starts inside the face

    def persists(self, samples: FaceSamples, u: float, v: float, point: Any, normal: Any, length: float,
                 exits: list[Any], required_mm: float) -> bool:
        """Whether a chord below the minimum belongs to a wall, not to relief such as the lands of engraved text.

        A wall continues at least as far as it is thin. Along the face's U and V
        directions, on at least one side, one chord length away, the wall must go on: the
        face's own sample there leaves the solid through one of `exits`, at any thickness
        up to WALL_PERSIST_REACH minimum walls, or through another opposing face below the
        minimum. So a web thinnest at one spot, thickening away from it, still counts.
        Where that point leaves the face, a ray parallel to this chord stands in
        (thin_wall_at), so a wall also continues across face boundaries and parametric
        poles; relief ends there, at its own edge.
        """
        from OCP.gp import gp_Pnt, gp_Vec

        du, dv = gp_Vec(), gp_Vec()
        samples.surface.D1(u, v, gp_Pnt(), du, dv)
        for derivative, along_u in ((du, True), (dv, False)):
            step, tangent = length / derivative.Magnitude(), derivative.Normalized()
            for side in (1.0, -1.0):
                probe = samples.at(u + side * step, v) if along_u else samples.at(u, v + side * step)
                if probe is None:
                    foot = point.Translated(tangent.Multiplied(side * length))
                    goes_on = self.thin_wall_at(foot, normal, length, exits, required_mm)
                else:
                    found = self.crossings(probe[0].Translated(probe[1].Multiplied(-WALL_RAY_OFFSET_MM)),
                                           probe[1].Reversed(), WALL_PERSIST_REACH * required_mm, 1)
                    goes_on = bool(found) and self.continues(found[0], probe[1], exits, required_mm)
                if goes_on:
                    break
            else:
                return False
        return True

    @staticmethod
    def continues(crossing: tuple[float, list[tuple[Any, Any]]], normal: Any, exits: list[Any],
                  required_mm: float, entry_w: float = -WALL_RAY_OFFSET_MM) -> bool:
        """Whether an exit crossing goes on with a wall: through one of `exits` at any thickness, or through
        another face opposing `normal` less than `required_mm` after `entry_w`."""
        exit_w, faces = crossing
        return any(face.IsSame(exit_face) for face, _ in faces for exit_face in exits) or (
            exit_w - entry_w < required_mm and any(normal.Dot(exit_normal) <= WALL_OPPOSING_DOT for _, exit_normal in faces))

    def thin_wall_at(self, foot: Any, normal: Any, length: float, exits: list[Any], required_mm: float) -> bool:
        """Whether a ray along -normal through `foot` enters the solid within one chord length of `foot`,
        then leaves through one of `exits` or through an opposing face less than `required_mm` later."""
        found = self.crossings(foot.Translated(normal.Multiplied(length)), normal.Reversed(),
                               2.0 * length + required_mm, 2)
        if len(found) < 2 or found[0][0] > 2.0 * length:
            return False
        enter_w, entries = found[0]
        return any(normal.Dot(entry) > 0.0 and self.continues(found[1], entry, exits, required_mm, enter_w)
                   for _, entry in entries)


def minimum_wall(shape: Any, required_mm: float) -> dict[str, Any]:
    """The shortest sampled wall, with the coverage that bounds it.

    Each face gets a UV grid of samples (FaceSamples) no coarser than
    WALL_SPACING_FRACTION of `required_mm`, up to WALL_FACE_SAMPLE_CAP per face;
    `capped_faces` counts the faces sampled coarser. Each sample casts a ray along its
    inward normal (SolidRays.chord). Its first exit must oppose the sample, so two faces
    meeting at an acute edge never read as a thin wall; `tapered` counts the samples
    whose exit did not. A ray needs to reach only the running minimum: a sample with no
    shorter chord bounds the wall there at or above it, so `tapered` and `shallow` count
    only exits shorter than the running minimum. A shorter chord below `required_mm`
    must also persist (SolidRays.persists) to become the minimum; `shallow` counts the
    ones that did not, with the thinnest of them. At or above `required_mm` the shortest
    opposing chord is the minimum as found. `measured` counts the samples that measured
    or bounded a wall; zero means the scan measured no wall at all.
    """
    from OCP.BRepTools import BRepTools

    started = time.perf_counter()
    spacing = WALL_SPACING_FRACTION * required_mm
    best: tuple[float, Any] | None = None
    thinnest_shallow: tuple[float, Any] | None = None
    faces = faces_sampled = samples = measured = shallow = tapered = capped_faces = 0
    for solid in solids_of(shape):
        rays = SolidRays(solid)
        for index, face in enumerate(rays.faces):
            faces += 1
            bounds = BRepTools.UVBounds_s(face)
            if not all(math.isfinite(value) for value in bounds):
                continue
            face_samples = FaceSamples(face, bounds, spacing)
            capped_faces += face_samples.capped
            # The running minimum only shrinks, so this face's rays and probes stay within the radius.
            rays.focus(index, max(rays.reach if best is None else best[0], WALL_PROBE_REACH * required_mm))
            placed = 0
            for u, v, point, normal in face_samples.grid():
                placed += 1
                length, exits = rays.chord(point, normal, rays.reach if best is None else min(rays.reach, best[0]))
                if length is None:
                    tapered += 1
                    continue
                if length == math.inf and best is None:
                    continue  # a ray that never left the solid
                if best is not None and length >= best[0]:
                    measured += 1  # bounded by the running minimum
                    continue
                if length < required_mm and not rays.persists(face_samples, u, v, point, normal, length, exits,
                                                              required_mm):
                    shallow += 1
                    if thinnest_shallow is None or length < thinnest_shallow[0]:
                        thinnest_shallow = (length, point)
                    continue
                measured += 1
                best = (length, point)
            samples += placed
            faces_sampled += placed > 0
    return {"required_mm": required_mm,
            "thickness_mm": None if best is None else round(best[0], 6),
            "location_mm": None if best is None else rounded_xyz(best[1]),
            "faces": faces, "faces_sampled": faces_sampled, "samples": samples, "measured": measured,
            "tapered": tapered, "shallow": shallow,
            "shallow_thickness_mm": None if thinnest_shallow is None else round(thinnest_shallow[0], 6),
            "shallow_location_mm": None if thinnest_shallow is None else rounded_xyz(thinnest_shallow[1]),
            "capped_faces": capped_faces, "spacing_mm": round(spacing, 6),
            "seconds": round(time.perf_counter() - started, 3)}


def rounded_xyz(point: Any) -> list[float]:
    return [round(value, 6) + 0.0 for value in _xyz(point)]  # + 0.0 turns -0.0 into 0.0


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
    """Built-in minima with product.yaml manufacturing.min_wall_mm overrides; an invalid override is a RecordError.

    The override contract is cad-record's product schema: a non-empty mapping whose keys
    are MIN_WALL_PROCESSES, each a number above 0 mm.
    """
    import yaml

    path = hw / "product.yaml"
    product = yaml.safe_load(path.read_text(encoding="utf-8")) if path.is_file() else None
    manufacturing = product.get("manufacturing") if isinstance(product, dict) else None
    thresholds = dict(MIN_WALL_BY_PROCESS)
    if not isinstance(manufacturing, dict) or "min_wall_mm" not in manufacturing:
        return thresholds
    overrides = manufacturing["min_wall_mm"]
    if not isinstance(overrides, dict) or not overrides:
        raise RecordError(f"{path}: manufacturing.min_wall_mm must map {' and/or '.join(MIN_WALL_PROCESSES)} "
                          f"to a minimum wall in mm, got {overrides!r}")
    for process, value in overrides.items():
        if process not in MIN_WALL_PROCESSES:
            raise RecordError(f"{path}: manufacturing.min_wall_mm.{process}: no minimum wall for this process; "
                              f"allowed: {', '.join(MIN_WALL_PROCESSES)}")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise RecordError(f"{path}: manufacturing.min_wall_mm.{process} must be a number above 0 mm, got {value!r}")
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
    wall_thresholds = minimum_wall_thresholds(args.hw)  # an invalid override stops the check before any part loads
    loaded = pose.load_definitions(args.hw, args.parts_dir)
    assembly = pose.load_assembly(args.hw)
    process = processes(args.hw)
    facts = kernel_facts(args.parts_dir)
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
        required_wall = wall_thresholds.get(row["process"])  # none for purchased parts or a process without a minimum
        row["min_wall"] = {"required_mm": None}
        if required_wall is not None:
            wall = row["min_wall"] = minimum_wall(part.shape, required_wall)
            if wall["thickness_mm"] is None:
                findings.append({"check": "min_wall_unmeasured", "part": pn, "min_mm": required_wall,
                                 "faces": wall["faces"], "faces_sampled": wall["faces_sampled"],
                                 "samples": wall["samples"]})
            elif wall["thickness_mm"] < required_wall:
                findings.append({"check": "min_wall", "part": pn, "thickness_mm": wall["thickness_mm"],
                                 "location_mm": wall["location_mm"], "min_mm": required_wall})
        if row["process"] == "purchased":
            continue
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
    except (pose.MotionError, RecordError) as error:
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
