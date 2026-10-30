"""Section view fills: one lining (or a solid fill) per part in each section view, and the ``section_hatch`` gate.

``techdraw_job.py`` reports every face the cutting plane leaves on the part as a ``CutRegion``: the
face's model area, its own closed loops and the part it belongs to. ``fill_section`` fills each face
as its outer loop minus its own inner loops, so no other face's loop can cancel or extend it, and
gives every face of one part the same fill, as ISO 128-3:2022 (which absorbed ISO 128-50) requires
of a part's sections. Its spacing is in proportion to the size of the hatched area, never under
0.7 mm, and very thin sections are blackened; ASME Y14.3 allows the same. Per part, on the sheet:

- typical width ``w = 2·ΣA / ΣP`` over the part's cut faces: their net areas over their whole
  boundaries, holes included (the wall of a tube, the thickness of a long strip);
- lining spacing ``s = clamp(w / 3, MIN_SPACING, MAX_SPACING)``, at 45° to the part's main outline,
  the direction that carries most of its straight boundary (the sheet axes when none does), on one
  grid, so a line runs on unbroken from one face of the part into the next;
- solid fill of every face of the part when ``w < SOLID_WIDTH``, three times the minimum spacing:
  no narrower part can take three lines at 0.7 mm or more;
- parts whose faces share a boundary take alternate directions, and a third part touching both
  also shifts its grid by half a spacing.

A thin wall of a lined part carries few lines, as on any drawing; only the part as a whole decides.

``findings`` is the ``section_hatch`` gate:

- coverage, per cut face: the sheet area its fill shows as section equals the face's projected area
  (its model area at the view scale) within ``AREA_TOLERANCE``. A solid fill shows its loops; lining
  shows its loops in the proportion of its grid's interior length that it draws, net of lining
  outside them;
- per part: one fill for all its faces; a lined part has spacing at least 0.7 mm and at least three
  lines across its typical width (``w / s >= 3``); a part filled solid is narrower than ``SOLID_WIDTH``.
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
LINES_ACROSS = 3                  # lining lines across a lined part's typical width
SOLID_WIDTH = LINES_ACROSS * MIN_SPACING   # sheet mm: a narrower part is filled solid
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
class Lining:
    """One part's lining in a view: lines ``spacing`` apart at ``angle_deg`` (from +x, Y down) through ``offset``.

    ``offset`` is the across-the-lines coordinate of one line, measured from the sheet origin; the
    others lie at ``offset + k · spacing``.
    """

    spacing: float
    angle_deg: float
    offset: float = 0.0


@dataclass(frozen=True)
class FaceFill:
    """The fill of one cut face on the sheet: its part's ``lining`` inside its own loops, or solid (None)."""

    face: int
    loops: tuple[Loop, ...]     # sheet mm
    lining: Lining | None
    lines: tuple[Segment, ...] = ()

    @property
    def mode(self) -> str:
        return "solid" if self.lining is None else "hatch"


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


def typical_width(faces: Sequence[Sequence[Sequence[Point]]]) -> float:
    """2·ΣA/ΣP over faces (each a list of its own loops): the wall of a ring, the thickness of a long strip."""
    length = sum(perimeter(loops) for loops in faces)
    return 2 * sum(region_area(loops) for loops in faces) / length if length > 0 else 0.0


def spacing_for(width: float) -> float:
    """Lining spacing in proportion to the part: three lines across its typical width, 0.7 to 3 mm apart."""
    return min(MAX_SPACING, max(MIN_SPACING, width / LINES_ACROSS))


def outline_angle(loops: Sequence[Sequence[Point]]) -> float:
    """Direction of the main outline of some loops, degrees in [-45, 45) (sides and their normals alike).

    Every edge votes its length for its direction; the 3° window with the most votes wins when it
    carries ``OUTLINE_SHARE`` of the perimeter, else there is no main outline (a ring) and the sheet
    axes stand in.
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


def _grid(rotated: Sequence[Sequence[Point]], lining: Lining) -> Iterator[float]:
    """The lining's lines across some loops: v = offset + k · spacing strictly inside their extent."""
    v_min = min(p[1] for loop in rotated for p in loop)
    v_max = max(p[1] for loop in rotated for p in loop)
    first = math.ceil((v_min - lining.offset) / lining.spacing)
    for k in range(first, math.floor((v_max - lining.offset) / lining.spacing) + 1):
        v = lining.offset + k * lining.spacing
        if v_min < v < v_max:
            yield v


def _intervals(rotated: Sequence[Sequence[Point]], v: float) -> list[tuple[float, float]]:
    """The even-odd interior of the loops along the line v, as (u start, u end) pairs."""
    crossings = sorted(u1 + (v - v1) * (u2 - u1) / (v2 - v1)
                       for loop in rotated for (u1, v1), (u2, v2) in _edges(loop) if (v1 <= v < v2) or (v2 <= v < v1))
    return list(zip(crossings[0::2], crossings[1::2]))


def hatch_lines(loops: Sequence[Sequence[Point]], lining: Lining) -> list[Segment]:
    """``lining`` inside one face: the even-odd interior of its own loops along the lining's lines."""
    d = _direction(lining.angle_deg)
    rotated = [[_to_lining(p, d) for p in loop] for loop in loops if len(loop) > 2]
    if not rotated:
        return []
    lines = []
    for v in _grid(rotated, lining):
        for a, b in _intervals(rotated, v):
            (x1, y1), (x2, y2) = _from_lining(a, v, d), _from_lining(b, v, d)
            lines.append((x1, y1, x2, y2))
    return lines


