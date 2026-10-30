"""Cylindrical bores of a part, measured on its read-back STEP solid so every kernel lists the same holes.

A bore is made of concave cylindrical faces of one solid on one axis line and one radius. Along the
axis it is cut into slices at every face boundary, and a slice belongs to the bore only when the
faces spanning it close the full circle. Two half-turn faces side by side (a seam the kernel split)
close it; faces that only follow each other along the axis (a half-round channel cut in two
pieces) do not. A run of faces that covers less than the full circle (a slot end, a concave
fillet, a channel open on one side) is not a hole, nor is a convex cylinder (a boss or a pin).

An end of a run is open when a face across its rim reaches outside the bore radius: a boundary
face, a lead-in chamfer or round of any angle, a slot, a cross bore, or a larger coaxial step. It
is closed when every face across its rim stays within the radius: a flat floor, a drill point, a
ball end, a corner radius, or the shoulder where a counterbore steps down to a smaller bore.
Neighbouring runs on one axis are one bore only when both facing ends are open, as in a clevis pin
bore across its slot. Two blind holes drilled from opposite faces stay two bores. A bore open at
both ends is through. Each coaxial step of a counterbore or stepped bore is its own bore, the
larger one blind down to the shoulder where the smaller one starts.

Called on shapes read back by cad-motion's pose.py (OCP 8.0): by the orchestrator for metrics, and
by cad-design's form_check, which uses `bore_walls` to keep bores out of its corner-radius rule.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from cadmodel import occ

RADIUS_TOL_MM = 1e-4   # same-radius faces; how far a face across a rim must reach outside to open it
AXIS_TOL_MM = 1e-4     # coaxial: distance between the two axis lines; slice boundaries closer than this merge
PARALLEL_TOL = 1e-7    # coaxial: |sin| of the angle between the two axis directions
FULL_TURN = 2.0 * math.pi - 1e-6
EDGE_SAMPLES = 8       # points per edge, both ends included

Vec = tuple[float, float, float]


def _sub(a: Vec, b: Vec) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a: Vec, b: Vec) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Vec, b: Vec) -> Vec:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _along(origin: Vec, direction: Vec, t: float) -> Vec:
    return (origin[0] + t * direction[0], origin[1] + t * direction[1], origin[2] + t * direction[2])


def _xyz(point: Any) -> Vec:
    return (point.X(), point.Y(), point.Z())


@dataclass(frozen=True, eq=False)
class _Wall:
    """One concave cylindrical face: its axis line, radius, angular span, and axial parameter range."""

    face: Any
    origin: Vec
    direction: Vec
    radius: float
    u_span: float
    v_range: tuple[float, float]


def _wall(face: Any) -> _Wall | None:
    """The face as a bore wall; None unless it is a concave cylinder."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepTools import BRepTools
    from OCP.GeomAbs import GeomAbs_Cylinder
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.TopAbs import TopAbs_REVERSED

    surface = BRepAdaptor_Surface(face, True)
    if surface.GetType() != GeomAbs_Cylinder:
        return None
    cylinder = surface.Cylinder()
    axis = cylinder.Axis()
    origin, direction = _xyz(axis.Location()), _xyz(axis.Direction())
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face)
    u_mid, v_mid = (u0 + u1) / 2.0, (v0 + v1) / 2.0
    point, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
    surface.D1(u_mid, v_mid, point, du, dv)
    normal = _xyz(du.Crossed(dv))
    if face.Orientation() == TopAbs_REVERSED:
        normal = (-normal[0], -normal[1], -normal[2])
    p = _xyz(point)
    outward = _sub(p, _along(origin, direction, _axial(p, origin, direction)))
    if _dot(normal, outward) >= 0.0:  # material inside the cylinder: a boss or pin
        return None
    return _Wall(face, origin, direction, cylinder.Radius(), u1 - u0, (v0, v1))


def _coaxial(a: _Wall, b: _Wall) -> bool:
    if abs(a.radius - b.radius) > RADIUS_TOL_MM:
        return False
    if math.sqrt(sum(c * c for c in _cross(a.direction, b.direction))) > PARALLEL_TOL:
        return False
    offset = _sub(b.origin, a.origin)
    return math.sqrt(sum(c * c for c in _cross(offset, a.direction))) <= AXIS_TOL_MM


