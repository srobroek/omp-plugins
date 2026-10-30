"""Assembly sheets: view layout, item balloons, the parts list, assembly notes and page composition.

Kernel-free; ``assembly_drawing.py`` feeds it measured views and resolved operations.

- ``plan_sheet`` chooses the sheet: the smallest allowed size, and on it the largest ISO 5455 scale,
  at which every view fits beside the title block, parts list and notes with room for its balloons
  and label, and every ballooned occurrence is at least ``MIN_ITEM_EXTENT_MM`` across, so its leader
  dot lands visibly on it. All views of a sheet share the title block's scale.
- ``balloons`` places one ISO 6433 / ASME Y14.34 item balloon per item around a view: circles on a
  ring just outside the view in the angular order of their targets, so leaders do not cross, each
  leader ending with a dot on the measured visible point of the item's own occurrence.
- ``parts_list`` is the ISO 7573 / Y14.34 table generated from the BOM rows, header next to the
  title block; ``notes`` turns resolved operations into numbered assembly notes that state the
  installation direction, the seating check and the interface's fit, insert or ring, and nothing
  the record does not hold (no press force, torque or lubricant).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from assembly_check import DIRECTIONS, ORTHOGRAPHIC, PARTS_LIST_HEADINGS, TOP, PartsRow, ResolvedOperation, ViewRequest
from drawing_document import (CENTRING_MARK_INSIDE, FRAME_CLEARANCE, STANDARD_SCALES, THIN_WIDTH, CompositionError,
                              PageLayout, SheetSpec, SvgAnnotation, SvgNote, SvgTable, page_layout, text_width)
from freecad_views import ViewGeometry
from layout_check import TEXT_ASCENT, TEXT_DESCENT, Box

BALLOON_RADIUS = 4.5       # circle radius; the 5 mm item number's text box fits inside it
BALLOON_TEXT = 5.0         # item numbers one size above the 3.5 mm lettering (ISO 3098)
BALLOON_GAP = 4.0          # view geometry to the circle's edge
DOT_RADIUS = 0.6           # ISO 6433 leader terminating dot inside the part outline
BALLOON_SPACING = 1.5      # clear space between neighbouring circles
VIEW_MARGIN = 6.0          # around a view without balloons; two margins exceed layout_check's 10 mm view gap
LABEL_SIZE, LABEL_GAP = 3.5, 3.0
HEADING_SIZE, HEADING_GAP = 5.0, 4.0
MIN_ITEM_EXTENT_MM = 3.0   # smallest drawn size of a ballooned occurrence
BALLOON_RING = BALLOON_GAP + 2 * BALLOON_RADIUS + 1.0

DIRECTION_NAMES = {"front": "front", "back": "back", "left": "left", "right": "right", "top": "top",
                   "bottom": "bottom", "iso": "isometric"}
AXIS_NAMES = {(1, 0, 0): "+X", (-1, 0, 0): "-X", (0, 1, 0): "+Y", (0, -1, 0): "-Y", (0, 0, 1): "+Z", (0, 0, -1): "-Z"}
DOCUMENT_TYPE = {"iso": "Assembly drawing", "asme": "ASSEMBLY DRAWING"}
STANDARDS = {"iso": ("ISO 6433:2012", "ISO 7573:2008", "ISO 5456-3:1996"),
             "asme": ("ASME Y14.24-2020", "ASME Y14.34-2013", "ASME Y14.3-2012")}


def regime_text(regime: str, text: str) -> str:
    """ASME drawings letter notes and labels in capitals (Y14.2); ISO keeps the record's case."""
    return text.upper() if regime == "asme" else text


# --------------------------------------------------------------------------- views and layout


@dataclass(frozen=True)
class MeasuredView:
    """One requested view measured at scale 1: local bounds, and per ballooned occurrence its anchor and size."""

    request: ViewRequest
    label: str
    bounds: tuple[float, float, float, float]       # local millimetres at scale 1, Y down
    anchors: Mapping[str, tuple[float, float]]      # occurrence id -> local point at scale 1 (ballooned views)
    extents: Mapping[str, float]                    # occurrence id -> projected size at scale 1


@dataclass(frozen=True)
class SheetLayout:
    spec: SheetSpec
    page: PageLayout
    scale: float
    origins: Mapping[str, tuple[float, float]]     # view id -> sheet position of the view origin


