"""Section view fills: each cut face lined at 45° to its main outline or, when thin, filled solid; the ``section_hatch`` gate.

``techdraw_job.py`` reports every face the cutting plane leaves on the part as a ``CutRegion``: the
face's model area, its own closed loops and the part it belongs to. ``fill_section`` fills each face
on its own, as its outer loop minus its own inner loops, so no other face's loop can cancel or extend
it. The rule follows ISO 128-3:2022 (which absorbed ISO 128-50), hatch spacing in proportion to the
size of the hatched area and never under 0.7 mm, very thin sections blackened; ASME Y14.3 allows the
same:

- typical width ``w = 2·A / P`` on the sheet: the face's net area over its whole boundary, holes
  included (the wall of a tube, the thickness of a long strip);
- lining spacing ``s = clamp(w / 3, MIN_SPACING, MAX_SPACING)``, at 45° to the face's main outline,
  the direction that carries most of its straight boundary (the sheet axes when none does);
- solid fill when ``w < SOLID_WIDTH``, three times the minimum spacing: no narrower face can take
  three lines at 0.7 mm or more;
- faces of different parts that share a boundary take alternate directions, and a third part
  touching both also shifts its lines by half a spacing.

``findings`` is the ``section_hatch`` gate, per cut face:

- coverage: the sheet area its fill shows as section equals the face's projected area (its model
  area at the view scale) within ``AREA_TOLERANCE``. A solid fill shows its loops; lining shows its
  loops in the proportion of its own grid's interior length that it draws, net of lining outside them;
- lining density: a hatched face has spacing at least 0.7 mm and at least three lines across its
  typical width (``w / s >= 3``), so no face reads as a few loose ticks;
- solid only when thin: a face filled solid is narrower than ``SOLID_WIDTH``.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from drawing_intent import finding

Point = tuple[float, float]
Loop = tuple[Point, ...]
Segment = tuple[float, float, float, float]

AREA_TOLERANCE = 0.01             # shown section area against the projected face area
MIN_SPACING, MAX_SPACING = 0.7, 3.0   # sheet mm between lining lines (ISO 128-3 minimum; a 3 mm cap)
LINES_ACROSS = 3                  # lining lines across a hatched face's typical width
SOLID_WIDTH = LINES_ACROSS * MIN_SPACING   # sheet mm: a narrower face is filled solid
OUTLINE_SHARE = 0.25              # a direction with this share of the perimeter (±1°) is the main outline
SHARED_TOLERANCE = 0.05           # sheet mm: boundary points this close to another face lie on a shared boundary
SHARED_LENGTH = 0.5               # sheet mm of shared boundary that makes two faces adjacent
LINE_WIDTH = 0.18                 # lining is a thin line
ON_LINE = 0.005                   # sheet mm: a lining line's ends lie on its grid line (SVG writes 0.001 mm)


@dataclass(frozen=True)
class CutRegion:
    """One face of a section's cut in model millimetres: its area, its closed loops (outer first), its part."""

    area_mm2: float
    loops: tuple[tuple[tuple[float, float, float], ...], ...]
    part: str = ""

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> CutRegion:
        return cls(float(data["area_mm2"]),
                   tuple(tuple((float(p[0]), float(p[1]), float(p[2])) for p in loop) for loop in data["loops"]),
                   str(data.get("part", "")))


@dataclass(frozen=True)
class FaceFill:
    """The fill of one cut face on the sheet: ``solid`` over its own loops, or ``hatch`` lining inside them."""

    face: int
    mode: str                   # "hatch" or "solid"
    loops: tuple[Loop, ...]     # sheet mm
    width: float                # typical width 2·A/P, sheet mm
    spacing: float = 0.0        # lining: sheet mm between lines
    angle_deg: float = 45.0     # lining: direction on the sheet, degrees from +x with Y down
    phase: float = 0.0          # lining: grid shift across the lines from the face's middle, sheet mm
    lines: tuple[Segment, ...] = ()


@dataclass(frozen=True)
class SectionFill:
    """A section view's cut faces and the fill drawn for each; ``findings`` checks the one against the other."""

    view: str
    scale: float
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


def perimeter(loops: Sequence[Sequence[Point]]) -> float:
    return sum(math.dist(a, b) for loop in loops for a, b in _edges(loop))


def typical_width(loops: Sequence[Sequence[Point]]) -> float:
    """2·A/P: the wall of a ring, the thickness of a long strip, half the side of a square."""
    length = perimeter(loops)
    return 2 * region_area(loops) / length if length > 0 else 0.0


def spacing_for(width: float) -> float:
    """Lining spacing in proportion to the face: three lines across its typical width, 0.7 to 3 mm apart."""
    return min(MAX_SPACING, max(MIN_SPACING, width / LINES_ACROSS))


