"""Manufacturing features recognised on a part's final B-rep: what a complete drawing must dimension.

Two stages. ``facts`` asks the solid, through a ``Probe``, the only questions faces cannot answer:
each shared edge's convexity (material beside the edge), which opposed planes have material between
them (rays through the part), and which faces are seen from outside. ``classify`` is pure over the
face records of ``feature_geometry.extract_faces`` and those facts, with no locator and no intent:

- ``hole``: inward cylinders on one axis, through or blind, grouped by diameter and depth into one
  feature per hole size, with their floors and drill-point cones;
- ``boss``, ``shaft``, ``groove``: outward cylinders standing on a base face, free, or between two
  shoulders;
- ``pocket``, ``cutout``, ``slot``, ``notch``: side walls along one direction joined by concave or
  tangent edges around an opening, closed by a floor (pocket), open through the material at both
  ends (cutout), two parallel walls with two end radii (slot), or open to the outline (notch);
- ``boss``, ``rib``: side walls joined by convex or tangent edges standing on a base face, a rib when
  one width is thin against the other;
- ``step``: a single riser between a lower and an upper face facing the same way;
- ``wall``: two opposed planes with material between them, thin against their extent: shell walls,
  plates, floors and roofs, sized by their thickness; two faces drafted against each other by up to
  ``DRAFT_MAX_DEG`` are sized at the plane both end on (the rim), with each drafted face's angle;
- ``round`` (tangent blend cylinders, tori, spheres), ``chamfer`` (cones and narrow bevel planes
  between two convex edges), ``taper``, ``dish`` (an inward sphere opening through a plane: its
  radius, SR, and its depth below that plane);
- ``engraving``: shallow recesses of one depth in one face, one of them with a freeform wall (text);
- ``outline``: unclaimed faces seen from outside the part, its envelope.

A recess's or protrusion's two walls that are not parallel to each other, at least one inclined,
have their width at its rim or top: the distance between the lines where they meet that plane
(``Size.at``), as ISO 129-1 states a width between inclined flanks.

Each feature lists the sizes a complete drawing states (``Size``) and whether every face is a plane,
cylinder or cone (``prismatic``): a prismatic feature has sizes a drawing can and must state; other
geometry may be defined by the model within a profile tolerance. Faces no pattern matches are
returned in ``unrecognized`` with the reason. freecadcmd runs ``facts`` with ``SolidProbe``; tests
can classify any face list with recorded facts.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

import feature_geometry as fg
from drawing_intent import Instance, cylinder_instances
from feature_geometry import Face, Vector

EPS = 1e-3                 # equal sizes and coplanar faces in recognition, mm
PROBE_STEP_MM = 0.02       # how far beside an edge the convexity probe looks
SMOOTH_COS = 0.9986        # tangent edges: the two face normals within 3 degrees
THIN_RATIO = 0.35          # a rib's thickness against its other width
WALL_RATIO = 0.2           # a wall's thickness against the longer extent of its smaller face
CHAMFER_MAX_MM = 5.0
ENGRAVING_MAX_DEPTH_MM = 2.0
SPAN_SAMPLES = 3           # samples of each plane face cast through the material to the opposite face
DRAFT_MAX_DEG = 10.0       # a wall's two faces drafted against each other by up to this are still one wall
DRAFT_COS = math.cos(math.radians(DRAFT_MAX_DEG))
PRISMATIC = ("plane", "cylinder", "cone")
RECESSES = ("pocket", "cutout", "slot", "notch", "hole", "dish")


class Probe(Protocol):
    def material(self, points: Sequence[Vector]) -> list[bool]:
        """Whether each point lies inside the solid."""

    def intervals(self, start: Vector, direction: Vector, length: float) -> list[tuple[float, float]]:
        """The material intervals ``[t0, t1]`` along the ray ``start + t * direction``, 0 <= t <= length."""


# --- results --------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Size:
    """A size a complete drawing states: its value measured on these faces, or between two face sets.

    ``at`` is the reference plane a size between non-parallel planes is stated at: a drafted wall's
    thickness at its rim, a width between inclined flanks at the plane they meet."""

    name: str                      # diameter, radius, depth, width, length, thickness, height, chamfer, angle
    value: float
    faces: tuple[int, ...]
    between: tuple[tuple[int, ...], tuple[int, ...]] | None = None
    direction: Vector | None = None
    at: tuple[int, ...] | None = None

    def to_dict(self) -> dict[str, Any]:
        found: dict[str, Any] = {"name": self.name, "value_mm": round(self.value, 6), "faces": list(self.faces)}
        if self.between is not None:
            found["between"] = [list(self.between[0]), list(self.between[1])]
        if self.direction is not None:
            found["direction"] = [round(c, 6) for c in self.direction]
        if self.at is not None:
            found["at"] = list(self.at)
        return found

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Size:
        between, direction, at = data.get("between"), data.get("direction"), data.get("at")
        return cls(data["name"], float(data["value_mm"]), tuple(data["faces"]),
                   (tuple(between[0]), tuple(between[1])) if between else None,
                   tuple(float(c) for c in direction) if direction else None,
                   tuple(at) if at else None)


@dataclass(frozen=True)
class Recognized:
    """One manufacturing feature: its category, faces, the sizes to state and the locator kind that states them."""

    id: str
    category: str
    faces: tuple[int, ...]
    sizes: tuple[Size, ...]
    locator_kind: str              # the drawing_features kind a draft proposes for these faces
    prismatic: bool
    direction: Vector | None = None
    details: Mapping[str, Any] = field(default_factory=dict)

    def describe(self) -> str:
        count = self.details.get("instances", 1)
        sizes = ", ".join(f"{s.name} {s.value:g}" for s in self.sizes)
        return f"{self.id} ({self.category}{f' ×{count}' if count > 1 else ''}{': ' + sizes if sizes else ''})"

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "category": self.category, "faces": list(self.faces),
                "sizes": [s.to_dict() for s in self.sizes], "locator_kind": self.locator_kind,
                "prismatic": self.prismatic,
                "direction": None if self.direction is None else [round(c, 6) for c in self.direction],
                "details": _plain(self.details)}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Recognized:
        direction = data.get("direction")
        return cls(data["id"], data["category"], tuple(data["faces"]), tuple(Size.from_dict(s) for s in data["sizes"]),
                   data["locator_kind"], bool(data["prismatic"]),
                   tuple(float(c) for c in direction) if direction else None, dict(data.get("details") or {}))


@dataclass(frozen=True)
class Recognition:
    features: tuple[Recognized, ...]
    unrecognized: tuple[Mapping[str, Any], ...]     # {face, support_type, area_mm2, reason}

    def to_dict(self) -> dict[str, Any]:
        return {"features": [f.to_dict() for f in self.features], "unrecognized": [dict(u) for u in self.unrecognized]}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Recognition:
        return cls(tuple(Recognized.from_dict(f) for f in data["features"]), tuple(dict(u) for u in data["unrecognized"]))


@dataclass(frozen=True)
class Facts:
    """What the solid says about its faces: edge convexity, material spans and exposure."""

    convexity: Mapping[tuple[int, int], str]        # (a, b), a < b: convex, concave or smooth
    spans: tuple[tuple[int, int, float], ...]       # (a, b, thickness): opposed planes with material between, a < b
    exposed: frozenset[int]                         # faces a ray out along the normal leaves without meeting material

    def to_dict(self) -> dict[str, Any]:
        return {"convexity": [[a, b, kind] for (a, b), kind in sorted(self.convexity.items())],
                "spans": [[a, b, round(t, 6)] for a, b, t in self.spans], "exposed": sorted(self.exposed)}

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> Facts:
        return cls({(int(a), int(b)): str(k) for a, b, k in data["convexity"]},
                   tuple((int(a), int(b), float(t)) for a, b, t in data["spans"]), frozenset(data["exposed"]))


def _plain(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, float):
        return round(value, 6)
    return value


# --- geometry helpers ----------------------------------------------------------------------------

def _basis(normal: Vector) -> tuple[Vector, Vector]:
    helper = (1.0, 0.0, 0.0) if abs(normal[0]) < 0.9 else (0.0, 1.0, 0.0)
    u = fg.unit(fg.cross(normal, helper))
    return u, fg.cross(fg.unit(normal), u)


def _canonical(direction: Vector) -> Vector:
    """One sense per line direction: the first clearly non-zero component positive."""
    d = fg.unit(direction)
    for c in d:
        if abs(c) > 1e-6:
            return d if c > 0 else fg.scale(d, -1.0)
    return d


def _extent(points: Iterable[Sequence[float]], direction: Vector) -> tuple[float, float]:
    values = [fg.dot(p, direction) for p in points]
    return min(values), max(values)


def _mid(edge: fg.Edge) -> Vector:
    return edge.points[len(edge.points) // 2]


def _straight_along(edge: fg.Edge, direction: Vector) -> bool:
    if len(edge.points) < 2:
        return False
    chord = fg.sub(edge.points[-1], edge.points[0])
    if fg.norm(chord) < EPS or not fg.parallel(chord, direction):
        return False
    along = fg.unit(chord)
    return all(fg.norm(fg.cross(fg.sub(p, edge.points[0]), along)) < EPS for p in edge.points)


def _spread(face: Face, count: int) -> list[tuple[Vector, Vector]]:
    """Up to ``count`` samples spread over the face, each a point and its outward normal."""
    if not face.samples:
        return []
    picks = dict.fromkeys(face.samples[k * (len(face.samples) - 1) // max(1, count - 1)] for k in range(count))
    return [(tuple(s[:3]), fg.unit(s[3:6])) for s in picks]


def normal_at(face: Face, point: Vector) -> Vector:
    """Outward unit normal of ``face`` at a point on it (analytic for planes, cylinders and spheres)."""
    if face.support_type == "plane":
        return fg.unit(face.normal)
    if face.support_type in ("cylinder", "sphere") and face.axis_point is not None:
        offset = fg.sub(point, face.axis_point)
        if face.support_type == "cylinder":
            d = fg.unit(face.axis_dir)
            offset = fg.sub(offset, fg.scale(d, fg.dot(offset, d)))
        if fg.norm(offset) > 1e-9:
            n = fg.unit(offset)
            return fg.scale(n, -1.0) if face.inward else n
    if face.samples:
        nearest = min(face.samples, key=lambda s: fg.norm(fg.sub(s[:3], point)))
        return fg.unit(nearest[3:6])
    return fg.unit(face.normal) if face.normal else (0.0, 0.0, 1.0)


class PlaneRegion:
    """A plane face's boundary in its own 2D basis: point-in-face by even-odd crossings over every edge."""

    def __init__(self, face: Face) -> None:
        self.origin = face.point
        self.u, self.v = _basis(fg.unit(face.normal))
        self.segments: list[tuple[tuple[float, float], tuple[float, float]]] = []
        for edge in face.edges:
            pts = [self._uv(p) for p in edge.points]
            self.segments.extend(zip(pts, pts[1:]))
        xs = [c for s in self.segments for c in (s[0][0], s[1][0])] or [0.0]
        ys = [c for s in self.segments for c in (s[0][1], s[1][1])] or [0.0]
        self.box = (min(xs), min(ys), max(xs), max(ys))

    def _uv(self, point: Sequence[float]) -> tuple[float, float]:
        offset = fg.sub(point, self.origin)
        return fg.dot(offset, self.u), fg.dot(offset, self.v)

    def contains(self, point: Vector) -> bool:
        x, y = self._uv(point)
        x0, y0, x1, y1 = self.box
        if not (x0 - EPS <= x <= x1 + EPS and y0 - EPS <= y <= y1 + EPS):
            return False
        inside = False
        for (ax, ay), (bx, by) in self.segments:
            if (ay > y) != (by > y) and ax + (y - ay) * (bx - ax) / (by - ay) > x:
                inside = not inside
        return inside

    def longest(self) -> float:
        x0, y0, x1, y1 = self.box
        return max(x1 - x0, y1 - y0)

    def shortest(self) -> float:
        x0, y0, x1, y1 = self.box
        return min(x1 - x0, y1 - y0)


