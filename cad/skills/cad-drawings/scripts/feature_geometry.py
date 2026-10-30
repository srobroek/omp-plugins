"""Semantic features bound to a part's final STEP, and the geometry a drawing measures from them.

Both sides import this file, as they do ``freecad_views.py``: ``extract_faces`` and ``bind_patches``
run inside freecadcmd on the shape read from the STEP and return plain data; the rest is pure
Python over that data, so the completeness gate and its tests never import FreeCAD.

Binding (drawing architecture §4.2): a locator patch is a witness point on a final surface with its
outward normal. It binds every STEP face of the patch's support type that the point lies on (within
``BIND_TOLERANCE_MM``) and whose normal there agrees (cosine above ``NORMAL_AGREEMENT``). One match
is a binding; none is ``feature_not_found``; several, or a face two features claim, is
``feature_ambiguous``. Faces are bound afresh on every run: a face index is evidence for the hashed
STEP only, never a stored reference.

All coordinates are model millimetres in the frame ``build`` returned (``assembly_zero``).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

BIND_TOLERANCE_MM = 1e-3      # witness point to face distance: STEP round trip and kernel noise
NORMAL_AGREEMENT = 0.999      # cosine between the witness normal and the face normal at the point
GEOMETRY_EPS = 1e-4           # equal coordinates, radii and axes in measured geometry, mm
DIRECTION_EPS = 1e-6          # parallel or perpendicular unit vectors: 1 - |cos| or |cos|
EDGE_POINTS = 48              # samples along a curved boundary edge
SUPPORT_CLASSES = {
    "Plane": "plane", "Cylinder": "cylinder", "Cone": "cone", "Sphere": "sphere", "Toroid": "torus",
    "BezierSurface": "bezier", "BSplineSurface": "bspline", "SurfaceOfRevolution": "revolution",
    "SurfaceOfExtrusion": "extrusion", "OffsetSurface": "offset",
}
Vector = tuple[float, float, float]


# --- vector helpers -------------------------------------------------------------------------------

def add(a: Sequence[float], b: Sequence[float]) -> Vector:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a: Sequence[float], b: Sequence[float]) -> Vector:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale(a: Sequence[float], k: float) -> Vector:
    return (a[0] * k, a[1] * k, a[2] * k)


def dot(a: Sequence[float], b: Sequence[float]) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Sequence[float], b: Sequence[float]) -> Vector:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a: Sequence[float]) -> float:
    return math.sqrt(dot(a, a))


def unit(a: Sequence[float]) -> Vector:
    length = norm(a)
    if length < 1e-12:
        raise ValueError("cannot normalise a zero vector")
    return scale(a, 1.0 / length)


def parallel(a: Sequence[float], b: Sequence[float]) -> bool:
    return 1.0 - abs(dot(unit(a), unit(b))) < DIRECTION_EPS


def perpendicular(a: Sequence[float], b: Sequence[float]) -> bool:
    return abs(dot(unit(a), unit(b))) < DIRECTION_EPS


def axis_distance(point: Sequence[float], axis_point: Sequence[float], axis_dir: Sequence[float]) -> float:
    offset = sub(point, axis_point)
    return norm(sub(offset, scale(axis_dir, dot(offset, axis_dir))))


# --- FreeCAD side ---------------------------------------------------------------------------------

def _vec(vector: Any) -> list[float]:
    return [round(vector.x, 7), round(vector.y, 7), round(vector.z, 7)]


def _edge_points(edge: Any) -> list[list[float]]:
    straight = type(edge.Curve).__name__ in ("Line", "LineSegment")
    return [_vec(p) for p in edge.discretize(Number=9 if straight else EDGE_POINTS)]


def _ray_state(shape: Any, start: Any, direction: Any, length: float) -> str:
    """What lies along a bore axis beyond one end: ``floor`` (material at once), ``cavity`` or ``open``."""
    import Part  # noqa: PLC0415 - FreeCAD exists only inside freecadcmd

    inside = Part.makeLine(start + direction * 0.01, start + direction * length).common(shape)
    if not inside.Edges:
        return "open"
    nearest = min((vertex.Point - start).Length for vertex in inside.Vertexes)
    return "floor" if nearest < 0.02 else "cavity"


def _box(face: Any) -> Any:
    """The face's exact bounding box: FreeCAD's quick ``BoundBox`` can cut off part of a torus face."""
    return face.optimalBoundingBox(False, False)


def extract_faces(shape: Any) -> list[dict[str, Any]]:
    """Plain geometry of every face of a FreeCAD shape: surface parameters, edges, neighbours, samples."""
    import FreeCAD as App  # noqa: PLC0415

    owners: dict[int, set[int]] = {}
    for index, face in enumerate(shape.Faces):
        for edge in face.Edges:
            owners.setdefault(edge.hashCode(), set()).add(index)
    diagonal = shape.BoundBox.DiagonalLength
    records = []
    for index, face in enumerate(shape.Faces):
        surface = face.Surface
        support = SUPPORT_CLASSES.get(type(surface).__name__, "other")
        box = _box(face)
        u0, u1, v0, v1 = face.ParameterRange
        mid_u, mid_v = (u0 + u1) / 2, (v0 + v1) / 2
        record: dict[str, Any] = {
            "index": index, "support_type": support, "area_mm2": face.Area,
            "bbox": [box.XMin, box.YMin, box.ZMin, box.XMax, box.YMax, box.ZMax],
            "edges": [], "samples": []}
        for edge in face.Edges:
            if edge.Degenerated:  # a collapsed edge (sphere pole, cone apex) has no curve
                continue
            others = sorted(owners.get(edge.hashCode(), set()) - {index})
            entry: dict[str, Any] = {"neighbour": others[0] if others else None, "points": _edge_points(edge)}
            curve = edge.Curve
            if type(curve).__name__ == "Circle":
                entry["circle"] = {"centre": _vec(curve.Center), "radius": curve.Radius, "axis": _vec(curve.Axis),
                                   "closed": bool(edge.isClosed())}
            record["edges"].append(entry)
        for i in range(1, 8):
            for j in range(1, 8):
                u, v = u0 + (u1 - u0) * i / 8, v0 + (v1 - v0) * j / 8
                point = face.valueAt(u, v)
                if face.isInside(point, 1e-6, True):
                    record["samples"].append(_vec(point) + _vec(face.normalAt(u, v)))
        normal = face.normalAt(mid_u, mid_v)
        on_surface = face.valueAt(mid_u, mid_v)
        if support == "plane":
            record.update(point=_vec(face.CenterOfMass), normal=_vec(normal))
        elif support in ("cylinder", "cone", "torus", "sphere"):
            axis = App.Vector(surface.Axis) if support != "sphere" else App.Vector(0, 0, 1)
            centre = App.Vector(surface.Apex if support == "cone" else surface.Center)
            radial = on_surface - centre
            radial = radial - axis * radial.dot(axis)
            record.update(axis_point=_vec(centre), axis_dir=_vec(axis))
            if support == "cylinder":
                record["radius"] = surface.Radius
            elif support == "cone":
                record["semi_angle_deg"] = math.degrees(abs(surface.SemiAngle))
            elif support == "torus":
                record.update(major_radius=surface.MajorRadius, radius=surface.MinorRadius)
                tube = centre + (radial.normalize() * surface.MajorRadius if radial.Length > 1e-9 else App.Vector())
                radial = on_surface - tube
            else:
                record["radius"] = surface.Radius
                radial = on_surface - centre
            record["inward"] = bool(radial.Length > 1e-9 and normal.dot(radial) < 0)
            if support in ("cylinder", "cone"):
                along = [App.Vector(*p).sub(centre).dot(axis) for e in record["edges"] for p in e["points"]]
                record["axial"] = [min(along), max(along)]
                record["span_deg"] = math.degrees(u1 - u0)
            if support == "cylinder" and record["inward"] and record["span_deg"] > 359.0:
                start = centre + axis * record["axial"][0]
                end = centre + axis * record["axial"][1]
                record["ends"] = [_ray_state(shape, start, -axis, diagonal), _ray_state(shape, end, axis, diagonal)]
        records.append(record)
    return records


def bind_patches(shape: Any, locators: Mapping[str, Mapping[str, Any]]) -> dict[str, list[list[int]]]:
    """For each feature, the face indices each of its patches binds (plain data; findings are pure)."""
    import FreeCAD as App  # noqa: PLC0415
    import Part  # noqa: PLC0415

    faces = shape.Faces
    supports = [SUPPORT_CLASSES.get(type(face.Surface).__name__, "other") for face in faces]
    boxes = [_box(face) for face in faces]
    bound: dict[str, list[list[int]]] = {}
    for feature_id, locator in sorted(locators.items()):
        matches_per_patch = []
        for patch in locator["patches"]:
            point = App.Vector(*patch["point_mm"])
            normal = App.Vector(*patch["normal"])
            matches = []
            for index, face in enumerate(faces):
                box = boxes[index]
                if supports[index] != patch["support_type"] or not (
                        box.XMin - BIND_TOLERANCE_MM <= point.x <= box.XMax + BIND_TOLERANCE_MM
                        and box.YMin - BIND_TOLERANCE_MM <= point.y <= box.YMax + BIND_TOLERANCE_MM
                        and box.ZMin - BIND_TOLERANCE_MM <= point.z <= box.ZMax + BIND_TOLERANCE_MM):
                    continue
                if face.distToShape(Part.Vertex(point))[0] > BIND_TOLERANCE_MM:
                    continue
                u, v = face.Surface.parameter(point)
                if face.normalAt(u, v).dot(normal) < NORMAL_AGREEMENT:
                    continue
                matches.append(index)
            matches_per_patch.append(matches)
        bound[feature_id] = matches_per_patch
    return bound


# --- pure side: faces, bound features and findings --------------------------------------------------

@dataclass(frozen=True)
class Edge:
    neighbour: int | None
    points: tuple[Vector, ...]
    circle: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class Face:
    """One STEP face as ``extract_faces`` reported it."""

    index: int
    support_type: str
    area_mm2: float
    bbox: tuple[float, ...]
    edges: tuple[Edge, ...]
    samples: tuple[tuple[float, ...], ...]
    point: Vector | None = None          # plane: centroid
    normal: Vector | None = None         # plane: outward normal
    axis_point: Vector | None = None     # cylinder, cone (apex), torus, sphere centre
    axis_dir: Vector | None = None
    radius: float | None = None          # cylinder, sphere; torus minor radius
    major_radius: float | None = None
    semi_angle_deg: float | None = None
    inward: bool | None = None           # material outside the surface: bores, concave fillets
    axial: tuple[float, float] | None = None
    span_deg: float | None = None
    ends: tuple[str, str] | None = None  # full inward cylinders: beyond axial[0] and axial[1]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Face:
        def vec(key: str) -> Vector | None:
            value = data.get(key)
            return None if value is None else (float(value[0]), float(value[1]), float(value[2]))

        return cls(
            index=int(data["index"]), support_type=str(data["support_type"]), area_mm2=float(data["area_mm2"]),
            bbox=tuple(float(v) for v in data["bbox"]),
            edges=tuple(Edge(e.get("neighbour"), tuple(tuple(float(c) for c in p) for p in e["points"]),
                             e.get("circle")) for e in data["edges"]),
            samples=tuple(tuple(float(c) for c in s) for s in data.get("samples", ())),
            point=vec("point"), normal=vec("normal"), axis_point=vec("axis_point"), axis_dir=vec("axis_dir"),
            radius=data.get("radius"), major_radius=data.get("major_radius"), semi_angle_deg=data.get("semi_angle_deg"),
            inward=data.get("inward"), axial=tuple(data["axial"]) if data.get("axial") else None,
            span_deg=data.get("span_deg"), ends=tuple(data["ends"]) if data.get("ends") else None)

    def boundary_points(self) -> Iterable[Vector]:
        for edge in self.edges:
            yield from edge.points

    def neighbours(self) -> set[int]:
        return {e.neighbour for e in self.edges if e.neighbour is not None}


@dataclass(frozen=True)
class Trace:
    """Two planes' lines on a reference plane: a width or wall thickness stated at that plane (ISO 129-1).

    ``first`` and ``second`` are points on the two lines, ``second`` straight across from ``first``;
    ``along`` is the lines' direction and ``across`` the unit direction from the first line to the second."""

    width: float
    first: Vector
    second: Vector
    along: Vector
    across: Vector