def view_label(regime: str, request: ViewRequest) -> str:
    kind = "Assembled view" if request.kind == "assembled" else "Exploded view (presentation positions)"
    return regime_text(regime, f"{kind}, {DIRECTION_NAMES[request.direction]}")


def _padding(view: MeasuredView) -> float:
    return BALLOON_RING if view.request.balloons else VIEW_MARGIN


def _padded(view: MeasuredView, scale: float) -> tuple[float, float, float, float]:
    """Local box of the view at ``scale`` with its balloon ring and label strip."""
    x0, y0, x1, y1 = (v * scale for v in view.bounds)
    pad = _padding(view)
    left, right = x0 - pad, x1 + pad
    spill = (text_width(view.label, LABEL_SIZE) - (right - left)) / 2
    if spill > 0:
        left, right = left - spill, right + spill
    label = LABEL_GAP + (TEXT_ASCENT + TEXT_DESCENT) * LABEL_SIZE
    return (left, y0 - pad, right, y1 + pad + label)


def _regions(page: PageLayout, heading: str | None) -> list[Box]:
    """Rectangles free of the title block, tables and notes where views may go."""
    area = page.drawing_area
    strip = CENTRING_MARK_INSIDE + (TEXT_ASCENT + TEXT_DESCENT) * HEADING_SIZE + HEADING_GAP
    top = area.y0 + (strip if heading else 0.0)
    obstacles = page.obstacles
    above = Box(area.x0, top, area.x1, min(o.y0 for o in obstacles) - FRAME_CLEARANCE)
    title = page.title_region
    beside_x1 = title.x0 - FRAME_CLEARANCE
    beside_y1 = area.y1
    if page.notes is not None and page.notes.x0 < beside_x1 and page.notes.y0 > top:
        beside_y1 = page.notes.y0 - FRAME_CLEARANCE
    beside = Box(area.x0, top, beside_x1, beside_y1)
    return [r for r in (above, beside) if r.x1 > r.x0 and r.y1 > r.y0]


def _arrange(views: Sequence[MeasuredView], scale: float, region: Box, row: bool) -> dict[str, tuple[float, float]] | None:
    """View origins for a row (or column) of the views centred in ``region``, or None when they do not fit."""
    boxes = [_padded(v, scale) for v in views]
    sizes = [(b[2] - b[0], b[3] - b[1]) for b in boxes]
    along = [w if row else h for w, h in sizes]
    across = [h if row else w for w, h in sizes]
    length, depth = (region.x1 - region.x0, region.y1 - region.y0) if row else (region.y1 - region.y0, region.x1 - region.x0)
    if sum(along) > length or max(across) > depth:
        return None
    gap = (length - sum(along)) / (len(views) + 1)
    cursor = gap
    origins = {}
    for view, box, a, c in zip(views, boxes, along, across):
        offset = (depth - c) / 2
        x, y = (region.x0 + cursor, region.y0 + offset) if row else (region.x0 + offset, region.y0 + cursor)
        origins[view.request.id] = (x - box[0], y - box[1])
        cursor += a + gap
    return origins


def _floor(views: Sequence[MeasuredView]) -> float:
    """The smallest scale at which every ballooned occurrence is MIN_ITEM_EXTENT_MM across."""
    sizes = [size for v in views if v.request.balloons for oid, size in v.extents.items() if oid in v.anchors and size > 0]
    return MIN_ITEM_EXTENT_MM / min(sizes) if sizes else 0.0


def plan_sheet(specs: Sequence[SheetSpec], views: Sequence[MeasuredView], tables: Sequence[SvgTable],
               notes: Sequence[SvgNote], heading: str | None) -> SheetLayout:
    """The smallest sheet and, on it, the largest standard scale that fits the views legibly."""
    floor = _floor(views)
    tried = []
    for spec in specs:
        try:
            page = page_layout(spec, tables, notes)
        except CompositionError as exc:
            tried.append(f"{spec.size}: {exc}")
            continue
        regions = _regions(page, heading)
        best = None
        for scale in STANDARD_SCALES:
            for region in regions:
                for row in (True, False):
                    origins = _arrange(views, scale, region, row)
                    if origins is not None:
                        best = (scale, origins)
                        break
                if best:
                    break
            if best:
                break
        if best is None:
            tried.append(f"{spec.size}: no standard scale fits the views")
        elif best[0] < floor * (1 - 1e-9):
            tried.append(f"{spec.size}: fits at 1:{1 / best[0]:g}, below the legibility floor 1:{1 / floor:.3g}")
        else:
            return SheetLayout(spec=spec, page=page, scale=best[0], origins=best[1])
    raise CompositionError("sheet_no_fit", "no allowed sheet fits the assembly views legibly: " + "; ".join(tried))