# --- facts (the probe) ----------------------------------------------------------------------------

def _shared(faces: Sequence[Face]) -> dict[tuple[int, int], list[fg.Edge]]:
    shared: dict[tuple[int, int], list[fg.Edge]] = {}
    for face in faces:
        for edge in face.edges:
            if edge.neighbour is not None and edge.neighbour != face.index:
                shared.setdefault((min(face.index, edge.neighbour), max(face.index, edge.neighbour)), []).append(edge)
    return shared


def facts(faces: Sequence[Face], probe: Probe) -> Facts:
    index = {f.index: f for f in faces}
    convexity: dict[tuple[int, int], str] = {}
    for (a, b), edges in _shared(faces).items():
        point = _mid(max(edges, key=lambda e: len(e.points)))
        na, nb = normal_at(index[a], point), normal_at(index[b], point)
        if fg.dot(na, nb) > SMOOTH_COS:
            convexity[(a, b)] = "smooth"
        else:
            beside = fg.add(point, fg.scale(fg.unit(fg.sub(na, nb)), PROBE_STEP_MM))
            convexity[(a, b)] = "concave" if probe.material([beside])[0] else "convex"
    lo = [min(f.bbox[k] for f in faces) for k in range(3)]
    hi = [max(f.bbox[k + 3] for f in faces) for k in range(3)]
    reach = 2 * math.dist(lo, hi) + 1.0
    planes = [f for f in faces if f.support_type == "plane" and f.normal]
    regions = {f.index: PlaneRegion(f) for f in planes}
    spans: dict[tuple[int, int], float] = {}
    for a in planes:
        n = fg.unit(a.normal)
        for sample, _ in _spread(a, SPAN_SAMPLES):
            start = fg.add(sample, fg.scale(n, 0.01))
            inside = [iv for iv in probe.intervals(start, fg.scale(n, -1.0), reach) if iv[0] < 0.05]
            if not inside:
                continue
            exit_point = fg.sub(start, fg.scale(n, inside[0][1]))
            for b in planes:   # the opposite face: parallel, or drafted against this one by up to DRAFT_MAX_DEG
                if b.index != a.index and fg.dot(n, fg.unit(b.normal)) < -DRAFT_COS \
                        and abs(fg.dot(fg.sub(exit_point, b.point), b.normal)) < 10 * EPS and regions[b.index].contains(exit_point):
                    key = (min(a.index, b.index), max(a.index, b.index))
                    spans[key] = min(spans.get(key, math.inf), inside[0][1] - 0.01)
                    break
    exposed = set()
    for face in faces:   # seen from outside at most of its samples: a window in an opposite wall is not enough
        seen = [not probe.intervals(fg.add(point, fg.scale(normal, 0.01)), normal, reach)
                for point, normal in _spread(face, SPAN_SAMPLES)]
        if seen and 2 * sum(seen) > len(seen):
            exposed.add(face.index)
    return Facts(convexity, tuple((a, b, t) for (a, b), t in sorted(spans.items())), frozenset(exposed))


