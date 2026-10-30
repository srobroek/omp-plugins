# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0", "numpy>=1.26", "python-fcl==0.7.0.11"]
# ///
"""Probe mesh_bound.py and pair_measure.py's fast mode on real fixture geometry; print the findings as JSON.

- `deviation`: every definition of every fixture set, and the probe's own shapes, sampled at
  SAMPLES points per face (seeded, inside the face): each sample's distance to the definition's
  mesh is at most the mesh's `deviation` (`violations`); `max_ratio` is the largest distance over
  the linear deflection.
- `intervals`: each ordered pair of each set at the definition placement and at seeded random
  placements: pose.interference's distance lies in MeshBounds.query's [lower, upper]
  (`violations`); `informative` counts the lower bounds above 0.
- `containment`: a pin inside a block's void (the bound holds and is above 0: the void is outside
  the material), a pin buried in a block's material and the nest sets' buried cube (the bound is 0,
  the shapes nested, the distance 0), and two boxes face to face (touching meshes: the bound is 0).
- `fast`: each ordered pair of the path sets swept along a seeded path, its median distance as its
  minimum, measured exactly and in fast mode (band BAND_MM, mesh bounds): every request fast mode
  measured equals the exact run's bitwise (`mismatches`), and every cleared one lies within its
  bounds, without overlap, more than its minimum plus the band away (`violations`): the spot
  check of every mesh-cleared pair-pose; `max_abs_mesh_minus_exact_mm` over the mesh-cleared ones.
- `bracket`: a cube moving away from a cylinder along its box's diagonal, the band set so its
  closest pose is just outside it: every request is cleared by the mesh (the box gap is looser),
  and the reported bounds, (smallest lower, smallest upper), bracket the exact minimum.

Usage: uv run --script mesh_probe.py FIXTURE_DIR  (build_fixtures.py's OUT_DIR)
"""

from __future__ import annotations

import importlib.util
import json
import math
import random
import statistics
import sys
from pathlib import Path

import fcl
import numpy as np

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pose = load("cad_motion_pose", SCRIPTS / "pose.py")
pair_measure = load("cad_motion_pair_measure", SCRIPTS / "pair_measure.py")
mesh_bound = load("cad_motion_mesh_bound", SCRIPTS / "mesh_bound.py")
SETS = ("v6", "planar", "twins", "lamp", "nest/solid", "nest/compound")
PATH_SETS = ("v6", "planar", "lamp")
POSES = 3  # random placements per ordered pair, besides the definition placement
PATH_STEPS = 8
SAMPLES = 40  # per face
BAND_MM = 0.5


def turn(rng: random.Random) -> tuple[tuple[float, float, float], float]:
    axis = [rng.gauss(0.0, 1.0) for _ in range(3)]
    norm = math.sqrt(sum(v * v for v in axis))
    return tuple(v / norm for v in axis), rng.uniform(0.0, 360.0)


def placements(rng: random.Random, reach: float) -> list:
    out = [pose.Rigid.identity()]
    for _ in range(POSES):
        rotation = pose.Rigid.rotation(*turn(rng), (0.0, 0.0, 0.0))
        out.append(pose.Rigid(rotation.rot, tuple(rng.uniform(-reach, reach) for _ in range(3))))
    return out


def path(rng: random.Random, reach: float) -> list:
    axis, sweep = turn(rng)
    start = [rng.uniform(-reach, reach) for _ in range(3)]
    end = [rng.uniform(-reach, reach) for _ in range(3)]
    out = []
    for k in range(PATH_STEPS):
        t = k / (PATH_STEPS - 1)
        rotation = pose.Rigid.rotation(axis, sweep * t, (0.0, 0.0, 0.0))
        out.append(pose.Rigid(rotation.rot, tuple(s + (e - s) * t for s, e in zip(start, end))))
    return out


def reach_of(shape) -> float:
    low, high = pose.box_corners(shape)
    return max(h - lo for lo, h in zip(low, high))


