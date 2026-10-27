"""Section view fills: each cut face lined at 45° or, when thin, filled solid; and the ``section_hatch`` gate.

``techdraw_job.py`` reports every face the cutting plane leaves on the part as a ``CutRegion``: the
face's model area and its own closed loops. ``fill_section`` fills each face on its own, as its outer
loop minus its own inner loops, so no other face's loop can cancel or extend it:

- general section lining (ISO 128-50, now ISO 128-3; ASME Y14.3): thin lines at 45° on one
  sheet-wide grid ``spacing`` apart, so all cut faces of a part carry the same pattern;
- a thin section is filled solid: across a face whose projected minimum wall is narrower than
  ``THIN_FACTOR`` spacings, lining leaves one or two short ticks that read as an uncut face. Both
  regimes allow thin sections shown solid, so both use this rule.

``findings`` is the ``section_hatch`` gate. Per cut face, the sheet area its fill shows as section
must equal the face's projected area (its model area at the view scale) within ``AREA_TOLERANCE``: a
solid fill shows its loops; lining shows its loops in the proportion of the grid lines' interior
length it draws, net of lining outside them, and nothing across a face too thin for lining to read.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from drawing_intent import finding

Point = tuple[float, float]
Loop = tuple[Point, ...]
Segment = tuple[float, float, float, float]

AREA_TOLERANCE = 0.01   # shown section area against the projected face area
THIN_FACTOR = 2.0       # a face whose minimum wall is under this many lining spacings is filled solid
FACING_SINE = 0.5       # walls within 30° of parallel face each other across the material
LINE_WIDTH = 0.18       # lining is a thin line
_C = math.sqrt(0.5)


def spacing_for(text_size: float) -> float:
    """Lining pitch on the sheet: 2.5 mm beside 2.5 mm lettering (A4, ANSI A), 3 mm on larger sheets."""
    return 2.5 if text_size < 3 else 3.0


@dataclass(frozen=True)
class CutRegion:
    """One face of a section's cut in model millimetres: its area and its closed loops, the outer loop first."""

    area_mm2: float
    loops: tuple[tuple[tuple[float, float, float], ...], ...]

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> CutRegion:
        return cls(float(data["area_mm2"]),
                   tuple(tuple((float(p[0]), float(p[1]), float(p[2])) for p in loop) for loop in data["loops"]))


@dataclass(frozen=True)
class FaceFill:
    """The fill of one cut face on the sheet: ``solid`` over its own loops, or ``hatch`` lining inside them."""

    face: int
    mode: str                   # "hatch" or "solid"
    loops: tuple[Loop, ...]     # sheet mm
    lines: tuple[Segment, ...] = ()


@dataclass(frozen=True)
class SectionFill:
    """A section view's cut faces and the fill drawn for each; ``findings`` checks the one against the other."""

    view: str
    scale: float
    spacing: float
    regions: tuple[CutRegion, ...]
    fills: tuple[FaceFill, ...]


# --- polygon geometry -----------------------------------------------------------------------------

def _edges(loop: Sequence[Point]) -> Iterator[tuple[Point, Point]]:
    return zip(loop, (*loop[1:], loop[0]))


def signed_area(loop: Sequence[Point]) -> float:
    return sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in _edges(loop)) / 2


def _inside(point: Point, loop: Sequence[Point]) -> bool:
    x, y = point
    hit = False
    for (x1, y1), (x2, y2) in _edges(loop):
        if ((y1 <= y < y2) or (y2 <= y < y1)) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def _depths(loops: Sequence[Sequence[Point]]) -> list[int]:
    """How many of the other loops enclose each loop: even for an outer boundary, odd for a hole."""
    return [sum(_inside(loop[0], other) for j, other in enumerate(loops) if j != i) for i, loop in enumerate(loops)]


def region_area(loops: Sequence[Sequence[Point]]) -> float:
    """Even-odd area of one face's loops: its outer loops less its holes."""
    return sum(abs(signed_area(loop)) * (1 if depth % 2 == 0 else -1) for loop, depth in zip(loops, _depths(loops)))