def _axial(point: Vec, origin: Vec, direction: Vec) -> float:
    return _dot(_sub(point, origin), direction)


def _radial(point: Vec, wall: _Wall) -> float:
    return math.sqrt(sum(c * c for c in _cross(_sub(point, wall.origin), wall.direction)))


def _groups(solid: Any) -> list[list[_Wall]]:
    """The solid's concave cylindrical faces, grouped by axis line and radius."""
    groups: list[list[_Wall]] = []
    for face in occ.subshapes(solid, "FACE"):
        wall = _wall(occ.downcast(face, "FACE"))
        if wall is None:
            continue
        group = next((g for g in groups if _coaxial(g[0], wall)), None)
        if group is None:
            groups.append([wall])
        else:
            group.append(wall)
    return groups


@dataclass(frozen=True, eq=False)
class _Span:
    """A wall's axial extent as parameters along the bore's reference axis."""

    low: float
    high: float
    wall: _Wall


def _span(wall: _Wall, origin: Vec, direction: Vec) -> _Span:
    t0, t1 = sorted(_axial(_along(wall.origin, wall.direction, v), origin, direction) for v in wall.v_range)
    return _Span(t0, t1, wall)


@dataclass(eq=False)
class _Run:
    """An axial stretch on which the walls close the full circle, and the walls that overlap it."""

    low: float
    high: float
    spans: list[_Span]


def _runs(spans: list[_Span]) -> list[_Run]:
    """Maximal stretches of consecutive full-circle slices, in axial order."""
    cuts: list[float] = []
    for t in sorted(t for s in spans for t in (s.low, s.high)):
        if not cuts or t - cuts[-1] > AXIS_TOL_MM:
            cuts.append(t)
    runs: list[_Run] = []
    for low, high in zip(cuts, cuts[1:]):
        inside = [s for s in spans if s.low <= low + AXIS_TOL_MM and s.high >= high - AXIS_TOL_MM]
        if sum(s.wall.u_span for s in inside) < FULL_TURN:
            continue
        if runs and runs[-1].high == low:
            runs[-1].high = high
            runs[-1].spans.extend(s for s in inside if s not in runs[-1].spans)
        else:
            runs.append(_Run(low, high, inside))
    return runs


class _Adjacency:
    """The faces of one solid indexed by their edges, to find the face across an edge.

    OCP 8.0 hashes a shape by its TShape and Location, so both orientations of a shared edge land
    in one bucket; IsSame then picks the edge out of it.
    """

    def __init__(self, solid: Any) -> None:
        self._by_edge: dict[int, list[tuple[Any, Any]]] = {}
        for item in occ.subshapes(solid, "FACE"):
            face = occ.downcast(item, "FACE")
            for edge in occ.subshapes(face, "EDGE"):
                self._by_edge.setdefault(hash(edge), []).append((edge, face))

    def across(self, edge: Any, face: Any) -> list[Any]:
        """The other faces that share `edge` with `face`."""
        return [f for e, f in self._by_edge.get(hash(edge), []) if e.IsSame(edge) and not f.IsSame(face)]