def _parts(regions: Sequence[CutRegion]) -> dict[str, list[int]]:
    """The face indices of each part, in the order the parts first appear."""
    parts: dict[str, list[int]] = {}
    for index, region in enumerate(regions):
        parts.setdefault(region.part, []).append(index)
    return parts


def _part_colours(regions: Sequence[CutRegion], loops: Sequence[Sequence[Loop]]) -> dict[str, int]:
    """A colour per part so that parts whose faces share a boundary differ: the smallest one free."""
    parts = list(_parts(regions))
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
    """Fill the cut faces of a section view, one fill per part (see the module docstring)."""
    loops = [tuple(loop for loop in (_open([project(p) for p in model]) for model in region.loops) if len(loop) > 2)
             for region in regions]
    colours = _part_colours(regions, loops)
    linings: dict[str, Lining | None] = {}
    for part, members in _parts(regions).items():
        faces = [loops[i] for i in members]
        width = typical_width(faces)
        if width < SOLID_WIDTH:
            linings[part] = None
            continue
        colour = colours[part]
        spacing = spacing_for(width)
        angle = (outline_angle([loop for face in faces for loop in face]) + (45.0 if colour % 2 == 0 else -45.0)) % 180.0
        linings[part] = Lining(spacing, angle, spacing / 2 if (colour // 2) % 2 else 0.0)
    fills = []
    for index, (region, own) in enumerate(zip(regions, loops)):
        lining = linings[region.part]
        fills.append(FaceFill(index, own, lining, tuple(hatch_lines(own, lining)) if lining is not None else ()))
    return SectionFill(view, scale, tuple(regions), tuple(fills))


def markup(fill: FaceFill) -> str:
    """SVG of one face's fill: a black even-odd path over its loops, or its lining lines."""
    if fill.lining is None:
        path = " ".join("M " + " L ".join(f"{x:.3f} {y:.3f}" for x, y in loop) + " Z" for loop in fill.loops)
        return f'<path d="{path}" fill="#000" fill-rule="evenodd" stroke="none"/>'
    return "".join(f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" stroke="#000" '
                   f'stroke-width="{LINE_WIDTH:g}"/>' for x1, y1, x2, y2 in fill.lines)


# --- the gate -------------------------------------------------------------------------------------

def shown_area(fill: FaceFill) -> float:
    """Sheet area a face's fill shows as section (see the module docstring)."""
    area = region_area(fill.loops)
    if fill.lining is None:
        return area
    if fill.lining.spacing <= 0 or not fill.loops:
        return 0.0
    d = _direction(fill.lining.angle_deg)
    rotated = [[_to_lining(p, d) for p in loop] for loop in fill.loops]
    interior = sum(b - a for v in _grid(rotated, fill.lining) for a, b in _intervals(rotated, v))
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
    view = section.view
    if not section.regions:
        return [finding("section_hatch", f"section {view} cuts no material", view=view)]
    fills = {fill.face: fill for fill in section.fills}
    found = []
    for index, region in enumerate(section.regions):
        expected = region.area_mm2 * section.scale ** 2
        fill = fills.get(index)
        shown = 0.0 if fill is None else shown_area(fill)
        if abs(shown - expected) > AREA_TOLERANCE * expected:
            why = "; no lining line crosses it" if fill is not None and fill.lining is not None and not fill.lines else ""
            found.append(finding("section_hatch", f"section {view} cut face {index}: its "
                                 f"{fill.mode if fill else 'missing'} fill shows {shown:.2f} of {expected:.2f} mm² "
                                 f"on the sheet{why}", view=view, face=index))
    for part, members in _parts(section.regions).items():
        part_fills = [fills[i] for i in members if i in fills]
        if not part_fills:
            continue
        where = f"section {view} part {part}" if part else f"section {view}"
        linings = list(dict.fromkeys(fill.lining for fill in part_fills))
        if len(linings) > 1:
            found.append(finding("section_hatch", f"{where} is filled {len(linings)} ways across its cut faces; "
                                 f"one part takes one lining or one solid fill in a view", view=view, part=part))
            continue
        lining, width = linings[0], typical_width([fill.loops for fill in part_fills])
        if lining is None and width >= SOLID_WIDTH:
            found.append(finding("section_hatch", f"{where} is filled solid at a typical width of {width:.2f} mm; "
                                 f"only parts under {SOLID_WIDTH:g} mm are blackened, line it", view=view, part=part))
        elif lining is not None and lining.spacing < MIN_SPACING - 1e-9:
            found.append(finding("section_hatch", f"{where}: lining {lining.spacing:.2f} mm apart is under the "
                                 f"{MIN_SPACING:g} mm minimum", view=view, part=part))
        elif lining is not None and width / lining.spacing < LINES_ACROSS - 1e-9:
            found.append(finding("section_hatch", f"{where}: lining {lining.spacing:.2f} mm apart gives "
                                 f"{width / lining.spacing:.1f} lines across its {width:.2f} mm typical width, "
                                 f"under {LINES_ACROSS}; space it closer or fill it solid", view=view, part=part))
    return found
