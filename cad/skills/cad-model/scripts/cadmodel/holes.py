"""Cylindrical bores of a part, measured on its read-back STEP solid so every kernel lists the same holes.

A bore is a set of concave cylindrical faces of one solid on one axis line and one radius: faces the
kernel split along the seam and coaxial stretches interrupted by a slot (a clevis pin bore) are one
bore. A stretch of faces that covers less than the full circle (a slot end, a concave fillet, a
channel open on one side) is not a hole, nor is a convex cylinder (a boss or a pin).

Each end of a bore is closed when a floor caps all of it: probes just past the end and just outside
the radius, taken along the end's rim edges, all lie in material. Flat floors, drill points, ball
ends, and corner radii cap; an end that opens anywhere (onto a face, a chamfer, a counterbore, a
cross bore) is open. A bore open at both ends is through. Orchestrator-only: called on shapes read
back by cad-motion's pose.py (OCP 8.0).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from cadmodel import occ

RADIUS_TOL_MM = 1e-4   # same-radius faces
AXIS_TOL_MM = 1e-4     # coaxial: distance between the two axis lines
PARALLEL_TOL = 1e-7    # coaxial: |sin| of the angle between the two axis directions
FULL_TURN = 2.0 * math.pi - 1e-6
RIM_SAMPLES = 8        # probes per rim edge

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


@dataclass(frozen=True)
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


@dataclass(frozen=True)
class _Span:
    """A wall's axial extent as parameters along the bore's reference axis."""

    low: float
    high: float
    wall: _Wall


def _span(wall: _Wall, origin: Vec, direction: Vec) -> _Span:
    t0, t1 = sorted(_axial(_along(wall.origin, wall.direction, v), origin, direction) for v in wall.v_range)
    return _Span(t0, t1, wall)


def _rim(stretch: list[_Span], origin: Vec, direction: Vec, low_end: bool) -> list[Vec]:
    """Points along the rim edges of one end of a stretch: the outer-wire edges of its faces on that
    side of the stretch's middle, without axial lines (seams, splits). Window edges are skipped."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepTools import BRepTools
    from OCP.GeomAbs import GeomAbs_Line

    middle = (min(s.low for s in stretch) + max(s.high for s in stretch)) / 2.0
    points = []
    for span in stretch:
        for item in occ.subshapes(BRepTools.OuterWire_s(span.wall.face), "EDGE"):
            edge = occ.downcast(item, "EDGE")
            if BRep_Tool.Degenerated_s(edge):
                continue
            curve = BRepAdaptor_Curve(edge)
            if curve.GetType() == GeomAbs_Line:
                line = _xyz(curve.Line().Direction())
                if math.sqrt(sum(c * c for c in _cross(line, direction))) <= PARALLEL_TOL:
                    continue
            first, last = curve.FirstParameter(), curve.LastParameter()
            sampled = [_xyz(curve.Value(first + (last - first) * (i + 0.5) / RIM_SAMPLES)) for i in range(RIM_SAMPLES)]
            if (sum(_axial(p, origin, direction) for p in sampled) / RIM_SAMPLES < middle) == low_end:
                points.extend(sampled)
    return points


def _opens(classifier: Any, rim: list[Vec], wall: _Wall, out: Vec) -> bool:
    """Whether the end with these rim points opens: some probe just past the rim (2 steps along
    `out`) and just outside the radius (1 step) is not in material."""
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN

    step = min(0.01, 0.05 * wall.radius)
    for point in rim:
        radial = _sub(point, _along(wall.origin, wall.direction, _axial(point, wall.origin, wall.direction)))
        scale = step / max(math.sqrt(_dot(radial, radial)), 1e-12)
        probe = tuple(point[i] + 2.0 * step * out[i] + scale * radial[i] for i in range(3))
        classifier.Perform(gp_Pnt(*probe), 1e-7)
        if classifier.State() != TopAbs_IN:
            return True
    return not rim


def _canonical(direction: Vec) -> Vec:
    """`direction` or its reverse, whichever points down: first non-zero of z, y, x negative."""
    for c in (direction[2], direction[1], direction[0]):
        if abs(c) > PARALLEL_TOL:
            return direction if c < 0 else (-direction[0], -direction[1], -direction[2])
    return direction


def _bore(classifier: Any, walls: list[_Wall]) -> dict[str, Any] | None:
    """The hole the coaxial walls make, or None when no stretch of them closes the full circle."""
    ref = walls[0]
    forward = ref.direction
    back = (-forward[0], -forward[1], -forward[2])
    stretches: list[list[_Span]] = []
    for span in sorted((_span(w, ref.origin, forward) for w in walls), key=lambda s: s.low):
        if stretches and span.low <= max(s.high for s in stretches[-1]) + AXIS_TOL_MM:
            stretches[-1].append(span)
        else:
            stretches.append([span])
    full = [stretch for stretch in stretches if sum(s.wall.u_span for s in stretch) >= FULL_TURN]
    if not full:
        return None
    low, high = min(s.low for s in full[0]), max(s.high for s in full[-1])
    open_low = _opens(classifier, _rim(full[0], ref.origin, forward, True), ref, back)
    open_high = _opens(classifier, _rim(full[-1], ref.origin, forward, False), ref, forward)
    # Enter at the one open end; a through (or closed) bore enters from the end its canonical axis leaves.
    enters_low = open_low if open_low != open_high else _canonical(forward) == forward
    axis, entry = (forward, low) if enters_low else (back, high)
    return {
        "diameter_mm": round(2.0 * ref.radius, 3),
        "axis": [round(c, 9) + 0.0 for c in axis],
        "position": [round(c, 6) + 0.0 for c in _along(ref.origin, forward, entry)],
        "depth_mm": round(high - low, 6),
        "through": open_low and open_high,
    }


def holes(shape: Any) -> list[dict[str, Any]]:
    """Every bore of every solid in `shape`, sorted by (diameter_mm, position) and numbered H1, H2, ..."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier

    found = []
    for solid in occ.subshapes(shape, "SOLID"):
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
        if groups:
            classifier = BRepClass3d_SolidClassifier(solid)
            found.extend(bore for bore in (_bore(classifier, g) for g in groups) if bore is not None)
    found.sort(key=lambda h: (h["diameter_mm"], [round(c, 3) for c in h["position"]]))
    return [{"id": f"H{i}", **hole} for i, hole in enumerate(found, start=1)]