class SolidProbe:
    """The FreeCAD-side probe on a solid (freecadcmd only)."""

    def __init__(self, shape: Any) -> None:
        import FreeCAD as App  # noqa: PLC0415 - FreeCAD exists only inside freecadcmd
        import Part  # noqa: PLC0415

        self.shape, self._vector, self._line = shape, App.Vector, Part.makeLine

    def material(self, points: Sequence[Vector]) -> list[bool]:
        return [bool(self.shape.isInside(self._vector(*p), 1e-6, False)) for p in points]

    def intervals(self, start: Vector, direction: Vector, length: float) -> list[tuple[float, float]]:
        origin, d = self._vector(*start), self._vector(*fg.unit(direction))
        common = self._line(origin, origin + d * length).common(self.shape)
        found = []
        for edge in common.Edges:
            ts = sorted((v.Point - origin).dot(d) for v in edge.Vertexes)
            if ts:
                found.append((ts[0], ts[-1]))
        return sorted(found)


# --- classification -------------------------------------------------------------------------------

class _Classifier:
    def __init__(self, faces: Sequence[Face], known: Facts) -> None:
        self.faces = {f.index: f for f in faces}
        self.facts = known
        self.shared = _shared(faces)
        self.found: list[Recognized] = []
        self.claimed: dict[int, list[Recognized]] = {}
        self.counts: dict[str, int] = {}

    # bookkeeping -----------------------------------------------------------------------------------
    def add(self, category: str, faces: Iterable[int], sizes: Sequence[Size], locator_kind: str,
            direction: Vector | None = None, **details: Any) -> Recognized:
        faces = tuple(sorted(set(faces)))
        self.counts[category] = self.counts.get(category, 0) + 1
        prismatic = all(self.faces[i].support_type in PRISMATIC for i in faces)
        item = Recognized(f"{category}_{self.counts[category]}", category, faces, self.merged(sizes),
                          locator_kind if prismatic or locator_kind in ("round", "engraving", "chamfer") else "surface",
                          prismatic, None if direction is None else _canonical(direction), details)
        self.found.append(item)
        for index in faces:
            self.claimed.setdefault(index, []).append(item)
        return item

    def merged(self, sizes: Sequence[Size]) -> tuple[Size, ...]:
        """One size per name, value and direction: faces split by a cut state the same size once."""
        found: dict[tuple[Any, ...], Size] = {}
        for size in sizes:
            direction = None if size.direction is None else _canonical(size.direction)
            between = size.between
            if between and direction is not None and between[0] and between[1] \
                    and all(self.faces[side[0]].point is not None for side in between) \
                    and self.level(between[0][0], direction) > self.level(between[1][0], direction):
                between = (between[1], between[0])
            key = (size.name, round(size.value, 3), direction, size.at is not None)
            if key in found:
                old = found[key]
                faces = tuple(sorted({*old.faces, *size.faces}))
                sides = None if old.between is None or between is None else (
                    tuple(sorted({*old.between[0], *between[0]})), tuple(sorted({*old.between[1], *between[1]})))
                at = None if old.at is None else tuple(sorted({*old.at, *size.at}))
                found[key] = Size(old.name, old.value, faces, sides, old.direction, at)
            else:
                found[key] = Size(size.name, size.value, size.faces, between, direction, size.at)
        return tuple(found.values())

    def kind(self, a: int, b: int) -> str:
        return self.facts.convexity.get((min(a, b), max(a, b)), "none")

    def neighbours(self, index: int) -> set[int]:
        return {n for n in self.faces[index].neighbours() if n != index}

    def categories(self, index: int) -> set[str]:
        return {item.category for item in self.claimed.get(index, ())}

    def level(self, index: int, d: Vector) -> float:
        return fg.dot(self.faces[index].point, d)

    # cylinders -------------------------------------------------------------------------------------
    def _edges_of(self, inst: Instance, axial: bool) -> list[tuple[int, int]]:
        own = set(inst.faces)
        return [(i, e.neighbour) for i in inst.faces for e in self.faces[i].edges
                if e.neighbour is not None and e.neighbour not in own and _straight_along(e, inst.axis_dir) == axial]

    def cylinders(self) -> None:
        holes: dict[tuple[Any, ...], list[tuple[Instance, list[int], list[int]]]] = {}
        arcs: dict[tuple[Any, ...], list[Instance]] = {}
        for inward in (True, False):
            cylinders = [f for f in self.faces.values() if f.support_type == "cylinder" and bool(f.inward) == inward]
            for inst in cylinder_instances(cylinders):
                if sum(self.faces[i].span_deg or 0.0 for i in inst.faces) < 359.0:
                    axial = self._edges_of(inst, axial=True)
                    if axial and all(self.kind(a, b) == "smooth" for a, b in axial):
                        self.add("round", inst.faces, [Size("radius", inst.radius, inst.faces)], "round",
                                 inst.axis_dir, internal=inward)
                    else:   # a contour radius: it defines the shape, so it is dimensioned and located
                        arcs.setdefault((round(inst.radius, 4), _canonical(inst.axis_dir), inward), []).append(inst)
                    continue
                ends = self._edges_of(inst, axial=False)
                if inward:
                    floors = sorted({b for a, b in ends if self.kind(a, b) == "concave"
                                     and self.faces[b].support_type in ("plane", "cone")})
                    entries = sorted({b for a, b in ends if self.kind(a, b) == "convex"
                                      and self.faces[b].support_type == "plane"})
                    channel = any(self.kind(a, b) == "smooth" and self.faces[b].support_type not in PRISMATIC
                                  for a, b in ends)
                    depth = round(inst.t1 - inst.t0, 3) if floors else None
                    key = (round(2 * inst.radius, 4), _canonical(inst.axis_dir), depth, channel)
                    holes.setdefault(key, []).append((inst, floors, entries))
                else:
                    self._outward(inst, ends)
        for (diameter, direction, depth, channel), group in sorted(holes.items(), key=lambda kv: repr(kv[0])):
            walls = tuple(i for inst, _, _ in group for i in inst.faces)
            floors = tuple(i for _, fl, _ in group for i in fl)
            entries = tuple(sorted({i for _, _, en in group for i in en}))
            sizes = [Size("diameter", diameter, walls)]
            if depth is not None:
                planes = tuple(i for i in floors if self.faces[i].support_type == "plane")
                sizes.append(Size("depth", depth, walls + floors, (entries, planes) if entries and planes else None,
                                  direction))
            self.add("hole", walls + floors, sizes, "bore", direction, instances=len(group), through=depth is None,
                     channel=channel, axes=[inst.axis_point for inst, _, _ in group])
        for (radius, direction, inward), group in sorted(arcs.items(), key=lambda kv: repr(kv[0])):
            faces = tuple(i for inst in group for i in inst.faces)
            self.add("arc", faces, [Size("radius", radius, faces)], "bore" if inward else "shaft", direction,
                     instances=len(group), internal=inward, axes=[inst.axis_point for inst in group])

    def _outward(self, inst: Instance, ends: list[tuple[int, int]]) -> None:
        caps = [(b, self.kind(a, b)) for a, b in ends if self.faces[b].support_type == "plane"
                and fg.parallel(self.faces[b].normal, inst.axis_dir)]
        base = sorted({b for b, k in caps if k == "concave"})
        tops = sorted({b for b, k in caps if k == "convex"})
        sizes = [Size("diameter", 2 * inst.radius, inst.faces)]
        opposed = len(base) == 2 and fg.dot(self.faces[base[0]].normal, self.faces[base[1]].normal) < -1 + 1e-6
        if opposed:
            sizes.append(Size("width", inst.t1 - inst.t0, inst.faces, (tuple(base[:1]), tuple(base[1:])), inst.axis_dir))
            self.add("groove", (*inst.faces, *base), sizes, "groove", inst.axis_dir)
        elif base:
            # a chamfered or rounded end: the boss's height runs to the end plane beyond that blend
            beyond = [] if tops else sorted({n for _, b in ends if self.faces[b].support_type in ("cone", "torus")
                                             for n in self.neighbours(b) if n not in inst.faces
                                             and self.faces[n].support_type == "plane"
                                             and fg.parallel(self.faces[n].normal, inst.axis_dir)})
            ends_at = tops or beyond
            height = inst.t1 - inst.t0 if tops or not beyond else max(
                abs(fg.dot(fg.sub(self.faces[t].point, self.faces[b].point), inst.axis_dir)) for t in beyond for b in base)
            sizes.append(Size("height", height, inst.faces, (tuple(base), tuple(ends_at)), inst.axis_dir))
            self.add("boss", (*inst.faces, *tops), sizes, "shaft", inst.axis_dir, base=base, top=tops)
        else:
            self.add("shaft", inst.faces, sizes, "shaft", inst.axis_dir)

    # blends ----------------------------------------------------------------------------------------
    def blends(self) -> None:
        for face in sorted(self.faces.values(), key=lambda f: f.index):
            if face.index in self.claimed:
                continue
            kinds = {self.kind(face.index, n) for n in self.neighbours(face.index)}
            if face.support_type == "cone":
                if any(self.kind(face.index, n) == "concave" and "hole" in self.categories(n)
                       for n in self.neighbours(face.index)):
                    continue   # a drill point: claimed with its hole's floor
                d = fg.unit(face.axis_dir)
                ts = [fg.dot(fg.sub(p, face.axis_point), d) for p in face.boundary_points()]
                rs = [fg.axis_distance(p, face.axis_point, d) for p in face.boundary_points()]
                axial, radial = max(ts) - min(ts), max(rs) - min(rs)
                if kinds <= {"convex", "smooth"} and max(axial, radial) <= CHAMFER_MAX_MM:
                    self.add("chamfer", [face.index], [Size("chamfer", axial, (face.index,))], "chamfer", d,
                             angle_deg=math.degrees(math.atan2(radial, axial)))
                else:
                    self.add("taper", [face.index], [], "taper", d, semi_angle_deg=face.semi_angle_deg)
            elif face.support_type == "torus":
                self.add("round", [face.index], [Size("radius", face.radius, (face.index,))], "round",
                         internal=bool(face.inward))
            elif face.support_type == "sphere":
                if kinds == {"smooth"}:   # a spherical blend, such as the ball end of a groove
                    self.add("round", [face.index], [Size("radius", face.radius, (face.index,))], "round",
                             internal=bool(face.inward))
                elif face.inward:
                    self._dish(face)
            elif face.support_type == "plane":
                self._bevel(face)

    def _dish(self, face: Face) -> None:
        """An inward sphere: a spherical recess, stated by its radius (SR) and, when it opens through a plane
        across a convex edge, its depth from that plane to the sphere's lowest point."""
        sizes = [Size("radius", face.radius, (face.index,))]
        entries = sorted(n for n in self.neighbours(face.index) if self.kind(face.index, n) == "convex"
                         and self.faces[n].support_type == "plane")
        n = fg.unit(self.faces[entries[0]].normal) if entries else None
        if n is not None:
            rims = tuple(i for i in entries if fg.parallel(self.faces[i].normal, n)
                         and abs(self.level(i, n) - self.level(entries[0], n)) < EPS)
            depth = fg.dot(fg.sub(self.faces[rims[0]].point, face.axis_point), n) + face.radius
            sizes.append(Size("depth", depth, (face.index,), (rims, (face.index,)), n))
        self.add("dish", [face.index], sizes, "surface", n)

    def _bevel(self, face: Face) -> None:
        """A narrow plane strip between two convex edges to non-parallel planes: a planar chamfer."""
        lengths = {n: sum(fg.norm(fg.sub(e.points[-1], e.points[0])) for e in
                          self.shared.get((min(face.index, n), max(face.index, n)), []))
                   for n in self.neighbours(face.index)}
        if len(lengths) < 2:
            return
        a, b = sorted(lengths, key=lambda n: (-lengths[n], n))[:2]
        fa, fb = self.faces[a], self.faces[b]
        if (self.kind(face.index, a), self.kind(face.index, b)) != ("convex", "convex") \
                or fa.support_type != "plane" or fb.support_type != "plane" or fg.parallel(fa.normal, fb.normal) \
                or any(fg.parallel(face.normal, f.normal) or fg.perpendicular(face.normal, f.normal) for f in (fa, fb)):
            return
        pts = list(face.boundary_points())
        legs = [(lambda lo_hi: lo_hi[1] - lo_hi[0])(_extent(pts, fg.unit(f.normal))) for f in (fa, fb)]
        if max(legs) > CHAMFER_MAX_MM or max(legs) > THIN_RATIO * lengths[a]:
            return
        self.add("chamfer", [face.index], [Size("chamfer", legs[0], (face.index,))], "chamfer", face.normal,
                 angle_deg=math.degrees(math.atan2(legs[1], legs[0])), legs=legs)

    def group_blends(self) -> None:
        """One round feature per radius and side, one chamfer per size and angle: a drawing states each once."""
        groups: dict[tuple[Any, ...], list[Recognized]] = {}
        kept = []
        for item in self.found:
            if item.category in ("round", "chamfer"):
                key = (item.category, round(item.sizes[0].value, 3), bool(item.details.get("internal")),
                       round(float(item.details.get("angle_deg", 0.0)), 1))
                groups.setdefault(key, []).append(item)
            else:
                kept.append(item)
        self.found = kept
        for index in list(self.claimed):
            self.claimed[index] = [x for x in self.claimed[index] if x.category not in ("round", "chamfer")]
            if not self.claimed[index]:
                del self.claimed[index]
        self.counts.pop("round", None)
        self.counts.pop("chamfer", None)
        for (category, value, internal, angle), items in sorted(groups.items(), key=lambda kv: repr(kv[0])):
            faces = sorted({i for item in items for i in item.faces})
            directions = {item.direction for item in items}
            details: dict[str, Any] = {"instances": len(items), "internal": internal}
            if category == "chamfer":
                details["angle_deg"] = angle
            self.add(category, faces, [Size(items[0].sizes[0].name, items[0].sizes[0].value, tuple(faces))],
                     category, directions.pop() if len(directions) == 1 else None, **details)

    # recesses and protrusions ------------------------------------------------------------------------
    def components(self, members: set[int]) -> list[list[int]]:
        """Connected groups of ``members`` through their shared edges."""
        seen: set[int] = set()
        found = []
        for start in sorted(members):
            if start in seen:
                continue
            stack, component = [start], []
            seen.add(start)
            while stack:
                index = stack.pop()
                component.append(index)
                for n in sorted(self.neighbours(index)):
                    if n in members and n not in seen:
                        seen.add(n)
                        stack.append(n)
            found.append(sorted(component))
        return found

    def facing(self, component: Sequence[int]) -> float:
        """Positive when the walls face inward (a recess), negative when they face outward (a protrusion)."""
        faces = [self.faces[i] for i in component]
        points = [s[:3] for f in faces for s in f.samples] or [p for f in faces for p in f.boundary_points()]
        centre = tuple(sum(p[k] for p in points) / len(points) for k in range(3))
        score = 0.0
        for f in faces:
            if f.support_type == "plane":
                score += f.area_mm2 * (1.0 if fg.dot(f.normal, fg.sub(centre, f.point)) > 0 else -1.0)
            elif f.support_type in ("cylinder", "cone", "sphere", "torus"):
                score += f.area_mm2 * (1.0 if f.inward else -1.0)
            elif f.samples:
                score += f.area_mm2 * sum(1.0 if fg.dot(s[3:6], fg.sub(centre, s[:3])) > 0 else -1.0
                                          for s in f.samples) / len(f.samples)
        return score

    def pairs(self, component: Sequence[int], facing: bool) -> list[tuple[Face, Face, float]]:
        """Opposed parallel planes facing each other across a gap (facing) or away across material."""
        planes = [self.faces[i] for i in component if self.faces[i].support_type == "plane"]
        found = []
        for i, a in enumerate(planes):
            for b in planes[i + 1:]:
                if fg.dot(a.normal, b.normal) > -1 + 1e-6:
                    continue
                gap = fg.dot(fg.sub(b.point, a.point), fg.unit(a.normal))
                if (gap > EPS) == facing and abs(gap) > EPS:
                    found.append((a, b, abs(gap)))
        return found

    def caps(self, component: Sequence[int], d: Vector, kind: str) -> list[int]:
        """Planes facing along ``d`` across ``kind`` edges of the walls, directly or across a chamfer or round on
        their edge: a recess's rims, a protrusion's tops."""
        own = set(component)
        blends = {n for i in component for n in self.neighbours(i)
                  if n not in own and self.categories(n) & {"chamfer", "round"} and self.kind(i, n) in (kind, "smooth")}
        return sorted({n for i in (*component, *blends) for n in self.neighbours(i) if n not in own and n not in blends
                       and self.kind(i, n) in ((kind,) if i in own else (kind, "smooth"))
                       and self.faces[n].support_type == "plane"
                       and fg.dot(fg.unit(self.faces[n].normal), d) > 1 - 1e-6})

    def rise(self, component: Sequence[int], base: int, d: Vector) -> float:
        """How far the walls reach along ``d`` from the base plane."""
        top = max(fg.dot(p, d) for i in component for p in self.faces[i].boundary_points())
        return top - self.level(base, d)

    def sizes_across(self, component: Sequence[int], facing: bool, d: Vector, at: Sequence[int] = ()) -> list[Size]:
        """Widths between opposed walls, radii of their blends, and each inclined wall's angle to the floor plane.

        Two walls not parallel to each other, at least one inclined, have no width of their own: it is stated
        at the first of the ``at`` planes (a recess's rim, a protrusion's top) that both walls' lines on it are
        parallel, facing each other across the gap (``facing``) or away from each other across material."""
        sizes = [Size("width", gap, (a.index, b.index), ((a.index,), (b.index,)), a.normal)
                 for a, b, gap in self.pairs(component, facing)]
        planes = [self.faces[i] for i in component if self.faces[i].support_type == "plane"]
        for k, a in enumerate(planes):
            for b in planes[k + 1:]:
                if fg.parallel(a.normal, b.normal):
                    continue
                for ref in at:
                    trace = fg.trace_at(a, b, self.faces[ref])
                    if trace is None:
                        continue
                    out_a, out_b = fg.dot(fg.unit(a.normal), trace.across), fg.dot(fg.unit(b.normal), trace.across)
                    if (out_a > EPS and out_b < -EPS) if facing else (out_a < -EPS and out_b > EPS):
                        sizes.append(Size("width", trace.width, (a.index, b.index), ((a.index,), (b.index,)),
                                          trace.across, at=(ref,)))
                        break
        rounds = [self.faces[i] for i in component if "round" in self.categories(i)]
        for radius in sorted({round(f.radius, 4) for f in rounds}):
            sizes.append(Size("radius", radius, tuple(f.index for f in rounds if round(f.radius, 4) == radius)))
        for i in component:
            face = self.faces[i]
            if face.support_type == "plane" and not fg.perpendicular(face.normal, d):
                angle = math.degrees(math.acos(min(1.0, abs(fg.dot(fg.unit(face.normal), d)))))
                sizes.append(Size("angle", angle, (i,)))
        return sizes

    def seeded(self) -> None:
        """Each plane face's concave neighbours, grouped: walls of a recess it floors or of a protrusion it carries."""
        fixed = {i for i, items in self.claimed.items()
                 if any(x.category in ("hole", "boss", "shaft", "groove", "chamfer", "taper", "dish") for x in items)}
        shallow, protrusions, singles = [], [], []
        for floor in sorted(self.faces.values(), key=lambda f: f.index):
            if floor.support_type != "plane" or self.categories(floor.index) & {"hole", "chamfer", "taper"}:
                continue
            d = fg.unit(floor.normal)
            walls = {n for n in self.neighbours(floor.index) if n not in fixed and self.kind(floor.index, n) == "concave"
                     and self.side(self.faces[n], d, inclined=True)}
            blends = {n for n in self.neighbours(floor.index) if self.kind(floor.index, n) == "smooth"
                      and "round" in self.categories(n) and self.faces[n].inward}
            walls |= blends | {w for n in blends for w in self.neighbours(n) if w not in fixed and w != floor.index
                               and self.kind(n, w) == "smooth" and self.side(self.faces[w], d, inclined=True)}
            for component in self.components(self.continued(walls, d, fixed)):
                if all("round" in self.categories(i) for i in component):
                    continue
                if len(component) == 1 and self.faces[component[0]].support_type == "plane":
                    singles.append((floor.index, component[0], d))
                elif self.facing(component) > 0:
                    item = self.recess(floor.index, component, d)
                    if item is not None:
                        shallow.append(item)
                else:
                    protrusions.append((floor.index, component, d))
        engraved = self.engravings(shallow)
        for base, component, d in protrusions:
            self.protrusion(base, component, d, engraved)
        for low, riser, d in singles:
            if not self.categories(riser) - {"round"}:
                self.step(low, riser, d)
        self.cutouts(fixed)

    def continued(self, walls: set[int], d: Vector, fixed: set[int]) -> set[int]:
        """The walls with every side face tangent or coplanar to them: one wall split by a later cut is still one."""
        found, stack = set(walls), list(walls)
        while stack:
            index = stack.pop()
            for n in self.neighbours(index):
                if n not in found and n not in fixed and self.kind(index, n) == "smooth" and self.side(self.faces[n], d) \
                        and not self.categories(n) - {"round"}:
                    found.add(n)
                    stack.append(n)
        return found

    def side(self, face: Face, d: Vector, inclined: bool = False) -> bool:
        """A wall along ``d``: a plane parallel to it (or, ``inclined``, any plane across it), a cylinder on an axis
        along it, or a freeform face swept along it."""
        if face.support_type == "plane":
            return fg.perpendicular(face.normal, d) or (inclined and not fg.parallel(face.normal, d))
        if face.support_type == "cylinder":
            return fg.parallel(face.axis_dir, d)
        if face.support_type in ("cone", "sphere", "torus"):
            return False
        return bool(face.samples) and all(abs(fg.dot(fg.unit(s[3:6]), d)) < 1e-3 for s in face.samples)

    def open_sides(self, floor: int, component: Sequence[int], d: Vector) -> list[int]:
        """Outer faces the floor or walls drop off to across convex edges: where the recess opens to the outline."""
        own = {floor, *component}
        found = set()
        for i in own:
            for n in self.neighbours(i):
                face = self.faces[n]
                if n in own or self.kind(i, n) != "convex" or n not in self.facts.exposed \
                        or self.categories(n) & {"hole", "chamfer", "round"}:
                    continue
                if any(fg.dot(normal, d) > 0.5 for _, normal in _spread(face, 1)):
                    continue   # a rim: the face the recess opens through
                found.add(n)
        return sorted(found)

    def behind(self, component: Sequence[int], floor: int, d: Vector) -> bool:
        """Whether a wall reaches behind its floor along ``d``: then the floor is a wall of something else."""
        level = self.level(floor, d)
        return any(fg.dot(p, d) < level - EPS for i in component for p in self.faces[i].boundary_points())

    def recess(self, floor: int, component: list[int], d: Vector) -> dict[str, Any] | None:
        if self.behind(component, floor, d):
            return None
        faces = [self.faces[i] for i in component]
        depth = self.rise(component, floor, d)
        if depth <= EPS:
            return None
        rims = [i for i in self.caps(component, d, "convex")
                if abs(self.level(i, d) - self.level(floor, d) - depth) < EPS]
        planar = bool(rims)
        if not rims and floor in self.facts.exposed:
            # a curved or inclined entry surface: the walls end on faces facing along d, and the floor looks out
            rims = sorted({n for i in component for n in self.neighbours(i) if n not in component
                           and self.kind(i, n) == "convex" and not self.side(self.faces[n], d)
                           and any(fg.dot(normal, d) > 0.5 for _, normal in _spread(self.faces[n], 1))})
        if not rims:
            return None   # the walls open onto no face along d: another face floors them
        open_to = self.open_sides(floor, component, d)
        if all(i in self.facts.exposed for i in component) or \
                (not open_to and any(i in self.facts.exposed for i in component)):
            return None   # a recess's walls face each other; walls seen from outside are the outline
        freeform = any(f.support_type not in PRISMATIC for f in faces)
        if planar and depth <= ENGRAVING_MAX_DEPTH_MM and not open_to:
            return {"walls": component, "floor": floor, "rim": rims[0], "depth": depth, "d": d, "freeform": freeform}
        self.add_recess(floor, component, rims if planar else [], open_to, depth, d)
        return None

    def add_recess(self, floor: int, component: Sequence[int], rims: Sequence[int], open_to: Sequence[int],
                   depth: float, d: Vector) -> None:
        sizes = self.sizes_across(component, facing=True, d=d, at=rims)
        pairs = self.pairs(component, facing=True)
        cylinders = [self.faces[i] for i in component if self.faces[i].support_type == "cylinder"]
        slot = len(pairs) == 1 and 1 <= len(cylinders) <= 2 and all(abs(2 * f.radius - pairs[0][2]) < EPS
                                                                     for f in cylinders)
        ends = cylinders if slot else []
        if slot:
            sizes.append(Size("radius", ends[0].radius, tuple(f.index for f in ends)))
            axes = cylinder_instances(ends)
            if len(axes) == 2:
                sizes.append(Size("length", pairs[0][2] + fg.norm(fg.sub(axes[0].axis_point, axes[1].axis_point)),
                                  tuple(f.index for f in ends)))
        # a planar entry face gives the depth; a curved or inclined one leaves the floor to be located
        sizes.append(Size("depth", depth, (floor,), (tuple(rims), (floor,)) if rims else None, d))
        category = "slot" if slot else "notch" if open_to else "pocket"
        faces = tuple(sorted({floor, *component}))
        same = next((x for x in self.found if x.category in ("slot", "notch", "pocket") and x.faces == faces), None)
        if same is not None:   # one recess open along two directions, such as a corner notch: one feature
            extra = [Size("length", s.value, s.faces, s.between, s.direction) for s in sizes if s.name == "depth"]
            merged = Recognized(same.id, same.category, same.faces, (*same.sizes, *extra), same.locator_kind,
                                same.prismatic, same.direction, same.details)
            self.found[self.found.index(same)] = merged
            for index in faces:
                self.claimed[index] = [merged if x is same else x for x in self.claimed[index]]
            return
        self.add(category, faces, sizes, "slot" if slot else "plane_face", d, floor=floor,
                 rims=list(rims), open_to=list(open_to))

    def engravings(self, shallow: list[dict[str, Any]]) -> set[int]:
        """Shallow recesses of one depth in one face: text when any has a freeform wall, else plain pockets."""
        groups: dict[tuple[int, float], list[dict[str, Any]]] = {}
        for item in shallow:
            groups.setdefault((item["rim"], round(item["depth"], 3)), []).append(item)
        floors: set[int] = set()
        for (rim, depth), items in sorted(groups.items()):
            if not any(item["freeform"] for item in items):
                for item in items:
                    self.add_recess(item["floor"], item["walls"], [rim], [], depth, item["d"])
                continue
            own = sorted({item["floor"] for item in items})
            faces = [*own, *(i for item in items for i in item["walls"])]
            self.add("engraving", faces, [Size("depth", depth, tuple(own), ((rim,), tuple(own)), items[0]["d"])],
                     "engraving", items[0]["d"], on=rim, recesses=len(items))
            floors.update(own)
        return floors

    def protrusion(self, base: int, component: list[int], d: Vector, engraved: set[int]) -> None:
        if base in engraved:   # the island of a letter belongs to its engraving
            item = next(x for x in self.found if x.category == "engraving" and base in x.faces)
            self.claim(item, component)
            return
        if self.behind(component, base, d):
            return
        tops = self.caps(component, d, "convex")
        top = max(tops, key=lambda i: self.faces[i].area_mm2) if tops else None
        tops = [i for i in tops if top is not None and abs(self.level(i, d) - self.level(top, d)) < EPS]
        sizes = self.sizes_across(component, facing=False, d=d, at=tops)
        height = self.level(top, d) - self.level(base, d) if top is not None else self.rise(component, base, d)
        sizes.append(Size("height", height, tuple(component), ((base,), (top,)) if top is not None else None, d))
        widths = sorted((s for s in sizes if s.name == "width"), key=lambda s: s.value)
        rib = False
        if widths:
            across = fg.cross(d, fg.unit(widths[0].direction))
            lo, hi = _extent([p for i in component for p in self.faces[i].boundary_points()], across)
            rib = widths[0].value <= THIN_RATIO * (hi - lo)
        widths = [s.value for s in widths]
        if rib:
            sizes = [replace(s, name="thickness") if s.name == "width" and abs(s.value - widths[0]) < EPS else s
                     for s in sizes]
        self.add("rib" if rib else "boss", [*component, *tops], sizes, "plane_face", d, base=base, top=tops)

    def claim(self, item: Recognized, faces: Iterable[int]) -> None:
        faces = list(faces)
        merged = Recognized(item.id, item.category, tuple(sorted({*item.faces, *faces})), item.sizes, item.locator_kind,
                            item.prismatic and all(self.faces[i].support_type in PRISMATIC for i in faces),
                            item.direction, item.details)
        self.found[self.found.index(item)] = merged
        for index in merged.faces:
            items = [x for x in self.claimed.get(index, []) if x is not item]
            self.claimed[index] = [*items, merged]

    def step(self, low: int, riser: int, d: Vector) -> None:
        if self.behind([riser], low, d):
            return
        rise = self.rise([riser], low, d)
        tops = [i for i in self.caps([riser], d, "convex") if abs(self.level(i, d) - self.level(low, d) - rise) < EPS]
        if not tops:
            return
        high = tops[0]
        self.add("step", [riser, low, high],
                 [Size("height", abs(self.level(high, d) - self.level(low, d)), (riser,), ((low,), (high,)), d)],
                 "plane_face", d)

    def cutouts(self, fixed: set[int]) -> None:
        """Walls through the material: inward-facing rings of faces convex to a rim at each end."""
        for rim in sorted(self.faces.values(), key=lambda f: f.index):
            if rim.support_type != "plane":
                continue
            d = fg.unit(rim.normal)
            walls = {n for n in self.neighbours(rim.index)
                     if n not in fixed and self.kind(rim.index, n) == "convex" and not self.categories(n) - {"round"}
                     and self.side(self.faces[n], d)}
            for component in self.components(walls):
                if len(component) < 2 or all("round" in self.categories(i) for i in component) \
                        or self.facing(component) <= 0 or any(i in self.facts.exposed for i in component):
                    continue
                far = self.caps(component, fg.scale(d, -1.0), "convex")
                if not far:
                    continue
                # the material it passes through is a wall, sized by the wall's own thickness
                thickness = abs(self.level(far[0], d) - self.level(rim.index, d))
                sizes = self.sizes_across(component, facing=True, d=d, at=[rim.index])
                self.add("cutout", component, sizes, "plane_face", d, rims=[rim.index, far[0]], through_mm=thickness)

    # walls -----------------------------------------------------------------------------------------
    def walls(self) -> None:
        """Material spans thin against the smaller face: within its typical width 2A/P and a fifth of its length."""
        regions: dict[int, PlaneRegion] = {}
        stated = {frozenset((a, b)) for item in self.found for s in item.sizes if s.between
                  for a in s.between[0] for b in s.between[1]}
        for a, b, t in self.facts.spans:
            if frozenset((a, b)) in stated or {"engraving"} & (self.categories(a) | self.categories(b)):
                continue
            for i in (a, b):
                regions.setdefault(i, PlaneRegion(self.faces[i]))
            smaller = min((a, b), key=lambda i: self.faces[i].area_mm2)
            face = self.faces[smaller]
            perimeter = sum(fg.norm(fg.sub(q, p)) for e in face.edges for p, q in zip(e.points, e.points[1:]))
            if perimeter <= 0 or t > min(2 * face.area_mm2 / perimeter, WALL_RATIO * regions[smaller].longest()):
                continue
            if fg.parallel(self.faces[a].normal, self.faces[b].normal):
                self.add("wall", [a, b], [Size("thickness", t, (a, b), ((a,), (b,)), self.faces[a].normal)],
                         "plane_face", self.faces[a].normal)
            else:
                self.drafted(a, b)

    def drafted(self, a: int, b: int) -> None:
        """A wall whose faces are drafted against each other: its thickness at the plane both faces end on (its
        rim or parting plane, the thinnest such end), and each drafted face's angle from that plane's normal.
        A drafted wall that ends on no common plane has no stated thickness and stays unclaimed."""
        ends = sorted(set(self.ends_of(a)) & set(self.ends_of(b)))
        found = [(trace, ref) for ref in ends
                 if (trace := fg.trace_at(self.faces[a], self.faces[b], self.faces[ref])) is not None]
        if not found:
            return
        trace, ref = min(found, key=lambda item: (round(item[0].width, 6), item[1]))
        d = fg.unit(self.faces[ref].normal)
        sizes = [Size("thickness", trace.width, (a, b), ((a,), (b,)), trace.across, at=(ref,))]
        for i in (a, b):
            normal = fg.unit(self.faces[i].normal)
            if not fg.perpendicular(normal, d):
                sizes.append(Size("angle", 90.0 - math.degrees(math.acos(min(1.0, abs(fg.dot(normal, d))))), (i,)))
        self.add("wall", [a, b], sizes, "plane_face", trace.across, drafted=True, at=ref)

    def ends_of(self, index: int) -> list[int]:
        """The planes a face ends on: across a convex edge, directly or across a chamfer or round on that edge."""
        blended = {"chamfer", "round"}
        direct = {n for n in self.neighbours(index) if self.kind(index, n) == "convex"
                  and self.faces[n].support_type == "plane" and not self.categories(n) & blended}
        blends = {n for n in self.neighbours(index) if self.categories(n) & blended
                  and self.kind(index, n) in ("convex", "smooth")}
        beyond = {m for n in blends for m in self.neighbours(n) if m != index and self.faces[m].support_type == "plane"
                  and self.kind(n, m) in ("convex", "smooth") and not self.categories(m) & blended}
        return sorted(direct | beyond)

    # outline and leftovers -------------------------------------------------------------------------
    def outline(self) -> list[dict[str, Any]]:
        outer, unrecognized = [], []
        for face in sorted(self.faces.values(), key=lambda f: f.index):
            if face.index in self.claimed:
                continue
            if face.index in self.facts.exposed:
                outer.append(face.index)
            else:
                unrecognized.append({"face": face.index, "support_type": face.support_type,
                                     "area_mm2": round(face.area_mm2, 3),
                                     "reason": "no hole, recess, protrusion, wall, blend or outline pattern matches it, "
                                               "and it is not seen from outside the part"})
        if outer:
            self.add("outline", outer, [], "plane_face")
        return unrecognized

    def run(self) -> Recognition:
        self.cylinders()
        self.blends()
        self.group_blends()
        self.seeded()
        self.walls()
        unrecognized = self.outline()
        return Recognition(tuple(self.found), tuple(unrecognized))


def classify(faces: Sequence[Face], known: Facts) -> Recognition:
    return _Classifier(faces, known).run()


def recognize(faces: Sequence[Face], probe: Probe) -> Recognition:
    return classify(faces, facts(faces, probe))
