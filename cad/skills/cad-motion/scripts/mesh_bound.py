"""Conservative bounds on pose.py's pair distance from tessellated meshes, for pair_measure.py's
fast mode and for the parent's per-pose boxes (cad-motion `sweep.py`); numpy and python-fcl,
imported only when that mode is on.

A definition is tessellated once (`MeshBounds.prepare`), on a copy (the definition the measurement
reads keeps no triangulation), at LINEAR_DEFLECTION_MM and ANGULAR_DEFLECTION_RAD. The result is a
`MeshAssets`: read-only arrays per definition (mesh nodes, triangles, the `deviation`, a distance
within which every point of a definition's faces lies of its mesh, and every mesh point of its
faces; and the definition's exact tolerance-enlarged box). The assets go to the worker processes
as one temporary .npz file, so a definition is tessellated once per run, not once per worker; each
process builds its python-fcl BVHs and solid classifiers from them on first use.

`MeshBounds.query` bounds one pair: the BVH distance between a's mesh and b's mesh placed in a's
frame, minus and plus both meshes' deviations, holds the true boundary distance, and
pose.interference's distance, never above the boundaries', below its upper end.

The deviation is derived from the tessellation. BRepMesh holds the distance between a triangle and
its surface at the triangle's edge midpoints and centroid within the linear deflection, and its
nodes lie on the surface. On a triangle, the gap to the second-order part of the surface is a
quadratic that vanishes at the three nodes, so it is the P2 interpolant of its three edge-midpoint
values, whose basis sums to at most 4/3 inside the triangle: the gap is at most 4/3 of the largest
midpoint gap. DEVIATION_FACTOR = 2 covers that and the higher-order terms, and the definition's
largest sub-shape tolerance is added, as the faces' bounding edges may stray that far from their
surfaces. tests/fixtures/mesh_probe.py samples the fixtures' faces and measures each sample's exact
distance to its mesh against the deviation.

pose.interference reads 0 when a vertex of one shape lies inside a solid of the other, at
CONTAINMENT_TOL_MM, while the meshes measure boundaries only, so a lower bound is kept only where
no such vertex can exist. With the boundaries proved more than SOLID_GAP_MM apart, every vertex of
one connected shell is in or out of each solid of the other alike, so one vertex per shell whose
vertices meet the solid's box is classified, in both directions. Touching meshes, a mesh distance
within the deviations, a nested shape and a definition with an untriangulated face prove nothing:
the lower bound is 0.

`MeshAssets.posed_boxes` gives each occurrence's world box at a pose once, from its mesh nodes: the
shape lies within its deviation of the nodes' hull, so `box_gap`, the boxes' gap less sqrt(3) times
both deviations, is a lower bound on the pair distance computed without any BRep. A definition
without a mesh falls back to its exact tolerance-enlarged box, error 0.
"""

from __future__ import annotations

import json
import math
import sys
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import fcl
import numpy as np

pose = sys.modules["cad_motion_pose"]

LINEAR_DEFLECTION_MM = 0.02
ANGULAR_DEFLECTION_RAD = 0.2
DEVIATION_FACTOR = 2.0  # over the linear deflection: 4/3 for the second-order surface, the rest higher order
BOX_ERROR_FACTOR = math.sqrt(3.0)  # a posed box's gap less this many deviations of each side bounds the distance

Vec = tuple[float, float, float]


@dataclass(frozen=True)
class MeshQuery:
    """Mesh bounds on one pair's distance (b placed in a's frame). `lower_mm` is 0 where nothing is
    proved: an unavailable mesh, touching meshes, a mesh distance within the deviations, or a
    vertex of one shape inside a solid of the other (`nested`). `upper_mm` holds always, inf
    without both meshes. `containment_possible`: containment was not ruled out without classifying
    (a vertex lies in a solid's box, or the meshes are too close to tell)."""

    lower_mm: float
    upper_mm: float
    mesh_mm: float | None  # the mesh distance, 0 for touching meshes; None without both meshes
    deviation_a_mm: float
    deviation_b_mm: float
    touching: bool
    nested: bool
    containment_possible: bool
    available: bool

    @property
    def deviation_mm(self) -> float:
        return self.deviation_a_mm + self.deviation_b_mm


@dataclass(frozen=True)
class Box:
    """An occurrence's axis-aligned world box at one pose: the shape lies within `error_mm` of it."""

    low: Vec
    high: Vec
    error_mm: float


def box_gap(a: Box, b: Box) -> float:
    """A lower bound on the distance between the shapes of two posed boxes: the boxes' gap less
    BOX_ERROR_FACTOR times both errors, at least 0."""
    gap = math.sqrt(sum(max(0.0, b.low[k] - a.high[k], a.low[k] - b.high[k]) ** 2 for k in range(3)))
    return max(0.0, gap - BOX_ERROR_FACTOR * (a.error_mm + b.error_mm))