def outline_angle(loops: Sequence[Sequence[Point]]) -> float:
    """Direction of the face's main outline, degrees in [-45, 45) (its sides and their normals alike).

    Every edge votes its length for its direction; the 3° window with the most votes wins when it
    carries ``OUTLINE_SHARE`` of the perimeter, else the face has no main outline (a ring) and the
    sheet axes stand in.
    """
    votes = [(math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 90.0, math.dist(a, b))
             for loop in loops for a, b in _edges(loop) if math.dist(a, b) > 1e-9]
    total = sum(length for _, length in votes)
    if total == 0:
        return 0.0
    bins = [0.0] * 90
    for angle, length in votes:
        bins[round(angle) % 90] += length
    best = max(range(90), key=lambda k: (bins[k - 1] + bins[k] + bins[(k + 1) % 90], -k))
    offsets = [(((angle - best + 45) % 90) - 45, length) for angle, length in votes]
    near = [(offset, length) for offset, length in offsets if abs(offset) <= 1.5]
    weight = sum(length for _, length in near)
    if weight < OUTLINE_SHARE * total:
        return 0.0
    return ((best + sum(offset * length for offset, length in near) / weight + 45.0) % 90.0) - 45.0


def _open(loop: Sequence[Point]) -> Loop:
    """A closed loop without the repeated closing point a discretised wire ends on."""
    points = tuple(loop)
    return points[:-1] if len(points) > 1 and math.dist(points[0], points[-1]) < 1e-9 else points


def _segment_distance(point: Point, a: Point, b: Point) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2))
    return math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy)