def face_samples(shape, rng: random.Random) -> list[tuple[float, float, float]]:
    """SAMPLES seeded points inside each face of `shape`."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.BRepTools import BRepTools
    from OCP.gp import gp_Pnt2d
    from OCP.TopAbs import TopAbs_FACE, TopAbs_IN
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    as_face = getattr(TopoDS, "Face_s", None) or TopoDS.Face
    points, explorer = [], TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = as_face(explorer.Current())
        surface = BRepAdaptor_Surface(face)
        u0, u1, v0, v1 = BRepTools.UVBounds_s(face)
        taken = 0
        for _ in range(SAMPLES * 20):
            u, v = rng.uniform(u0, u1), rng.uniform(v0, v1)
            if BRepClass_FaceClassifier(face, gp_Pnt2d(u, v), 1e-9).State() != TopAbs_IN:
                continue
            point = surface.Value(u, v)
            points.append((point.X(), point.Y(), point.Z()))
            taken += 1
            if taken == SAMPLES:
                break
        explorer.Next()
    return points


def point_distance(mesh, point) -> float:
    """A point's exact distance to the mesh: fcl's sphere-to-mesh distance, 0 where the sphere touches."""
    probe = fcl.CollisionObject(fcl.Sphere(1e-9), fcl.Transform(np.asarray(point, dtype=float)))
    if fcl.collide(mesh.frame, probe, fcl.CollisionRequest(), fcl.CollisionResult()):
        return 0.0
    return fcl.distance(mesh.frame, probe, fcl.DistanceRequest(), fcl.DistanceResult()) + 1e-9


def deviation(report: dict, name: str, shapes: dict) -> None:
    rng = random.Random(f"deviation {name}")
    bounds = mesh_bound.MeshBounds(shapes)
    for key in sorted(shapes):
        mesh = bounds._runtime(key)  # the definition's BVH and deviation
        report["definitions"] += 1
        for point in face_samples(shapes[key], rng):
            distance = point_distance(mesh, point)
            report["samples"] += 1
            report["max_ratio"] = max(report["max_ratio"], distance / mesh_bound.LINEAR_DEFLECTION_MM)
            if distance > mesh.deviation:
                report["violations"].append({"set": name, "definition": key, "point": point, "distance": distance,
                                             "deviation": mesh.deviation})


def intervals(report: dict, name: str, shapes: dict) -> None:
    rng = random.Random(f"intervals {name}")
    bounds = mesh_bound.MeshBounds(shapes)
    for a in sorted(shapes):
        for b in sorted(shapes):
            for placement in placements(rng, reach_of(shapes[a])):
                found = bounds.query(a, b, placement)
                lower, upper = found.lower_mm, found.upper_mm
                distance = pose.interference(shapes[a], pose.placed(shapes[b], placement))[0]
                report["compared"] += 1
                report["informative"] += lower > 0.0
                if not lower - pair_measure.SLACK_MM <= distance <= upper + pair_measure.SLACK_MM:
                    report["violations"].append({"set": name, "a": a, "b": b, "placement": placement.rows(9),
                                                 "lower": lower, "upper": upper, "distance": distance})


def case(shapes: dict, placement) -> dict:
    found = mesh_bound.MeshBounds(shapes).query("a", "b", placement)
    distance, volume = pose.interference(shapes["a"], pose.placed(shapes["b"], placement))
    return {"lower": found.lower_mm, "upper": found.upper_mm, "distance": distance, "volume": volume,
            "touching": found.touching, "nested": found.nested, "containment_possible": found.containment_possible}


def freeform_shapes(block) -> dict:
    """A B-spline loft through a circle, an ellipse and a smaller circle, and the 20 mm block with
    every edge filleted at 3 mm: the faces whose deviation the planar 4/3 argument does not cover."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
    from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
    from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Elips, gp_Pnt
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    loft = BRepOffsetAPI_ThruSections(True, False)
    for curve in (gp_Circ(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 6.0),
                  gp_Elips(gp_Ax2(gp_Pnt(1, 0, 9), gp_Dir(0, 0, 1)), 9.0, 4.0),
                  gp_Circ(gp_Ax2(gp_Pnt(0, 2, 18), gp_Dir(0, 0, 1)), 3.0)):
        loft.AddWire(BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(curve).Edge()).Wire())
    loft.Build()
    fillet = BRepFilletAPI_MakeFillet(block)
    as_edge = getattr(TopoDS, "Edge_s", None) or TopoDS.Edge
    explorer = TopExp_Explorer(block, TopAbs_EDGE)
    while explorer.More():
        fillet.Add(3.0, as_edge(explorer.Current()))
        explorer.Next()
    fillet.Build()
    return {"loft": loft.Shape(), "fillet": fillet.Shape()}