@dataclass(frozen=True)
class _Asset:
    nodes: Any  # (n, 3) mesh nodes, definition frame; empty without a mesh
    triangles: Any  # (k, 3) int32 node indices
    deviation: float  # every face point lies within this of the mesh, and every mesh point of a face
    brep_low: Any  # (3,) the exact box, enlarged by the shape tolerances
    brep_high: Any

    @property
    def available(self) -> bool:
        return len(self.triangles) > 0


class MeshAssets:
    """Read-only tessellations by definition key, as `MeshBounds.prepare` made them."""

    def __init__(self, entries: Mapping[str, _Asset]) -> None:
        self._entries = dict(entries)
        self.posed = 0  # occurrence boxes computed by posed_boxes

    def __contains__(self, key: str) -> bool:
        return key in self._entries

    @property
    def keys(self) -> tuple[str, ...]:
        return tuple(self._entries)

    def available(self, key: str) -> bool:
        return self._entries[key].available

    def deviation(self, key: str) -> float:
        return self._entries[key].deviation

    def posed_boxes(self, transforms: Mapping[str, Any], definition_of: Callable[[str], str]) -> dict[str, Box]:
        """Each occurrence's world Box at `transforms` (occurrence id -> pose.Rigid), its definition
        `definition_of(occurrence id)`: the hull of its posed mesh nodes, error its deviation, or of
        its posed exact box corners, error 0, without a mesh. One box per occurrence."""
        boxes = {}
        for occurrence, rigid in transforms.items():
            asset = self._entries[definition_of(occurrence)]
            rot, trans = np.asarray(rigid.rot, dtype=float), np.asarray(rigid.trans, dtype=float)
            if asset.available:
                points, error = asset.nodes @ rot.T + trans, asset.deviation
            else:
                corners = np.array(np.meshgrid(*zip(asset.brep_low, asset.brep_high), indexing="ij")).reshape(3, -1).T
                points, error = corners @ rot.T + trans, 0.0
            boxes[occurrence] = Box(tuple(map(float, points.min(axis=0))), tuple(map(float, points.max(axis=0))), error)
            self.posed += 1
        return boxes

    def save(self, path: Path) -> None:
        """Write the assets to one .npz file (`load` reads it)."""
        keys = list(self._entries)
        arrays: dict[str, Any] = {"keys": np.array(json.dumps(keys))}
        for index, key in enumerate(keys):
            asset = self._entries[key]
            arrays.update({f"{index}/nodes": asset.nodes, f"{index}/triangles": asset.triangles,
                           f"{index}/deviation": np.array(asset.deviation),
                           f"{index}/brep": np.stack([asset.brep_low, asset.brep_high])})
        with path.open("wb") as handle:
            np.savez(handle, **arrays)

    @classmethod
    def load(cls, path: Path) -> MeshAssets:
        with np.load(path, allow_pickle=False) as data:
            keys = json.loads(str(data["keys"]))
            entries = {}
            for index, key in enumerate(keys):
                nodes, triangles = data[f"{index}/nodes"], data[f"{index}/triangles"]
                for array in (nodes, triangles):
                    array.setflags(write=False)
                brep = data[f"{index}/brep"]
                entries[key] = _Asset(nodes, triangles, float(data[f"{index}/deviation"]), brep[0], brep[1])
        return cls(entries)


@dataclass
class _Solid:
    low: Any  # the solid's box, enlarged by SOLID_GAP_MM, in its definition's frame
    high: Any
    shape: Any
    classifier: Any = None

    def holds(self, point: Any) -> bool:
        """Whether `point` (definition frame) lies inside the solid, beyond CONTAINMENT_TOL_MM."""
        from OCP.BRepClass3d import BRepClass3d_SolidClassifier
        from OCP.gp import gp_Pnt
        from OCP.TopAbs import TopAbs_IN

        if self.classifier is None:
            self.classifier = BRepClass3d_SolidClassifier(self.shape)
        self.classifier.Perform(gp_Pnt(*map(float, point)), pose.CONTAINMENT_TOL_MM)
        return self.classifier.State() == TopAbs_IN


@dataclass
class _Runtime:
    """One process's query objects of a meshed definition, built on first use."""

    deviation: float
    vertices: Any  # (n, 3) the B-rep vertices' points
    shell: Any  # (n,) a connected-shell index per vertex; a vertex in no shell has its own
    solids: list[_Solid] = field(default_factory=list)
    frame: Any = None  # a CollisionObject at the identity, for the mesh as `a`
    moving: Any = None  # a CollisionObject moved per request, for the mesh as `b`