# --------------------------------------------------------------------------- balloons


def _perimeter_point(ring: Box, t: float) -> tuple[float, float]:
    """The point at arc length ``t`` along ``ring``, clockwise from its top-left corner (Y down)."""
    w, h = ring.x1 - ring.x0, ring.y1 - ring.y0
    t %= 2 * (w + h)
    if t < w:
        return ring.x0 + t, ring.y0
    if t < w + h:
        return ring.x1, ring.y0 + (t - w)
    if t < 2 * w + h:
        return ring.x1 - (t - w - h), ring.y1
    return ring.x0, ring.y1 - (t - 2 * w - h)


def _nearest_t(ring: Box, target: tuple[float, float]) -> float:
    """Arc length of the point of ``ring`` nearest to ``target``, a point inside it."""
    w, h = ring.x1 - ring.x0, ring.y1 - ring.y0
    x = min(max(target[0], ring.x0), ring.x1)
    y = min(max(target[1], ring.y0), ring.y1)
    side = min((y - ring.y0, 0), (ring.x1 - x, 1), (ring.y1 - y, 2), (x - ring.x0, 3))[1]
    return (x - ring.x0, w + (y - ring.y0), w + h + (ring.x1 - x), 2 * w + h + (ring.y1 - y))[side]


def _spread(preferred: list[float], spacing: float, perimeter: float) -> list[float]:
    """Positions as close as possible to ``preferred`` (sorted, on a loop) and at least ``spacing`` apart.

    The loop is cut at the widest gap between preferred positions; on the resulting line the
    least-squares spacing problem is isotonic regression of ``p_i - i*spacing`` (pool adjacent violators).
    """
    n = len(preferred)
    if n * spacing > perimeter:
        raise CompositionError("sheet_no_fit", f"{n} balloons need {n * spacing:.0f} mm around a view of "
                                               f"{perimeter:.0f} mm perimeter")
    if n < 2:
        return list(preferred)
    gaps = [(preferred[(i + 1) % n] - preferred[i]) % perimeter for i in range(n)]
    start = (max(range(n), key=lambda i: gaps[i]) + 1) % n
    line = []
    for k in range(n):
        value = preferred[(start + k) % n]
        while line and value < line[-1]:
            value += perimeter
        line.append(value)
    blocks: list[list[float]] = []   # [mean, weight] of pooled shifted values
    for i, value in enumerate(line):
        blocks.append([value - i * spacing, 1.0])
        while len(blocks) > 1 and blocks[-2][0] > blocks[-1][0]:
            mean, weight = blocks.pop()
            blocks[-1][0] = (blocks[-1][0] * blocks[-1][1] + mean * weight) / (blocks[-1][1] + weight)
            blocks[-1][1] += weight
    shifted = [mean for mean, weight in blocks for _ in range(int(weight))]
    placed = [u + i * spacing for i, u in enumerate(shifted)]
    result = [0.0] * n
    for k, value in enumerate(placed):
        result[(start + k) % n] = value % perimeter
    return result


@dataclass(frozen=True)
class BalloonTarget:
    item: int
    occurrence: str
    anchor: tuple[float, float]   # sheet millimetres: the visible surface point of the occurrence