def face_types(shapes: dict) -> dict:
    """Face count per surface type over `shapes`."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    as_face = getattr(TopoDS, "Face_s", None) or TopoDS.Face
    counts: dict = {}
    for shape in shapes.values():
        explorer = TopExp_Explorer(shape, TopAbs_FACE)
        while explorer.More():
            kind = str(BRepAdaptor_Surface(as_face(explorer.Current())).GetType()).rsplit("_", 1)[-1]
            counts[kind] = counts.get(kind, 0) + 1
            explorer.Next()
    return counts



def made_shapes() -> dict:
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

    block = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 20.0, 20.0, 20.0).Shape()
    void = BRepPrimAPI_MakeBox(gp_Pnt(5, 5, 5), 10.0, 10.0, 10.0).Shape()
    return {
        "block": block,
        "hollow": BRepAlgoAPI_Cut(block, void).Shape(),  # a solid with an inner shell: a 10 mm void at 5..15
        "pin": BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, -3), gp_Dir(0, 0, 1)), 1.0, 6.0).Shape(),  # r 1, z -3..3
        "cube": BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 10.0, 10.0, 10.0).Shape(),
        "unit": BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 1.0, 1.0, 1.0).Shape(),
        "column": BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 2.5, 10.0).Shape(),
    }


def containment(made: dict, root: Path) -> dict:
    at = lambda x, y, z: pose.Rigid(pose.Rigid.identity().rot, (x, y, z))  # noqa: E731
    out = {
        # the pin at the void's centre: 4 mm from its sides, 2 mm from its floor and ceiling
        "void": case({"a": made["hollow"], "b": made["pin"]}, at(10.0, 10.0, 10.0)),
        # the pin in the block's material, x 2..4, y 9..11, z 7..13: no face within 1 mm
        "embedded": case({"a": made["block"], "b": made["pin"]}, at(3.0, 10.0, 10.0)),
        "touching": case({"a": made["cube"], "b": made["cube"]}, at(10.0, 0.0, 0.0)),
    }
    for name in ("solid", "compound"):
        folder = root / "nest" / name
        nest = {pn: part.shape for pn, part in pose.load_definitions(folder, folder).items()}
        out[f"nest/{name}"] = case({"a": nest["TST-0301"], "b": nest["TST-0302"]}, pose.Rigid.identity())
    return out


def measurer(shapes: dict, mesh=None, band: float = pair_measure.MESH_BAND_MM):
    parts = {key: pose.Part(key, key, shape) for key, shape in shapes.items()}
    return pair_measure.PairMeasurer(shapes, geometry_ids=pose.geometry_ids(parts),
                                     rule=pair_measure.RuleVersion.current(mesh, band), mesh=mesh)


def measure(measuring, requests: list, prune: bool = False) -> list:
    with measuring.session() as session:
        return session.measure(requests, prune=prune)


def fast(report: dict, name: str, shapes: dict) -> None:
    rng = random.Random(f"fast {name}")
    requests = []
    for a in sorted(shapes):
        for b in sorted(shapes):
            requests += [pair_measure.Request(a, b, placement, group=(a, b), mode="exact")
                         for placement in path(rng, reach_of(shapes[a]))]
    first = measure(measurer(shapes), requests)
    median = {group: statistics.median(o.distance_mm for r, o in zip(requests, first) if r.group == group)
              for group in {r.group for r in requests}}
    requests = [pair_measure.Request(r.a, r.b, r.placement, group=r.group, minimum_mm=max(0.0, median[r.group]))
                for r in requests]
    mesh = mesh_bound.MeshBounds(shapes)
    got = measure(measurer(shapes, mesh, BAND_MM), requests, prune=True)
    for index, (request, outcome, want) in enumerate(zip(requests, got, first)):
        report["requests"] += 1
        where = {"set": name, "index": index, "pair": [request.a, request.b]}
        if isinstance(outcome, pair_measure.Cleared):
            report[f"cleared_{outcome.method}"] = report.get(f"cleared_{outcome.method}", 0) + 1
            cap = max(pose.OVERLAP_GATE_MM, request.minimum_mm) + BAND_MM
            slack = pair_measure.SLACK_MM
            if not (outcome.lower_mm - slack <= want.distance_mm <= outcome.upper_mm + slack and want.distance_mm > cap
                    and want.overlap_mm3 == 0.0):
                report["violations"].append({**where, "cleared": repr(outcome), "exact": repr(want), "cap": cap})
            if outcome.method == "mesh":
                gap = abs(outcome.mesh_mm - want.distance_mm)
                report["max_abs_mesh_minus_exact_mm"] = max(report["max_abs_mesh_minus_exact_mm"], gap)
        elif isinstance(outcome, pair_measure.Measured) and \
                [outcome.distance_mm.hex(), outcome.overlap_mm3.hex()] != [want.distance_mm.hex(), want.overlap_mm3.hex()]:
            report["mismatches"].append({**where, "fast": repr(outcome), "exact": repr(want)})


def bracket(made: dict) -> dict:
    """The unit cube's near corner on the column's box diagonal, 2.167 to 3 mm off its surface."""
    shapes = {"column": made["column"], "unit": made["unit"]}
    placements_ = [pose.Rigid(pose.Rigid.identity().rot, (3.3 + 0.12 * k, 3.3 + 0.12 * k, 4.0)) for k in range(6)]
    # the corner at (offset, offset): sqrt(2) * offset - 2.5 from the surface
    exact = measure(measurer(shapes), [pair_measure.Request("column", "unit", p, mode="exact") for p in placements_])
    mesh = mesh_bound.MeshBounds(shapes)
    lowest = min(mesh.query("column", "unit", p).lower_mm for p in placements_)
    band = lowest - pose.OVERLAP_GATE_MM - 1e-4  # the closest pose just outside the band
    fast_measurer = measurer(shapes, mesh, band)
    got = measure(fast_measurer, [pair_measure.Request("column", "unit", p, group="diagonal") for p in placements_],
                  prune=True)
    gaps = [fast_measurer.box_gap("column", "unit", p) for p in placements_]
    lower = min(o.lower_mm for o in got if isinstance(o, pair_measure.Cleared))
    upper = min(o.upper_mm for o in got if isinstance(o, pair_measure.Cleared))
    minimum = min(o.distance_mm for o in exact)
    return {"band": band, "exact_minimum": minimum, "lower": lower, "upper": upper, "box_gap_minimum": min(gaps),
            "all_mesh": all(isinstance(o, pair_measure.Cleared) and o.method == "mesh" for o in got),
            "brackets": lower <= minimum <= upper, "outside_by": minimum - band - pose.OVERLAP_GATE_MM}


def main(root: Path) -> dict:
    report = {"deviation": {"definitions": 0, "samples": 0, "max_ratio": 0.0, "violations": []},
              "intervals": {"compared": 0, "informative": 0, "violations": []},
              "fast": {"requests": 0, "cleared_box": 0, "cleared_mesh": 0, "mismatches": [], "violations": [],
                       "max_abs_mesh_minus_exact_mm": 0.0}}
    with pose.stdout_to_stderr():
        made = made_shapes()
        deviation(report["deviation"], "made", made)
        freeform = freeform_shapes(made["block"])
        report["freeform"] = {"definitions": 0, "samples": 0, "max_ratio": 0.0, "violations": []}
        deviation(report["freeform"], "freeform", freeform)
        report["freeform"]["faces"] = face_types(freeform)
        for name in SETS:
            shapes = {pn: part.shape for pn, part in pose.load_definitions(root / name, root / name).items()}
            deviation(report["deviation"], name, shapes)
            intervals(report["intervals"], name, shapes)
            if name in PATH_SETS:
                fast(report["fast"], name, shapes)
        report["containment"] = containment(made, root)
        report["bracket"] = bracket(made)
    return report


if __name__ == "__main__":
    print(json.dumps(main(Path(sys.argv[1]))))