def plane_trace(face: Face, ref: Face) -> tuple[Vector, Vector] | None:
    """Where the plane of ``face`` meets the plane of ``ref``: a point on that line and its unit direction;
    None when the planes are parallel."""
    n, d = unit(face.normal), unit(ref.normal)
    along = cross(n, d)
    if norm(along) < 1e-9:
        return None
    along = unit(along)
    toward = cross(n, along)   # in the face's plane, across its line on the reference plane
    return add(face.point, scale(toward, dot(sub(ref.point, face.point), d) / dot(toward, d))), along


def trace_at(first: Face, second: Face, ref: Face) -> Trace | None:
    """The width between two planes at a reference plane: the distance between their lines on it, when those
    lines are parallel (two planes parallel to each other, or two inclined flanks or drafted faces)."""
    a, b = plane_trace(first, ref), plane_trace(second, ref)
    if a is None or b is None or not parallel(a[1], b[1]):
        return None
    foot = add(b[0], scale(a[1], dot(sub(a[0], b[0]), a[1])))
    gap = sub(foot, a[0])
    if norm(gap) < 1e-9:
        return None
    return Trace(norm(gap), a[0], foot, a[1], unit(gap))


def reach(face: Face, ref: Face) -> float:
    """How far the face's boundary stays from the reference plane: 0 when they share an edge."""
    d = unit(ref.normal)
    return min((abs(dot(sub(p, ref.point), d)) for p in face.boundary_points()), default=math.inf)