def _open(loop: Sequence[Point]) -> Loop:
    """A closed loop without the repeated closing point a discretised wire ends on."""
    points = tuple(loop)
    return points[:-1] if len(points) > 1 and math.dist(points[0], points[-1]) < 1e-9 else points


def min_wall(loops: Sequence[Sequence[Point]], step: float) -> float:
    """Narrowest distance across one face's material between walls that face each other.

    From points at most ``step`` apart along every edge a ray runs into the material, along the edge
    normal, to the first boundary it meets; it measures a wall when that edge is within 30° of
    parallel to its own, so a corner or a blunt tip is no wall. A compact face without facing walls,
    such as a triangle, keeps its inscribed width 4·area/perimeter, the incircle diameter of any
    polygon that has one.
    """
    edges = [(a, b) for loop in loops for a, b in _edges(loop) if math.dist(a, b) > 1e-9]
    perimeter = sum(math.dist(a, b) for a, b in edges)
    if perimeter == 0:
        return 0.0
    best = 4 * region_area(loops) / perimeter
    for loop, depth in zip(loops, _depths(loops)):
        material_left = (signed_area(loop) > 0) == (depth % 2 == 0)
        for a, b in _edges(loop):
            length = math.dist(a, b)
            if length <= 1e-9:
                continue
            tx, ty = (b[0] - a[0]) / length, (b[1] - a[1]) / length
            nx, ny = (-ty, tx) if material_left else (ty, -tx)
            count = max(1, math.ceil(length / step))
            for i in range(count):
                f = (i + 0.5) / count
                hit = _first_hit((a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])), (nx, ny), edges)
                if hit is not None and abs(tx * hit[2] - ty * hit[1]) <= FACING_SINE:
                    best = min(best, hit[0])
    return best


def _first_hit(origin: Point, direction: Point, edges: Sequence[tuple[Point, Point]]) -> tuple[float, float, float] | None:
    """(distance, unit edge direction) of the first edge a ray from ``origin`` meets."""
    ox, oy = origin
    nx, ny = direction
    found = None
    for (px, py), (qx, qy) in edges:
        ex, ey = qx - px, qy - py
        denominator = nx * ey - ny * ex
        if abs(denominator) < 1e-12:
            continue
        wx, wy = px - ox, py - oy
        t = (wx * ey - wy * ex) / denominator
        s = (wx * ny - wy * nx) / denominator
        if t > 1e-7 and -1e-9 <= s <= 1 + 1e-9 and (found is None or t < found[0]):
            length = math.hypot(ex, ey)
            found = (t, ex / length, ey / length)
    return found


# --- lining ---------------------------------------------------------------------------------------

def _rotate(p: Point) -> Point:
    """(u along the lining, v across it): the lining runs at 45°, down to the right on the sheet."""
    return (_C * (p[0] + p[1]), _C * (p[1] - p[0]))


def _back(u: float, v: float) -> Point:
    return (_C * (u - v), _C * (u + v))


def _grid(rotated: Sequence[Sequence[Point]], spacing: float) -> Iterator[float]:
    """The sheet-wide lining lines across the loops: v = (k + 1/2)·spacing."""
    v_min = min(p[1] for loop in rotated for p in loop)
    v_max = max(p[1] for loop in rotated for p in loop)
    for k in range(math.ceil(v_min / spacing - 0.5), math.floor(v_max / spacing - 0.5) + 1):
        yield (k + 0.5) * spacing


def _intervals(rotated: Sequence[Sequence[Point]], v: float) -> list[tuple[float, float]]:
    """The even-odd interior of the loops along the line v, as (u start, u end) pairs."""
    crossings = sorted(u1 + (v - v1) * (u2 - u1) / (v2 - v1)
                       for loop in rotated for (u1, v1), (u2, v2) in _edges(loop) if (v1 <= v < v2) or (v2 <= v < v1))
    return list(zip(crossings[0::2], crossings[1::2]))