def balloons(view: ViewGeometry, targets: Sequence[BalloonTarget]) -> list[SvgAnnotation]:
    """One balloon per target on a ring around ``view``, each near the ring point closest to its target.

    Keeping the targets' order along the ring keeps leaders from crossing one another.
    """
    x0, y0, x1, y1 = view.sheet_bounds()
    reach = BALLOON_GAP + BALLOON_RADIUS
    ring = Box(x0 - reach, y0 - reach, x1 + reach, y1 + reach)
    perimeter = 2 * ((ring.x1 - ring.x0) + (ring.y1 - ring.y0))
    ordered = sorted(targets, key=lambda target: _nearest_t(ring, target.anchor))
    spacing = 2 * BALLOON_RADIUS + BALLOON_SPACING
    # A corner shortens the straight distance between neighbours to spacing / sqrt(2) at worst.
    positions = _spread([_nearest_t(ring, t.anchor) for t in ordered], spacing * math.sqrt(2), perimeter)
    annotations = []
    for target, t in zip(ordered, positions):
        cx, cy = _perimeter_point(ring, t)
        ax, ay = target.anchor
        distance = math.hypot(ax - cx, ay - cy)
        ux, uy = (ax - cx) / distance, (ay - cy) / distance
        sx, sy = cx + ux * BALLOON_RADIUS, cy + uy * BALLOON_RADIUS
        baseline = cy + (TEXT_ASCENT - TEXT_DESCENT) * BALLOON_TEXT / 2
        markup = (f'<g data-item="{target.item}" data-occurrence="{target.occurrence}" data-view="{view.view_id}">'
                  f'<line x1="{sx:.4f}" y1="{sy:.4f}" x2="{ax:.4f}" y2="{ay:.4f}" stroke="#000" '
                  f'stroke-width="{THIN_WIDTH}"/>'
                  f'<circle cx="{ax:.4f}" cy="{ay:.4f}" r="{DOT_RADIUS}" fill="#000" stroke="none"/>'
                  f'<circle cx="{cx:.4f}" cy="{cy:.4f}" r="{BALLOON_RADIUS}" fill="none" stroke="#000" '
                  f'stroke-width="{THIN_WIDTH}"/>'
                  f'<text x="{cx:.4f}" y="{baseline:.4f}" font-size="{BALLOON_TEXT}" font-family="osifont" '
                  f'text-anchor="middle" fill="#000" stroke="none">{target.item}</text></g>')
        annotations.append(SvgAnnotation(id=f"balloon-{view.view_id}-{target.item}", kind="leader", markup=markup,
                                         provenance={"item": str(target.item), "occurrence": target.occurrence,
                                                     "view": view.view_id, "anchor": f"{ax:.4f},{ay:.4f}"}))
    return annotations


def label(view: ViewGeometry, text: str, ballooned: bool) -> SvgAnnotation:
    """The view's label, centred under its geometry and balloon ring."""
    x0, _, x1, y1 = view.sheet_bounds()
    pad = BALLOON_RING if ballooned else VIEW_MARGIN
    baseline = y1 + pad + LABEL_GAP + TEXT_ASCENT * LABEL_SIZE
    markup = (f'<text x="{(x0 + x1) / 2:.4f}" y="{baseline:.4f}" font-size="{LABEL_SIZE}" font-family="osifont" '
              f'text-anchor="middle" fill="#000" stroke="none">{_escape(text)}</text>')
    return SvgAnnotation(id=f"label-{view.view_id}", kind="label", markup=markup)


def heading(spec: SheetSpec, text: str) -> SvgAnnotation:
    """The sheet's scope heading in the drawing area's top left corner, below the centring marks."""
    area = spec.drawing_area()
    if text_width(text, HEADING_SIZE) > area.x1 - area.x0:
        raise CompositionError("sheet_no_fit", f"the sheet heading {text!r} is wider than the {spec.size} drawing area")
    baseline = area.y0 + CENTRING_MARK_INSIDE + TEXT_ASCENT * HEADING_SIZE
    markup = (f'<text x="{area.x0:.4f}" y="{baseline:.4f}" font-size="{HEADING_SIZE}" '
              f'font-family="osifont" font-weight="bold" fill="#000" stroke="none">{_escape(text)}</text>')
    return SvgAnnotation(id="sheet-heading", kind="label", markup=markup)


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# --------------------------------------------------------------------------- parts list and notes


def parts_list(regime: str, rows: Sequence[PartsRow]) -> SvgTable:
    """The parts list, item 1 next to the header (ISO 7573 reads upward from the title block)."""
    return SvgTable(id="parts-list", columns=PARTS_LIST_HEADINGS[regime], rows=tuple(row.cells() for row in rows))


def direction_text(vector: Sequence[float]) -> str:
    length = math.hypot(*vector)
    unit = tuple(v / length for v in vector)
    for axis, name in AXIS_NAMES.items():
        if all(abs(u - a) < 1e-6 for u, a in zip(unit, axis)):
            return name
    return "(" + ", ".join(f"{u:.2f}" for u in unit) + ")"


def _words(feature: str) -> str:
    return feature.replace("_", " ")


def _number(value: float) -> str:
    return f"{value:g}"