def shared_length(a: Sequence[Sequence[Point]], b: Sequence[Sequence[Point]]) -> float:
    """Length of face ``a``'s boundary that runs on face ``b``'s boundary."""
    edges = [(p, q) for loop in b for p, q in _edges(loop)]

    def on_b(point: Point) -> bool:
        return any(_segment_distance(point, p, q) <= SHARED_TOLERANCE for p, q in edges)

    return sum(math.dist(p, q) for loop in a for p, q in _edges(loop)
               if on_b(p) and on_b(q) and on_b(((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)))


# --- lining ---------------------------------------------------------------------------------------

def _direction(angle_deg: float) -> Point:
    angle = math.radians(angle_deg)
    return (math.cos(angle), math.sin(angle))


def _to_lining(p: Point, d: Point) -> Point:
    """(u along the lining, v across it)."""
    return (p[0] * d[0] + p[1] * d[1], p[1] * d[0] - p[0] * d[1])


def _from_lining(u: float, v: float, d: Point) -> Point:
    return (u * d[0] - v * d[1], u * d[1] + v * d[0])


def _grid(rotated: Sequence[Sequence[Point]], spacing: float, phase: float) -> Iterator[float]:
    """The face's lining lines: ``spacing`` apart across it, one through its middle shifted by ``phase``."""
    v_min = min(p[1] for loop in rotated for p in loop)
    v_max = max(p[1] for loop in rotated for p in loop)
    middle = (v_min + v_max) / 2 + phase
    for k in range(math.ceil((v_min - middle) / spacing), math.floor((v_max - middle) / spacing) + 1):
        v = middle + k * spacing
        if v_min < v < v_max:
            yield v


def _intervals(rotated: Sequence[Sequence[Point]], v: float) -> list[tuple[float, float]]:
    """The even-odd interior of the loops along the line v, as (u start, u end) pairs."""
    crossings = sorted(u1 + (v - v1) * (u2 - u1) / (v2 - v1)
                       for loop in rotated for (u1, v1), (u2, v2) in _edges(loop) if (v1 <= v < v2) or (v2 <= v < v1))
    return list(zip(crossings[0::2], crossings[1::2]))


def hatch_lines(loops: Sequence[Sequence[Point]], spacing: float, angle_deg: float, phase: float = 0.0) -> list[Segment]:
    """Lining inside one face at ``angle_deg``: the even-odd interior of its own loops along its grid."""
    d = _direction(angle_deg)
    rotated = [[_to_lining(p, d) for p in loop] for loop in loops if len(loop) > 2]
    if not rotated:
        return []
    lines = []
    for v in _grid(rotated, spacing, phase):
        for a, b in _intervals(rotated, v):
            (x1, y1), (x2, y2) = _from_lining(a, v, d), _from_lining(b, v, d)
            lines.append((x1, y1, x2, y2))
    return lines


def _part_colours(regions: Sequence[CutRegion], loops: Sequence[Sequence[Loop]]) -> dict[str, int]:
    """A colour per part so that parts whose faces share a boundary differ: the smallest one free."""
    parts = list(dict.fromkeys(region.part for region in regions))
    touching: dict[str, set[str]] = {part: set() for part in parts}
    for i, j in itertools.combinations(range(len(regions)), 2):
        a, b = regions[i].part, regions[j].part
        if a != b and b not in touching[a] and shared_length(loops[i], loops[j]) >= SHARED_LENGTH:
            touching[a].add(b)
            touching[b].add(a)
    colours: dict[str, int] = {}
    for part in parts:
        used = {colours[other] for other in touching[part] if other in colours}
        colours[part] = next(c for c in itertools.count() if c not in used)
    return colours


def fill_section(view: str, regions: Sequence[CutRegion], project: Callable[[Sequence[float]], Point],
                 scale: float) -> SectionFill:
    """Fill each cut face of a section view on its own (see the module docstring)."""
    loops = [tuple(loop for loop in (_open([project(p) for p in model]) for model in region.loops) if len(loop) > 2)
             for region in regions]
    colours = _part_colours(regions, loops)
    fills = []
    for index, (region, own) in enumerate(zip(regions, loops)):
        width = typical_width(own)
        if width < SOLID_WIDTH:
            fills.append(FaceFill(index, "solid", own, width))
            continue
        colour = colours[region.part]
        spacing = spacing_for(width)
        angle = (outline_angle(own) + (45.0 if colour % 2 == 0 else -45.0)) % 180.0
        phase = spacing / 2 if (colour // 2) % 2 else 0.0
        fills.append(FaceFill(index, "hatch", own, width, spacing, angle, phase,
                              tuple(hatch_lines(own, spacing, angle, phase))))
    return SectionFill(view, scale, tuple(regions), tuple(fills))


def markup(fill: FaceFill) -> str:
    """SVG of one face's fill: a black even-odd path over its loops, or its lining lines."""
    if fill.mode == "solid":
        path = " ".join("M " + " L ".join(f"{x:.3f} {y:.3f}" for x, y in loop) + " Z" for loop in fill.loops)
        return f'<path d="{path}" fill="#000" fill-rule="evenodd" stroke="none"/>'
    return "".join(f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" stroke="#000" '
                   f'stroke-width="{LINE_WIDTH:g}"/>' for x1, y1, x2, y2 in fill.lines)


# --- the gate -------------------------------------------------------------------------------------

def shown_area(fill: FaceFill) -> float:
    """Sheet area a fill shows as section (see the module docstring)."""
    area = region_area(fill.loops)
    if fill.mode == "solid":
        return area
    if fill.spacing <= 0 or not fill.loops:
        return 0.0
    d = _direction(fill.angle_deg)
    rotated = [[_to_lining(p, d) for p in loop] for loop in fill.loops]
    interior = sum(b - a for v in _grid(rotated, fill.spacing, fill.phase) for a, b in _intervals(rotated, v))
    if interior <= 0:
        return 0.0
    drawn = 0.0
    for x1, y1, x2, y2 in fill.lines:
        (u1, v1), (u2, v2) = _to_lining((x1, y1), d), _to_lining((x2, y2), d)
        length = math.hypot(x2 - x1, y2 - y1)
        if abs(v1 - v2) > ON_LINE:      # not along this face's lining
            drawn -= length
            continue
        lo, hi = min(u1, u2), max(u1, u2)
        inside = sum(max(0.0, min(hi, b) - max(lo, a)) for a, b in _intervals(rotated, (v1 + v2) / 2))
        drawn += inside - (length - inside)
    return area * max(0.0, drawn) / interior


def findings(section: SectionFill) -> list[dict[str, Any]]:
    """``section_hatch`` findings of one section view (see the module docstring)."""
    if not section.regions:
        return [finding("section_hatch", f"section {section.view} cuts no material", view=section.view)]
    fills = {fill.face: fill for fill in section.fills}
    found = []
    for index, region in enumerate(section.regions):
        where = f"section {section.view} cut face {index}"
        expected = region.area_mm2 * section.scale ** 2
        fill = fills.get(index)
        shown = 0.0 if fill is None else shown_area(fill)
        if abs(shown - expected) > AREA_TOLERANCE * expected:
            found.append(finding("section_hatch", f"{where}: its {fill.mode if fill else 'missing'} fill shows "
                                 f"{shown:.2f} of {expected:.2f} mm² on the sheet", view=section.view, face=index))
        if fill is None:
            continue
        if fill.mode == "solid" and fill.width >= SOLID_WIDTH:
            found.append(finding("section_hatch", f"{where} is filled solid at a typical width of {fill.width:.2f} mm; "
                                 f"only faces under {SOLID_WIDTH:g} mm are blackened, line it", view=section.view, face=index))
        if fill.mode == "hatch" and fill.spacing < MIN_SPACING - 1e-9:
            found.append(finding("section_hatch", f"{where}: lining {fill.spacing:.2f} mm apart is under the "
                                 f"{MIN_SPACING:g} mm minimum", view=section.view, face=index))
        elif fill.mode == "hatch" and fill.width / fill.spacing < LINES_ACROSS - 1e-9:
            found.append(finding("section_hatch", f"{where}: lining {fill.spacing:.2f} mm apart gives "
                                 f"{fill.width / fill.spacing:.1f} lines across its {fill.width:.2f} mm typical width, "
                                 f"under {LINES_ACROSS}; space it closer or fill it solid", view=section.view, face=index))
    return found