def hatch_lines(loops: Sequence[Sequence[Point]], spacing: float) -> list[Segment]:
    """45° lining inside one face: the even-odd interior of its own loops along the sheet-wide grid."""
    rotated = [[_rotate(p) for p in loop] for loop in loops if len(loop) > 2]
    if not rotated:
        return []
    lines = []
    for v in _grid(rotated, spacing):
        for a, b in _intervals(rotated, v):
            (x1, y1), (x2, y2) = _back(a, v), _back(b, v)
            lines.append((x1, y1, x2, y2))
    return lines


def fill_section(view: str, regions: Sequence[CutRegion], project: Callable[[Sequence[float]], Point],
                 scale: float, spacing: float) -> SectionFill:
    """Fill each cut face of a section view on its own: lining, or solid when it is thin."""
    fills = []
    for index, region in enumerate(regions):
        loops = tuple(loop for loop in (_open([project(p) for p in model]) for model in region.loops) if len(loop) > 2)
        if min_wall(loops, spacing / 2) < THIN_FACTOR * spacing:
            fills.append(FaceFill(index, "solid", loops))
        else:
            fills.append(FaceFill(index, "hatch", loops, tuple(hatch_lines(loops, spacing))))
    return SectionFill(view, scale, spacing, tuple(regions), tuple(fills))


def markup(fill: FaceFill) -> str:
    """SVG of one face's fill: a black even-odd path over its loops, or its lining lines."""
    if fill.mode == "solid":
        path = " ".join("M " + " L ".join(f"{x:.3f} {y:.3f}" for x, y in loop) + " Z" for loop in fill.loops)
        return f'<path d="{path}" fill="#000" fill-rule="evenodd" stroke="none"/>'
    return "".join(f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" stroke="#000" '
                   f'stroke-width="{LINE_WIDTH:g}"/>' for x1, y1, x2, y2 in fill.lines)


# --- the gate -------------------------------------------------------------------------------------

def shown_area(fill: FaceFill, spacing: float) -> float:
    """Sheet area a fill shows as section (see the module docstring)."""
    area = region_area(fill.loops)
    if fill.mode == "solid":
        return area
    if min_wall(fill.loops, spacing / 2) < THIN_FACTOR * spacing:
        return 0.0
    rotated = [[_rotate(p) for p in loop] for loop in fill.loops]
    interior = sum(b - a for v in _grid(rotated, spacing) for a, b in _intervals(rotated, v)) if rotated else 0.0
    if interior <= 0:
        return 0.0
    drawn = 0.0
    for x1, y1, x2, y2 in fill.lines:
        (u1, v1), (u2, v2) = _rotate((x1, y1)), _rotate((x2, y2))
        length = math.hypot(x2 - x1, y2 - y1)
        if abs(v1 - v2) > 1e-6:      # not lining at 45°
            drawn -= length
            continue
        lo, hi = min(u1, u2), max(u1, u2)
        inside = sum(max(0.0, min(hi, b) - max(lo, a)) for a, b in _intervals(rotated, (v1 + v2) / 2))
        drawn += inside - (length - inside)
    return area * max(0.0, drawn) / interior


def findings(section: SectionFill) -> list[dict[str, Any]]:
    """``section_hatch`` findings of one section view: a cut face whose fill does not show its projected area."""
    if not section.regions:
        return [finding("section_hatch", f"section {section.view} cuts no material", view=section.view)]
    fills = {fill.face: fill for fill in section.fills}
    found = []
    for index, region in enumerate(section.regions):
        expected = region.area_mm2 * section.scale ** 2
        fill = fills.get(index)
        shown = 0.0 if fill is None else shown_area(fill, section.spacing)
        if abs(shown - expected) <= AREA_TOLERANCE * expected:
            continue
        message = (f"section {section.view} cut face {index}: its {fill.mode if fill else 'missing'} fill shows "
                   f"{shown:.2f} of {expected:.2f} mm² on the sheet")
        if fill is not None and fill.mode == "hatch":
            wall = min_wall(fill.loops, section.spacing / 2)
            if wall < THIN_FACTOR * section.spacing:
                message += (f"; lining {section.spacing:g} mm apart does not read across a {wall:.2f} mm wall, "
                            f"fill it solid")
        found.append(finding("section_hatch", message, view=section.view, face=index))
    return found