class MeshBounds:
    """Mesh bounds over `shapes` (key -> TopoDS_Shape): `prepare` tessellates, `query` bounds a pair.
    Given `assets` (a worker's, from the parent), it queries those and tessellates nothing."""

    def __init__(self, shapes: Mapping[str, Any], linear: float = LINEAR_DEFLECTION_MM,
                 angular: float = ANGULAR_DEFLECTION_RAD, assets: MeshAssets | None = None) -> None:
        self.shapes, self.linear, self.angular = shapes, linear, angular
        self.assets = assets if assets is not None else MeshAssets({})
        self.runtime: dict[str, _Runtime | None] = {}
        self.queries = 0  # pair queries answered (FCL distance computations, or none without a mesh)
        self.seconds = 0.0  # spent tessellating and querying
        self.tessellated = 0  # definitions tessellated by this instance

    def settings(self) -> dict[str, Any]:
        """What a query's value depends on besides the two definitions and the placement, for
        pair_measure.RuleVersion."""
        from importlib.metadata import version as installed

        return {"linear_mm": self.linear, "angular_rad": self.angular, "deviation_factor": DEVIATION_FACTOR,
                "box_error_factor": BOX_ERROR_FACTOR, "python_fcl": installed("python-fcl"), "numpy": np.__version__}

    def prepare(self, keys: Iterable[str]) -> MeshAssets:
        """This instance's assets (one object for its lifetime), with each of `keys` tessellated
        once."""
        started = time.perf_counter()
        for key in keys:
            if key not in self.assets:
                self.assets._entries[key] = _tessellate(self.shapes[key], self.linear, self.angular)
                self.tessellated += 1
        self.seconds += time.perf_counter() - started
        return self.assets

    def query(self, a: str, b: str, relative: Any) -> MeshQuery:
        """Bounds on the distance pose.interference measures between definition `a` and definition
        `b` placed by `relative` (a pose.Rigid) in a's frame."""
        started = time.perf_counter()
        try:
            self.queries += 1
            return self._query(a, b, relative)
        finally:
            self.seconds += time.perf_counter() - started

    def _query(self, a: str, b: str, relative: Any) -> MeshQuery:
        mesh_a, mesh_b = self._runtime(a), self._runtime(b)
        if mesh_a is None or mesh_b is None:
            return MeshQuery(0.0, math.inf, None, 0.0, 0.0, False, False, True, False)
        rot, trans = np.asarray(relative.rot, dtype=float), np.asarray(relative.trans, dtype=float)
        mesh_b.moving.setTransform(fcl.Transform(rot, trans))
        touching = bool(fcl.collide(mesh_a.frame, mesh_b.moving, fcl.CollisionRequest(), fcl.CollisionResult()))
        distance = 0.0 if touching else float(fcl.distance(mesh_a.frame, mesh_b.moving, fcl.DistanceRequest(),
                                                           fcl.DistanceResult()))
        spread = mesh_a.deviation + mesh_b.deviation
        bound = distance - spread
        if touching or bound <= pose.SOLID_GAP_MM:
            return MeshQuery(0.0, distance + spread, distance, mesh_a.deviation, mesh_b.deviation, touching, False,
                             True, True)
        possible_ab, nested_ab = _inside(mesh_a, mesh_b.vertices @ rot.T + trans, mesh_b.shell)
        possible_ba, nested_ba = (False, False) if nested_ab else _inside(mesh_b, (mesh_a.vertices - trans) @ rot,
                                                                          mesh_a.shell)
        nested = nested_ab or nested_ba
        return MeshQuery(0.0 if nested else bound, distance + spread, distance, mesh_a.deviation, mesh_b.deviation,
                         False, nested, possible_ab or possible_ba, True)

    def _runtime(self, key: str) -> _Runtime | None:
        """The definition's query objects in this process, tessellating it first if no asset has it."""
        if key not in self.runtime:
            if key not in self.assets:
                self.prepare((key,))
            asset = self.assets._entries[key]
            if not asset.available:
                self.runtime[key] = None
            else:
                model = fcl.BVHModel()
                model.beginModel(len(asset.nodes), len(asset.triangles))
                model.addSubModel(np.asarray(asset.nodes, dtype=float), np.asarray(asset.triangles, dtype=np.int32))
                model.endModel()
                vertices, shell = _vertex_shells(self.shapes[key])
                self.runtime[key] = _Runtime(asset.deviation, vertices, shell, _solids(self.shapes[key]),
                                             fcl.CollisionObject(model, fcl.Transform()),
                                             fcl.CollisionObject(model, fcl.Transform()))
        return self.runtime[key]