def _samples(edge: Any) -> list[Vec]:
    """EDGE_SAMPLES + 1 points along the edge, both ends included."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve

    curve = BRepAdaptor_Curve(edge)
    first, last = curve.FirstParameter(), curve.LastParameter()
    return [_xyz(curve.Value(first + (last - first) * i / EDGE_SAMPLES)) for i in range(EDGE_SAMPLES + 1)]


def _edges(shape: Any) -> list[Any]:
    """The non-degenerate edges of a face or wire."""
    from OCP.BRep import BRep_Tool

    edges = (occ.downcast(item, "EDGE") for item in occ.subshapes(shape, "EDGE"))
    return [edge for edge in edges if not BRep_Tool.Degenerated_s(edge)]


def _is_axial_line(edge: Any, direction: Vec) -> bool:
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GeomAbs import GeomAbs_Line

    curve = BRepAdaptor_Curve(edge)
    if curve.GetType() != GeomAbs_Line:
        return False
    return math.sqrt(sum(c * c for c in _cross(_xyz(curve.Line().Direction()), direction))) <= PARALLEL_TOL


def _end_opens(run: _Run, low_end: bool, group: list[_Wall], adjacency: _Adjacency) -> bool:
    """Whether one end of a run is open: some face across its rim reaches outside the bore radius.

    The rim is the outer-wire edges of the walls that end there, on that side of each wall's middle,
    without axial lines (seams, splits) and without edges shared with another wall of the bore.
    An end with nothing across its rim is open.
    """
    from OCP.BRepTools import BRepTools

    ref = group[0]
    end = run.low if low_end else run.high
    across: list[Any] = []
    for span in run.spans:
        if abs((span.low if low_end else span.high) - end) > AXIS_TOL_MM:
            continue
        middle = (span.low + span.high) / 2.0
        for edge in _edges(BRepTools.OuterWire_s(span.wall.face)):
            if _is_axial_line(edge, ref.direction):
                continue
            points = _samples(edge)
            if (sum(_axial(p, ref.origin, ref.direction) for p in points) / len(points) < middle) != low_end:
                continue
            across.extend(face for face in adjacency.across(edge, span.wall.face)
                          if not any(face.IsSame(w.face) for w in group))
    if not across:
        return True
    reach = ref.radius + RADIUS_TOL_MM
    return any(_radial(p, ref) > reach for face in across for edge in _edges(face) for p in _samples(edge))


def _canonical(direction: Vec) -> Vec:
    """`direction` or its reverse, whichever points down: first non-zero of z, y, x negative."""
    for c in (direction[2], direction[1], direction[0]):
        if abs(c) > PARALLEL_TOL:
            return direction if c < 0 else (-direction[0], -direction[1], -direction[2])
    return direction


def _bores(group: list[_Wall], adjacency: _Adjacency) -> list[dict[str, Any]]:
    """The holes one group of coaxial walls makes: one per chain of runs joined across open ends."""
    ref = group[0]
    forward = ref.direction
    back = (-forward[0], -forward[1], -forward[2])
    runs = _runs([_span(w, ref.origin, forward) for w in group])
    ends = [(_end_opens(run, True, group, adjacency), _end_opens(run, False, group, adjacency)) for run in runs]
    chains: list[list[int]] = []
    for i in range(len(runs)):
        if chains and ends[i - 1][1] and ends[i][0]:
            chains[-1].append(i)
        else:
            chains.append([i])
    found = []
    for chain in chains:
        low, high = runs[chain[0]].low, runs[chain[-1]].high
        open_low, open_high = ends[chain[0]][0], ends[chain[-1]][1]
        # Enter at the one open end; a through (or closed) bore enters from the end its canonical axis leaves.
        enters_low = open_low if open_low != open_high else _canonical(forward) == forward
        axis, entry = (forward, low) if enters_low else (back, high)
        found.append({
            "diameter_mm": round(2.0 * ref.radius, 3),
            "axis": [round(c, 9) + 0.0 for c in axis],
            "position": [round(c, 6) + 0.0 for c in _along(ref.origin, forward, entry)],
            "depth_mm": round(high - low, 6),
            "through": open_low and open_high,
        })
    return found


def holes(shape: Any) -> list[dict[str, Any]]:
    """Every bore of every solid in `shape`, sorted by (diameter_mm, position) and numbered H1, H2, ..."""
    found = []
    for solid in occ.subshapes(shape, "SOLID"):
        groups = _groups(solid)
        if groups:
            adjacency = _Adjacency(solid)
            for group in groups:
                found.extend(_bores(group, adjacency))
    found.sort(key=lambda h: (h["diameter_mm"], [round(c, 3) for c in h["position"]]))
    return [{"id": f"H{i}", **hole} for i, hole in enumerate(found, start=1)]


def bore_walls(shape: Any) -> list[Any]:
    """The concave cylindrical faces `holes` measures: walls on a full-circle slice of some bore."""
    walls = []
    for solid in occ.subshapes(shape, "SOLID"):
        for group in _groups(solid):
            ref = group[0]
            spans = [_span(w, ref.origin, ref.direction) for w in group]
            runs = _runs(spans)
            walls.extend(s.wall.face for s in spans if any(s in run.spans for run in runs))
    return walls