def operation_note(op: ResolvedOperation, measured: Mapping[str, Any], regime: str) -> str:
    """One assembly note: what goes where, which way, how it is known to be seated, and the interface data.

    A standoff states the gap measured on the assembled model; directions are assembly-frame axes.
    ASME capitals apply to the note's own words only: fit, groove and insert designations keep the
    record's case, because ``5 H7/p6`` and ``5 H7/P6`` are different fits.
    """
    def words(text: str) -> str:
        return regime_text(regime, text)

    operation, limit = op.operation, op.limit
    features = [words(_words(f)) for f in operation.features]
    if operation.acceptance == "seated":
        until = words("its ") + features[0] + words(" seats against the ") + features[1]
    elif operation.acceptance == "standoff":
        gap = measured.get("gap")
        if gap is None:
            until = (words("its ") + features[0] + words(" stands off the ") + features[1] +
                     words(" by the modelled gap; gap not measured"))
        else:
            until = (words("its ") + features[0] + words(" stands ") + f"{round(gap, 2):g} mm" +
                     words(" off the ") + features[1] + words(", as modelled"))
    elif operation.acceptance == "flush":
        until = words("its ") + features[0] + words(" is flush with the ") + features[1]
    else:
        until = words("it is fully engaged in the ") + features[0]
    direction = direction_text(op.direction)
    if operation.kind == "press_fit":
        action = words(f"Press item {op.part_item} into item {op.into_item}")
        data = words("fit ") + str(limit["fit"])
    elif operation.kind == "heat_set":
        action = words(f"Heat-set item {op.part_item} into item {op.into_item}")
        lower, upper = limit.get("hole_tol", (0.0, 0.0))
        tolerance = f" ±{_number(upper)}" if lower == -upper and upper else (
            f" {lower:+g}/{upper:+g}" if lower or upper else "")
        data = str(limit["insert"]) + words(" in hole ") + f"⌀{_number(limit['hole_d'])}{tolerance}"
        if "depth_min" in limit:
            data += words(f", depth min {_number(limit['depth_min'])}")
    else:
        action = words(f"Fit ring item {op.part_item} onto item {op.into_item}")
        data = str(limit["ring"])
        if "groove_d" in limit and "groove_w" in limit:
            data += words(", groove ") + f"⌀{limit['groove_d']} x {limit['groove_w']}"
    text = f"{action}{words(' along ')}{direction}{words(' until ')}{until}; {data} ({operation.interface})."
    if op.travel is not None:
        unit = "°" if op.travel.kind == "revolute" else " mm"
        text += (words(f" Then check that item {op.travel.child_item} moves freely on item {op.travel.parent_item} from ")
                 + f"{_number(op.travel.low)}{unit}" + words(" to ") + f"{_number(op.travel.high)}{unit} "
                 + f"({op.travel.joint}).")
    return text


def frame_note(views: Sequence[ViewRequest]) -> str | None:
    """Where the assembly frame's axes point in the sheet's first orthographic view; None without one."""
    view = next((v for v in views if v.direction in ORTHOGRAPHIC), None)
    if view is None:
        return None
    direction, right = DIRECTIONS[view.direction]
    up = (direction[1] * right[2] - direction[2] * right[1], direction[2] * right[0] - direction[0] * right[2],
          direction[0] * right[1] - direction[1] * right[0])
    return (f"Directions are axes of the assembly frame: in the {view.kind} {DIRECTION_NAMES[view.direction]} view "
            f"{direction_text(right)} points right and {direction_text(up)} up.")


def scope_note(regime: str, scope: str, excludes: Sequence[str]) -> str:
    """What the drawing covers; the excluded items keep the record's wording."""
    if scope == "complete_assembly":
        return regime_text(regime, "Scope: the complete assembly.")
    note = regime_text(regime, "Scope: the modelled mechanical assembly")
    return note + ((regime_text(regime, "; not included: ") + "; ".join(excludes) + ".") if excludes else ".")


def notes(regime: str, scope: str, sheet_scope: str, excludes: Sequence[str], operations: Sequence[ResolvedOperation],
          frame: str | None, measured: Mapping[str, Mapping[str, Any]]) -> list[SvgNote]:
    """The sheet's numbered notes: the drawing scope on the top sheet, the frame, then one note per operation."""
    found = []
    if sheet_scope == TOP:
        found.append(SvgNote(id="note-scope", text=scope_note(regime, scope, excludes)))
    if operations and frame is not None:
        found.append(SvgNote(id="note-frame", text=regime_text(regime, frame)))
    for op in operations:
        found.append(SvgNote(id=f"note-{op.operation.id.replace('_', '-')}",
                             text=operation_note(op, measured[op.operation.id], regime),
                             provenance={"operation": op.operation.id, "interface": op.operation.interface,
                                         "kind": op.operation.kind}))
    return found
