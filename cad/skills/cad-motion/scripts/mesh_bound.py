"""Conservative bounds on pose.py's pair distance from tessellated meshes, for pair_measure.py's
fast mode (cad-motion `sweep.py`); numpy and python-fcl, imported only when that mode is on.

A definition is tessellated once, on a copy (the definition the measurement reads keeps no
triangulation), at LINEAR_DEFLECTION_MM and ANGULAR_DEFLECTION_RAD, into a python-fcl BVH. A
request's interval is the BVH distance between a's mesh and b's mesh placed in a's frame, minus and
plus both meshes' `deviation`, a distance within which every point of a definition's faces lies
of its mesh, and every mesh point of its faces: the true boundary distance lies in it, and
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
CONTAINMENT_TOL_MM, while the meshes measure boundaries only, so a bound is kept only where no such
vertex can exist. With the boundaries proved more than SOLID_GAP_MM apart, every vertex of one
connected shell is in or out of each solid of the other alike, so one vertex per shell whose
vertices meet the solid's box is classified, in both directions. Touching meshes, a mesh distance
within the deviations and a definition with an untriangulated face prove nothing: the bound is 0.
"""

from __future__ import annotations

import sys
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import fcl
import numpy as np

pose = sys.modules["cad_motion_pose"]

LINEAR_DEFLECTION_MM = 0.02
ANGULAR_DEFLECTION_RAD = 0.2
DEVIATION_FACTOR = 2.0  # over the linear deflection: 4/3 for the second-order surface, the rest higher order


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
class _Mesh:
    model: Any  # fcl.BVHModel of the triangulation, definition frame
    deviation: float  # every face point lies within this of the mesh
    triangles: int
    vertices: Any  # (n, 3) the B-rep vertices' points
    shell: Any  # (n,) a connected-shell index per vertex; a vertex in no shell has its own
    solids: list[_Solid] = field(default_factory=list)
    frame: Any = None  # a CollisionObject at the identity, for the mesh as `a`
    moving: Any = None  # a CollisionObject moved per request, for the mesh as `b`