def side_by_side(first: Face, second: Face, along: Vector) -> bool:
    """Whether two faces overlap along a direction: a pair across one wall or flank, not two separate features."""
    spans = [[dot(p, along) for p in face.boundary_points()] for face in (first, second)]
    if not spans[0] or not spans[1]:
        return False
    return min(max(spans[0]), max(spans[1])) - max(min(spans[0]), min(spans[1])) > GEOMETRY_EPS


@dataclass(frozen=True)
class ResolvedFeature:
    """A semantic feature bound to this run's STEP: its faces, their regions, anchors and relations."""

    id: str
    kind: str
    faces: tuple[int, ...]
    regions: Mapping[int, str] = field(default_factory=dict)
    anchors: Mapping[str, Mapping[str, Any]] = field(default_factory=dict)
    relations: Mapping[str, tuple[str, ...]] = field(default_factory=dict)


@dataclass(frozen=True)
class Binding:
    features: Mapping[str, ResolvedFeature]
    owner: Mapping[int, str]                 # face index -> feature id
    findings: tuple[Mapping[str, Any], ...]


def resolve(locators: Mapping[str, Mapping[str, Any]], bound: Mapping[str, Sequence[Sequence[int]]],
            faces: Sequence[Face]) -> Binding:
    """Turn raw patch matches into features; report unbound, ambiguous, overlapping and unassigned geometry."""
    findings: list[dict[str, Any]] = []
    features: dict[str, ResolvedFeature] = {}
    owner: dict[int, str] = {}
    for feature_id, locator in sorted(locators.items()):
        face_ids: list[int] = []
        regions: dict[int, str] = {}
        for number, (patch, matches) in enumerate(zip(locator["patches"], bound.get(feature_id, ()))):
            if not matches:
                findings.append({"code": "feature_not_found", "feature": feature_id,
                                 "message": f"{feature_id} patch {number} ({patch['support_type']} at "
                                            f"{_fmt(patch['point_mm'])}) lies on no face of that type"})
                continue
            if len(matches) > 1:
                findings.append({"code": "feature_ambiguous", "feature": feature_id,
                                 "message": f"{feature_id} patch {number} lies on faces {matches}"})
                continue
            index = matches[0]
            if index not in face_ids:
                face_ids.append(index)
            if "region" in patch:
                regions[index] = patch["region"]
        for index in face_ids:
            if index in owner:
                findings.append({"code": "feature_ambiguous", "feature": feature_id,
                                 "message": f"face {index} is claimed by {owner[index]} and {feature_id}"})
            else:
                owner[index] = feature_id
        features[feature_id] = ResolvedFeature(
            id=feature_id, kind=locator["kind"], faces=tuple(sorted(face_ids)), regions=regions,
            anchors=locator.get("anchors", {}),
            relations={k: tuple(v) for k, v in locator.get("relations", {}).items()})
    for face in faces:
        if face.index not in owner:
            findings.append({"code": "geometry_unaccounted", "face": face.index,
                             "message": f"face {face.index} ({face.support_type}, {face.area_mm2:.3f} mm2, bbox "
                                        f"{_fmt(face.bbox)}) belongs to no feature"})
    return Binding(features=features, owner=owner, findings=tuple(findings))


def _fmt(values: Iterable[float]) -> str:
    return "(" + ", ".join(f"{v:.3f}" for v in values) + ")"