def _inside(container: _Runtime, points: Any, shell: Any) -> tuple[bool, bool]:
    """(whether a vertex of the other shape, `points` in the container's frame with `shell` their
    shell indices, meets a solid's box of `container`; whether one lies inside that solid), testing
    one vertex per shell meeting each solid's box."""
    possible = False
    for solid in container.solids:
        hits = np.flatnonzero(np.all((points >= solid.low) & (points <= solid.high), axis=1))
        if hits.size == 0:
            continue
        possible = True
        _, first = np.unique(shell[hits], return_index=True)
        if any(solid.holds(points[hits[index]]) for index in first):
            return True, True
    return possible, False


def _tessellate(shape: Any, linear: float, angular: float) -> _Asset:
    """`shape`'s asset; without a mesh (a face has no triangulation) its triangles are empty."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.ShapeAnalysis import ShapeAnalysis_ShapeTolerance
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHAPE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    low, high = (np.array(corner, dtype=float) for corner in pose.box_corners(shape, tolerance=True))
    empty = _Asset(np.empty((0, 3)), np.empty((0, 3), dtype=np.int32), 0.0, low, high)
    copy = BRepBuilderAPI_Copy(shape, True, False).Shape()
    BRepMesh_IncrementalMesh(copy, linear, False, angular, False)
    as_face = getattr(TopoDS, "Face_s", None) or TopoDS.Face
    nodes, triangles, base = [], [], 0
    explorer = TopExp_Explorer(copy, TopAbs_FACE)
    while explorer.More():
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(as_face(explorer.Current()), location)
        if triangulation is None or triangulation.NbTriangles() == 0:
            return empty
        trsf = location.Transformation()
        count = triangulation.NbNodes()
        for index in range(1, count + 1):
            point = triangulation.Node(index).Transformed(trsf)
            nodes.append((point.X(), point.Y(), point.Z()))
        for index in range(1, triangulation.NbTriangles() + 1):
            i, j, k = triangulation.Triangle(index).Get()
            triangles.append((base + i - 1, base + j - 1, base + k - 1))
        base += count
        explorer.Next()
    if not triangles:
        return empty
    tolerance = ShapeAnalysis_ShapeTolerance().Tolerance(shape, 1, TopAbs_SHAPE)
    node_array, triangle_array = np.asarray(nodes, dtype=float), np.asarray(triangles, dtype=np.int32)
    for array in (node_array, triangle_array):
        array.setflags(write=False)
    return _Asset(node_array, triangle_array, DEVIATION_FACTOR * linear + tolerance, low, high)


def _vertex_shells(shape: Any) -> tuple[Any, Any]:
    """(the points of `shape`'s vertices, a shell index per vertex): vertices of one shell share
    its index, the first shell's that holds them; a vertex in no shell has an index of its own."""
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_SHELL, TopAbs_VERTEX
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopoDS import TopoDS
    try:  # OCP 8 binds NCollection maps under OCP.collections, as pose.shape_list's lists
        from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as ShapeMap
    except ImportError:  # OCP 7.9
        from OCP.TopTools import TopTools_IndexedMapOfShape as ShapeMap

    as_vertex = getattr(TopoDS, "Vertex_s", None) or TopoDS.Vertex
    every = ShapeMap()
    TopExp.MapShapes_s(shape, TopAbs_VERTEX, every)
    count = every.Extent()
    points = np.empty((count, 3))
    for index in range(1, count + 1):
        point = BRep_Tool.Pnt_s(as_vertex(every.FindKey(index)))
        points[index - 1] = (point.X(), point.Y(), point.Z())
    shell = np.full(count, -1, dtype=np.int64)
    explorer, number = TopExp_Explorer(shape, TopAbs_SHELL), 0
    while explorer.More():
        members = ShapeMap()
        TopExp.MapShapes_s(explorer.Current(), TopAbs_VERTEX, members)
        for index in range(1, members.Extent() + 1):
            position = every.FindIndex(members.FindKey(index)) - 1
            if position >= 0 and shell[position] < 0:
                shell[position] = number
        number += 1
        explorer.Next()
    loose = np.flatnonzero(shell < 0)
    shell[loose] = number + np.arange(loose.size)
    return points, shell


def _solids(shape: Any) -> list[_Solid]:
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    solids, explorer = [], TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(explorer.Current(), box, False, True)
        box.Enlarge(pose.SOLID_GAP_MM)
        low, high = box.CornerMin(), box.CornerMax()
        solids.append(_Solid(np.array([low.X(), low.Y(), low.Z()]), np.array([high.X(), high.Y(), high.Z()]),
                             explorer.Current()))
        explorer.Next()
    return solids


def version() -> str:
    """The mesh filter's library, for reports."""
    from importlib.metadata import version as installed

    return f"python-fcl {installed('python-fcl')}"