class MeshBounds:
    """Bounds on pose.interference's distance of two definitions of `shapes` (key -> TopoDS_Shape),
    b placed in a's frame; each definition meshed on first use."""

    def __init__(self, shapes: Mapping[str, Any], linear: float = LINEAR_DEFLECTION_MM,
                 angular: float = ANGULAR_DEFLECTION_RAD) -> None:
        self.shapes, self.linear, self.angular = shapes, linear, angular
        self.meshes: dict[str, _Mesh | None] = {}
        self.evaluations = 0  # intervals computed
        self.seconds = 0.0  # spent meshing and bounding
        self.triangles = 0  # across the meshed definitions

    def interval(self, a: str, b: str, placement: Any) -> tuple[float, float]:
        """(lower, upper) bounds on the distance pose.interference measures between definition `a`
        and definition `b` placed by `placement` (a pose.Rigid) in a's frame. The lower is 0 where
        none is proved; the upper, the mesh distance plus both deviations, holds always (the
        distance never exceeds the boundaries'), and is inf without both meshes."""
        started = time.perf_counter()
        try:
            self.evaluations += 1
            return self._interval(a, b, placement)
        finally:
            self.seconds += time.perf_counter() - started

    def _interval(self, a: str, b: str, placement: Any) -> tuple[float, float]:
        mesh_a, mesh_b = self.mesh(a), self.mesh(b)
        if mesh_a is None or mesh_b is None:
            return 0.0, float("inf")
        rot, trans = np.asarray(placement.rot, dtype=float), np.asarray(placement.trans, dtype=float)
        distance = self._distance(mesh_a, mesh_b, rot, trans)
        spread = mesh_a.deviation + mesh_b.deviation
        bound = distance - spread
        if bound <= pose.SOLID_GAP_MM or _any_inside(mesh_a, mesh_b.vertices @ rot.T + trans, mesh_b.shell) \
                or _any_inside(mesh_b, (mesh_a.vertices - trans) @ rot, mesh_a.shell):
            return 0.0, distance + spread
        return bound, distance + spread

    def distance(self, a: str, b: str, placement: Any) -> float:
        """The mesh distance itself, 0 for touching meshes: the estimate the interval brackets."""
        mesh_a, mesh_b = self.mesh(a), self.mesh(b)
        if mesh_a is None or mesh_b is None:
            return float("nan")
        return self._distance(mesh_a, mesh_b, np.asarray(placement.rot, dtype=float),
                              np.asarray(placement.trans, dtype=float))

    def spread(self, a: str, b: str) -> float:
        """Both meshes' deviations, the interval's half width around the mesh distance; 0 without both meshes."""
        mesh_a, mesh_b = self.mesh(a), self.mesh(b)
        return 0.0 if mesh_a is None or mesh_b is None else mesh_a.deviation + mesh_b.deviation

    @staticmethod
    def _distance(mesh_a: _Mesh, mesh_b: _Mesh, rot: Any, trans: Any) -> float:
        mesh_b.moving.setTransform(fcl.Transform(rot, trans))
        if fcl.collide(mesh_a.frame, mesh_b.moving, fcl.CollisionRequest(), fcl.CollisionResult()):
            return 0.0  # touching or crossing: fcl's distance is not taken there
        return fcl.distance(mesh_a.frame, mesh_b.moving, fcl.DistanceRequest(), fcl.DistanceResult())

    def mesh(self, key: str) -> _Mesh | None:
        if key not in self.meshes:
            self.meshes[key] = _tessellate(self.shapes[key], self.linear, self.angular)
            self.triangles += self.meshes[key].triangles if self.meshes[key] is not None else 0
        return self.meshes[key]


def _any_inside(container: _Mesh, points: Any, shell: Any) -> bool:
    """Whether a vertex of the other shape (`points` in the container's frame, `shell` their shell
    indices) lies inside a solid of `container`: one vertex per shell meeting each solid's box."""
    for solid in container.solids:
        hits = np.flatnonzero(np.all((points >= solid.low) & (points <= solid.high), axis=1))
        if hits.size == 0:
            continue
        _, first = np.unique(shell[hits], return_index=True)
        if any(solid.holds(points[hits[index]]) for index in first):
            return True
    return False


def _tessellate(shape: Any, linear: float, angular: float) -> _Mesh | None:
    """`shape`'s mesh, or None when a face has no triangulation."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.ShapeAnalysis import ShapeAnalysis_ShapeTolerance
    from OCP.TopAbs import TopAbs_FACE, TopAbs_SHAPE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    copy = BRepBuilderAPI_Copy(shape, True, False).Shape()
    BRepMesh_IncrementalMesh(copy, linear, False, angular, False)
    as_face = getattr(TopoDS, "Face_s", None) or TopoDS.Face
    nodes, triangles, base = [], [], 0
    explorer = TopExp_Explorer(copy, TopAbs_FACE)
    while explorer.More():
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(as_face(explorer.Current()), location)
        if triangulation is None or triangulation.NbTriangles() == 0:
            return None
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
        return None
    model = fcl.BVHModel()
    model.beginModel(len(nodes), len(triangles))
    model.addSubModel(np.asarray(nodes, dtype=float), np.asarray(triangles, dtype=np.int32))
    model.endModel()
    tolerance = ShapeAnalysis_ShapeTolerance().Tolerance(shape, 1, TopAbs_SHAPE)
    vertices, shell = _vertex_shells(shape)
    return _Mesh(model, DEVIATION_FACTOR * linear + tolerance, len(triangles), vertices, shell, _solids(shape),
                 fcl.CollisionObject(model, fcl.Transform()), fcl.CollisionObject(model, fcl.Transform()))


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
