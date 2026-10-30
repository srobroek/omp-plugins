"""Part sheet composition: dimensions, callouts, datums and section marks on projected part views.

``drawing.py`` measures a part (``drawing_intent``), plans its views (``part_views``) and runs
``techdraw_job.py``; this module turns the measured characteristics into annotations on those views
and lays them out around each view:

- a location (plane or axis coordinate in the datum frame) is a linear dimension from the datum it
  is measured from, stacked in parallel rows above the view (sheet x) or to its right (sheet y);
- every other characteristic joins its feature's callout: a leader from a text block in a column
  left or right of the view to a point of the feature's projected outline, with feature control
  frames under the text and a datum feature symbol for a datum feature;
- centre lines for cylinder axes, cutting-plane lines with view letters, detail circles and the
  section fill of every cut face (``section_hatch``) complete the views.

Each annotation's leader or extension line ends on a point of the feature's own faces that projects
onto the view's visible geometry; ``Presentation.unplaced`` lists characteristics with no such
point in any allowed view (``feature_not_presentable``). Values are the measured ones, formatted;
fit and heat-set sizes print their nominal, class and limits, never the modelled midpoint.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Any
from xml.sax.saxutils import escape

import feature_geometry as fg
from drawing_document import SvgAnnotation, text_width
from drawing_intent import Characteristic, DatumFrame, Tolerance, cylinder_instances
from feature_geometry import Face, ResolvedFeature
from freecad_views import ViewGeometry
from layout_check import TEXT_ASCENT, TEXT_DESCENT, Box, path_points
from part_views import ViewPlan
from section_hatch import CutRegion, SectionFill, fill_section, markup as fill_markup

THIN = 0.25
ARROW_LENGTH, ARROW_HALF_WIDTH = 2.5, 0.45
EXT_GAP, EXT_OVERSHOOT = 1.0, 1.5
ROW_PITCH = 8.0            # between parallel dimension lines
FIRST_ROW = 10.0           # view outline to the first dimension line
COLUMN_GAP = 8.0           # view outline (or the last dimension row) to a callout column
LINE_PITCH_FACTOR = 1.45   # callout line pitch / text height
BLOCK_GAP = 2.0
LANDING = 3.0
VISIBLE_TOLERANCE = 0.25   # sheet mm between a projected anchor and the view's visible geometry
LABEL_GAP = 4.0
CHAIN_DASH = "6 1.5 1 1.5"  # ISO 128-2 long dashed dotted line (centre lines, cutting planes), 0.25 mm


# --- formatting -----------------------------------------------------------------------------------

def number(value: float | Decimal, places: int = 3) -> str:
    text = f"{float(value):.{places}f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def signed(value: Decimal) -> str:
    """A limit deviation with three decimals (micrometre steps), as ISO 286 tables print them."""
    if value == 0:
        return "0"
    return ("+" if value > 0 else "−") + f"{abs(value):.3f}"


def tolerance_text(tol: Tolerance | None, measured: float, regime: str) -> tuple[str, str]:
    """(nominal text, tolerance suffix) of a size: fits print class and limits, never the modelled value."""
    if tol is None or not tol.individual:   # the general tolerance note or the basic box states it
        return number(measured), ""
    nominal = tol.nominal if tol.nominal is not None else Decimal(number(measured))
    if tol.kind == "fit":
        low, high = nominal + tol.lower, nominal + tol.upper
        if regime == "asme":
            return limits(high, low), f" ({number(nominal)} {tol.designation})"
        return f"{number(nominal)} {tol.designation}", f" ({signed(tol.upper)}/{signed(tol.lower)})"
    if tol.lower == -tol.upper:
        return number(nominal), f" ±{number(tol.upper)}"
    return number(nominal), f" {signed(tol.upper)}/{signed(tol.lower)}"


def limits(high: Decimal, low: Decimal) -> str:
    """ASME Y14.5 limit dimensioning: both limits carry the same number of decimal places."""
    places = max(len(number(v).partition(".")[2]) for v in (high, low))
    return f"{float(high):.{places}f}/{float(low):.{places}f}"


def times(regime: str) -> str:
    """The multiplication sign: ASME Y14.5 writes X, ISO 129-1 the × sign."""
    return "X" if regime == "asme" else "×"


def count_prefix(quantity: int, regime: str) -> str:
    """'4× ' (ISO) or '4X ' (ASME) before a dimension that applies to several places."""
    return f"{quantity}{times(regime)} " if quantity > 1 else ""


def size_text(char: Characteristic, regime: str, symbol: str = "") -> str:
    nominal, suffix = tolerance_text(char.tolerance, char.value, regime)
    return f"{count_prefix(char.quantity, regime)}{symbol}{nominal}{suffix}"


GDT_SYMBOLS = {"position": "⌖", "coaxiality": "◎", "perpendicularity": "⊥", "parallelism": "∥", "flatness": "⏥",
               "cylindricity": "⌭", "circular_runout": "↗", "total_runout": "⌰", "profile_surface": "⌓"}


# --- edges and surface texture ---------------------------------------------------------------------
# Design intent from part.yaml, never measured. ISO 13715:2017 §4.2 signs an edge size: + permits excess
# material (the burr of an external edge, the passing of an internal one) and − requires its removal (an
# edge break, an undercut); §4.3 writes one limit when the other is zero, ± for symmetric limits, else
# upper/lower. ASME has no edge symbol, so the same limits read as the customary burr, break and corner note.

def _signed_size(value: Decimal) -> str:
    return ("+" if value > 0 else "−") + number(abs(value))


def edge_size(limits: Sequence[float]) -> str:
    """An ISO 13715 edge size from its ``[lower, upper]`` limits in mm: ``−0.1/−0.3``, ``+0.3`` or ``±0.05``."""
    lower, upper = (Decimal(str(v)) for v in limits)
    if lower == -upper:
        return f"±{number(upper)}"
    if lower == 0 or upper == 0:
        return _signed_size(upper or lower)
    return f"{_signed_size(upper)}/{_signed_size(lower)}"


def _asme_edges(limits: Sequence[float], internal: bool, brief: bool = False) -> str:
    """The limits as an ASME note; ``brief`` for a feature's callout, where the general note gives the words."""
    lower, upper = (Decimal(str(v)) for v in limits)
    lo, up = number(abs(lower)), number(abs(upper))
    if internal:
        corners = "CORNERS" if brief else "INTERNAL CORNERS"
        if lower >= 0:
            return (f"{corners} R{up} MAX" + ("" if brief else ", NO UNDERCUT")) if lower == 0 else f"{corners} R{lo}-{up}"
        if upper <= 0:
            return f"{corners} UNDERCUT {lo} MAX" if upper == 0 else f"{corners} UNDERCUT {up}-{lo}"
        return f"{corners} R{up} OR UNDERCUT {lo} MAX"
    if upper <= 0:
        if brief:
            return f"BREAK EDGES {lo} MAX" if upper == 0 else f"BREAK EDGES {up}-{lo}"
        return (f"REMOVE ALL BURRS, EDGE BREAK {lo} MAX" if upper == 0
                else f"REMOVE ALL BURRS AND BREAK SHARP EDGES {up}-{lo}")
    if lower >= 0:
        burrs = f"BURRS {up} MAX" if lower == 0 else f"BURRS {lo}-{up}"
        return burrs if brief else f"{burrs}, DO NOT BREAK EDGES"
    return f"BURRS {up} MAX OR EDGE BREAK {lo} MAX"


def edge_note(edges: Mapping[str, Sequence[float]], regime: str, exceptions: bool) -> str:
    """The general indication of the edges of undefined shape (ISO 13715:2017 §4.5.4, exceptions §4.5.5)."""
    if regime == "asme":
        return (f"UNDEFINED EDGES: {_asme_edges(edges['external'], False)}; {_asme_edges(edges['internal'], True)}"
                + (", EXCEPT AS SHOWN." if exceptions else "."))
    return (f"Edges of undefined shape ISO 13715: external {edge_size(edges['external'])}, internal "
            f"{edge_size(edges['internal'])}" + ("; exceptions as indicated." if exceptions else "."))


def edge_lines(edges: Mapping[str, Sequence[float]], regime: str) -> list[str]:
    """A feature's own edge sizes, an exception to the general indication, as lines of its callout."""
    return [_asme_edges(edges[kind], kind == "internal", brief=True) if regime == "asme"
            else f"{kind} edges {edge_size(edges[kind])}" for kind in ("external", "internal") if kind in edges]


GENERAL_NOTE = "general_note"        # a feature presentation: its rounds or chamfers go in one sheet note
GENERAL_NOTE_ID = "general-edges"


def general_edges_note(chars: Sequence[Characteristic], regime: str) -> str:
    """The undimensioned edge fillets and edge breaks, each size stated once in a general note."""
    radii = sorted({size_text(replace(c, quantity=1), regime, "R") for c in chars if c.operation == "radius"})
    chamfers = sorted({_callout_text(replace(c, quantity=1), regime) for c in chars if c.operation == "chamfer"})
    if regime == "asme":
        parts = ([f"FILLETS AND ROUNDS {', '.join(radii)}"] if radii else []) + \
                ([f"EDGE CHAMFERS {', '.join(chamfers)}"] if chamfers else [])
        return "UNLESS OTHERWISE SPECIFIED: " + "; ".join(parts) + "."
    parts = ([f"fillets and rounds {', '.join(radii)}"] if radii else []) + \
            ([f"edge chamfers {', '.join(chamfers)}"] if chamfers else [])
    return "Unless otherwise indicated: " + "; ".join(parts) + "."


TAN30 = math.tan(math.radians(30.0))
TEXTURE_TEXT_GAP = 0.6   # between the symbol's bar and the requirement under it
TEXTURE_GAP = 1.0        # above a symbol in a callout block


@dataclass(frozen=True)
class TextureSymbol:
    """A surface texture symbol (ISO 21920-1:2021 §6.2 Figure 4; ASME Y14.36-2018): two legs at 60° to the
    surface, the bar with the requirement under it (``Ra 0.8``, §7.3 and §7.4), a line closing the legs when
    material shall be removed and a circle when it shall not. ``others`` follows a general indication with
    the basic symbol in parentheses for the surfaces that carry their own requirement (§9.1.2).

    Legs of 1.4 and 3 lettering heights: the proportions of ISO 1302:2002 Annex A, which ISO 21920-1 replaced.
    """

    requirement: str
    process: str              # any | removal_required | removal_prohibited
    others: bool = False

    @classmethod
    def of(cls, texture: Mapping[str, Any]) -> TextureSymbol:
        return cls(f"{texture['parameter']} {number(texture['limit_um'])}", texture["process"])

    def _layout(self, height: float) -> tuple[float, float, float, float]:
        """Short and long leg heights, then the requirement's and the bar's end x from the box's left edge."""
        short, long = 1.4 * height, 3.0 * height
        text_x = TAN30 * (short + long - TEXTURE_TEXT_GAP) + 0.5   # clear of the long leg under the bar
        return short, long, text_x, text_x + text_width(self.requirement, height) + 0.5

    def size(self, height: float) -> tuple[float, float]:
        short, long, _, bar_end = self._layout(height)
        others = 1.5 + 2 * (0.12 * long + 0.6) + TAN30 * (short + long) if self.others else 0.0
        return bar_end + others, long

    def markup(self, x: float, y: float, height: float) -> str:
        """The symbol in the box whose top left corner is (x, y); its vertex is the box's lowest point."""
        short, long, text_x, bar_end = self._layout(height)
        vx, vy = x + TAN30 * short, y + long
        parts = [_legs(vx, vy, short, long), _line(vx + TAN30 * long, y, x + bar_end, y),
                 _text(self.requirement, x + text_x, y + TEXTURE_TEXT_GAP + TEXT_ASCENT * height, height)]
        if self.process == "removal_required":
            parts.append(_line(vx - TAN30 * short, vy - short, vx + TAN30 * short, vy - short))
        elif self.process == "removal_prohibited":
            parts.append(f'<circle cx="{vx:.3f}" cy="{vy - 2 * short / 3:.3f}" r="{short / 3:.3f}" fill="none" '
                         f'stroke="#000" stroke-width="{THIN:g}"/>')
        if self.others:
            bulge = 0.12 * long
            radius = (long * long / 4 + bulge * bulge) / (2 * bulge)
            left = x + bar_end + 1.5 + bulge
            inner = left + 0.6 + TAN30 * short
            right = inner + TAN30 * long + 0.6
            for edge, sweep in ((left, 0), (right, 1)):
                parts.append(f'<path d="M {edge:.3f} {y:.3f} A {radius:.3f} {radius:.3f} 0 0 {sweep} {edge:.3f} '
                             f'{y + long:.3f}" fill="none" stroke="#000" stroke-width="{THIN:g}"/>')
            parts.append(_legs(inner, vy, short, long))
        return "".join(parts)


def _legs(vx: float, vy: float, short: float, long: float) -> str:
    """The basic symbol: a short leg up and left, a long one up and right, both at 60° to the surface."""
    return _line(vx - TAN30 * short, vy - short, vx, vy) + _line(vx, vy, vx + TAN30 * long, vy - long)


# --- view data --------------------------------------------------------------------------------------

@dataclass
class ViewData:
    """One serialised view with its model-to-sheet map and a lookup of its visible outline.

    ``placed`` returns the same view at another scale and sheet position without FreeCAD: TechDraw
    geometry scales about the view origin, so planning reuses one probe run per view.
    """

    plan: ViewPlan
    geometry: ViewGeometry
    affine: Sequence[Sequence[float]]
    cut_faces: Mapping[int, Sequence[Sequence[float]]] = field(default_factory=dict)
    cut_regions: Sequence[CutRegion] = ()     # section views: the faces of the cut
    clip_radius: float | None = None         # detail views: sheet radius of the boundary circle
    source: tuple[Any, float, tuple[float, float], tuple[float, float]] | None = None  # (view, zoom, pivot, centre)
    _cells: dict[tuple[int, int], list[tuple[float, float, float, float]]] | None = None

    def project(self, point: Sequence[float]) -> tuple[float, float]:
        a = self.affine
        return (a[0][0] * point[0] + a[0][1] * point[1] + a[0][2] * point[2] + a[0][3],
                a[1][0] * point[0] + a[1][1] * point[1] + a[1][2] * point[2] + a[1][3])

    def bounds(self) -> Box:
        if self.clip_radius is not None:
            cx, cy = self.geometry.centre_mm
            return Box(cx - self.clip_radius, cy - self.clip_radius, cx + self.clip_radius, cy + self.clip_radius)
        return Box(*self.geometry.sheet_bounds())

    def placed(self, scale: float, centre: tuple[float, float], pivot: tuple[float, float] | None = None,
               plan: ViewPlan | None = None, clip_radius: float | None = None) -> ViewData:
        """This view at ``scale`` with sheet point ``pivot`` (default: its origin) moved to ``centre``."""
        zoom = scale / self.geometry.scale
        pivot = pivot or self.geometry.centre_mm
        cx, cy = self.geometry.centre_mm
        bounds = tuple(v * zoom for v in self.geometry.bounds)
        shift = (centre[0] + (cx - pivot[0]) * zoom, centre[1] + (cy - pivot[1]) * zoom)
        geometry = replace(self.geometry, centre_mm=centre if clip_radius is not None else shift, scale=scale,
                           bounds=bounds)
        affine = [[zoom * row[0], zoom * row[1], zoom * row[2], zoom * (row[3] - pivot[k]) + centre[k]]
                  for k, row in enumerate(self.affine)]
        return ViewData(plan or self.plan, geometry, affine, self.cut_faces, self.cut_regions, clip_radius,
                        (self, zoom, pivot, centre))

    def _segments(self) -> dict[tuple[int, int], list[tuple[float, float, float, float]]]:
        if self._cells is None:
            cx, cy = self.geometry.centre_mm
            cells: dict[tuple[int, int], list[tuple[float, float, float, float]]] = {}
            for path in self.geometry.visible:
                points = [(cx + x, cy + y) for x, y in path_points(path)]
                for (x1, y1), (x2, y2) in zip(points, points[1:]):
                    for i in range(int(math.floor(min(x1, x2))) - 1, int(math.floor(max(x1, x2))) + 2):
                        for j in range(int(math.floor(min(y1, y2))) - 1, int(math.floor(max(y1, y2))) + 2):
                            cells.setdefault((i, j), []).append((x1, y1, x2, y2))
            self._cells = cells
        return self._cells

    def on_visible(self, point: tuple[float, float], tolerance: float = VISIBLE_TOLERANCE) -> bool:
        if self.clip_radius is not None:
            cx, cy = self.geometry.centre_mm
            if math.hypot(point[0] - cx, point[1] - cy) > self.clip_radius:
                return False
        if self.source is not None:
            view, zoom, pivot, centre = self.source
            return view.on_visible((pivot[0] + (point[0] - centre[0]) / zoom, pivot[1] + (point[1] - centre[1]) / zoom),
                                   tolerance / zoom)
        x, y = point
        for x1, y1, x2, y2 in self._segments().get((int(math.floor(x)), int(math.floor(y))), ()):
            dx, dy = x2 - x1, y2 - y1
            length2 = dx * dx + dy * dy
            t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / length2))
            if math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= tolerance:
                return True
        return False


def candidate_points(face: Face, view: ViewData) -> list[Sequence[float]]:
    """Model points of a face that can lie on its projected outline in ``view``."""
    points: list[Sequence[float]] = list(face.boundary_points())
    direction = view.plan.direction
    if face.support_type in ("cylinder", "cone", "torus") and face.axis_dir is not None \
            and fg.perpendicular(face.axis_dir, direction):
        axis = fg.unit(face.axis_dir)
        across = fg.unit(fg.cross(axis, direction))
        if face.support_type == "cylinder" and face.axial:
            for k in range(9):
                t = face.axial[0] + (face.axial[1] - face.axial[0]) * k / 8
                for sign in (1, -1):
                    points.append(fg.add(fg.add(face.axis_point, fg.scale(axis, t)), fg.scale(across, sign * face.radius)))
        elif face.support_type == "torus":
            for k in range(13):
                theta = 2 * math.pi * k / 12
                for sign in (1, -1):
                    tube = fg.add(face.axis_point, fg.scale(across, sign * face.major_radius))
                    radial = fg.add(fg.scale(across, sign * math.cos(theta)), fg.scale(axis, math.sin(theta)))
                    points.append(fg.add(tube, fg.scale(radial, face.radius)))
    points.extend(view.cut_faces.get(face.index, ()))
    return points


def visible_points(faces: Sequence[Face], view: ViewData) -> list[tuple[Sequence[float], tuple[float, float]]]:
    """(model point, sheet point) pairs of the faces that land on the view's visible geometry."""
    found = []
    for face in faces:
        for point in candidate_points(face, view):
            projected = view.project(point)
            if view.on_visible(projected):
                found.append((point, projected))
    return found


def visible_anchors(faces: Sequence[Face], view: ViewData) -> list[tuple[float, float]]:
    return [sheet for _, sheet in visible_points(faces, view)]


SHOWN_MARGIN = 0.05   # a later view must show this much more of a feature's outline to take its dimension


def _shown(own: Sequence[Face], view: ViewData) -> float:
    """The share of the faces' outline points that land on the view's visible geometry."""
    total = sum(len(candidate_points(face, view)) for face in own)
    return len(visible_points(own, view)) / total if total else 0.0


# --- annotation items ---------------------------------------------------------------------------------

@dataclass
class Callout:
    id: str
    view: str
    anchor: tuple[float, float]
    lines: list[str]
    frames: list[list[str]] = field(default_factory=list)   # feature control frames, cells left to right
    textures: list[TextureSymbol] = field(default_factory=list)  # surface texture symbols, under the frames
    datum: str | None = None                                # a datum feature symbol instead of a leader arrow
    datum_tag: str | None = None                            # an axis datum attached to this size callout
    characteristics: list[str] = field(default_factory=list)
    side: int = -1                                          # -1 left column, +1 right column
    candidates: list[tuple[float, float]] = field(default_factory=list)  # visible outline points of the feature


@dataclass
class Linear:
    id: str
    view: str
    origin: tuple[float, float]          # extension-line foot on the datum side
    target: tuple[float, float]          # extension-line foot on the feature
    horizontal: bool                     # measured along sheet x
    text: str
    boxed: bool = False                  # a basic (theoretically exact) dimension
    reference: bool = False
    characteristics: list[str] = field(default_factory=list)
    # thin lines extending outlines to a theoretical sharp corner a foot stands on (ISO 129-1, a chamfered edge)
    construction: list[tuple[tuple[float, float], tuple[float, float]]] = field(default_factory=list)
    side: int = 1                        # +1 above or right of the view, -1 below or left (feet on that edge)


@dataclass
class Presentation:
    callouts: list[Callout] = field(default_factory=list)
    linears: list[Linear] = field(default_factory=list)
    placed: dict[str, dict[str, Any]] = field(default_factory=dict)    # characteristic id -> annotation and view
    unplaced: list[dict[str, Any]] = field(default_factory=list)


LINEAR_OPERATIONS = ("location", "axis_location", "floor_location", "plane_separation", "thickness", "distance")


def is_linear(char: Characteristic) -> bool:
    """Drawn as a linear dimension: a location or separation, or any size stated at a reference plane."""
    return char.operation in LINEAR_OPERATIONS or bool(char.details.get("at"))


def _preferred(char: Characteristic, plans: Sequence[ViewPlan]) -> list[ViewPlan]:
    if is_linear(char):
        # a dimension from a datum needs both ends on the sheet: projected views, then sections; presentation
        # section puts the sections first, so interior sizes leave the principal view
        order = ("section", "part") if char.presentation == "section" else ("part", "section")
        return sorted((p for p in plans if p.kind != "detail"), key=lambda p: order.index(p.kind))
    wanted = {"section": ("section",), "detail": ("detail",), "visible": ("part",)}.get(char.presentation)
    ordered = [p for p in plans if wanted is None or p.kind in wanted]
    if wanted is None:  # auto: projected views first, then sections, then details
        ordered.sort(key=lambda p: ("part", "section", "detail").index(p.kind))
    return ordered


MIN_VISIBLE_FRACTION = 0.2  # share of a feature's outline points that must be visible for a view to present it


def _best_view(own: Sequence[Face], plans: Sequence[ViewPlan], views: Mapping[str, ViewData],
               holding: set[str]) -> tuple[str, list[tuple[Sequence[float], tuple[float, float]]]] | None:
    """The view that shows most of a feature's outline; one already holding its callout, then plan order, win ties."""
    best, best_score = None, -math.inf
    for rank, plan in enumerate(plans):
        view = views[plan.id]
        total = sum(len(candidate_points(face, view)) for face in own)
        points = visible_points(own, view)
        if not points or total == 0:
            continue
        fraction = len(points) / total
        score = fraction + (0.3 if plan.id in holding else 0.0) - 0.01 * rank
        if fraction < MIN_VISIBLE_FRACTION:
            score -= 1.0
        if score > best_score:
            best, best_score = (plan.id, points), score
    return best


def _anchor(points: Sequence[tuple[Sequence[float], tuple[float, float]]], view: ViewData) -> tuple[float, float]:
    """Of the visible outline points, one near the view's edge and near the middle of the feature."""
    box = view.bounds()

    def edge(p: tuple[float, float]) -> float:
        return min(p[0] - box.x0, box.x1 - p[0], p[1] - box.y0, box.y1 - p[1])

    sheet_points = [s for _, s in points]
    nearest = min(edge(p) for p in sheet_points)
    outer = [p for p in sheet_points if edge(p) <= nearest + 0.6]
    mx = sum(p[0] for p in sheet_points) / len(sheet_points)
    my = sum(p[1] for p in sheet_points) / len(sheet_points)
    return min(outer, key=lambda p: (round(math.hypot(p[0] - mx, p[1] - my), 3), round(p[1], 3), round(p[0], 3)))


def _datum_reference(axis: str, frame: DatumFrame, binding: Mapping[str, ResolvedFeature],
                     faces: Mapping[int, Face], view: ViewData) -> tuple[float, float] | None:
    """A visible sheet point of the datum feature the frame's ``axis`` coordinates are measured from."""
    vector = frame.vector(axis)
    for datum in sorted(frame.datums.values(), key=lambda d: d.label):
        if datum.role == "plane" and datum.direction is not None and fg.parallel(datum.direction, vector):
            anchors = visible_anchors([faces[i] for i in binding[datum.feature].faces], view)
            if anchors:
                return anchors[0]
    for datum in sorted(frame.datums.values(), key=lambda d: d.label):
        if datum.role in ("axis", "center_plane") and datum.direction is not None and fg.perpendicular(datum.direction, vector):
            return view.project(datum.point)
    return view.project(frame.origin) if any(fg.parallel(vector, d.direction) for d in frame.datums.values()
                                            if d.direction is not None) else None


def dimension_key(char: Characteristic) -> tuple[Any, ...] | None:
    """What a location dimension states: the plane a hole centre's distance starts at (None: the datum), its frame
    axis, coordinate and control; None for other operations."""
    if char.details.get("axis_dimension"):
        start = char.details["datum_feature"]
    elif char.operation in ("location", "axis_location", "floor_location") and char.axis is not None:
        start = None
    else:
        return None
    tolerance = None if char.tolerance is None else (char.tolerance.kind, char.tolerance.lower, char.tolerance.upper)
    return (start, char.axis, round(char.value, 6), tolerance, char.reference)


def build_presentation(chars: Sequence[Characteristic], frame: DatumFrame, binding: Mapping[str, ResolvedFeature],
                       faces: Mapping[int, Face], views: Mapping[str, ViewData], regime: str,
                       geometric: Sequence[Mapping[str, Any]], intents: Mapping[str, Mapping[str, Any]]) -> Presentation:
    """Assign every characteristic to a view and an anchor; group per-feature text into callouts."""
    result = Presentation()
    plans = [v.plan for v in views.values()]
    callouts: dict[tuple[str, str], Callout] = {}

    def callout_for(feature: str, view_id: str, points: Sequence[tuple[Sequence[float], tuple[float, float]]]) -> Callout:
        key = (feature, view_id)
        if key not in callouts:
            callouts[key] = Callout(id=f"callout-{feature}-{view_id}".replace("_", "-"), view=view_id,
                                    anchor=_anchor(points, views[view_id]), lines=[],
                                    candidates=[sheet for _, sheet in points])
        return callouts[key]

    stated: dict[tuple[Any, ...], Linear] = {}   # one dimension per datum coordinate (ISO 129-1, ASME Y14.5 1.4)
    for char in chars:
        own = [faces[i] for i in char.faces]
        placed = False
        if char.presentation == GENERAL_NOTE and char.operation in ("radius", "chamfer"):
            result.placed[char.id] = {"annotation": GENERAL_NOTE_ID, "view": None, "anchor": None}
            continue
        if is_linear(char):
            same = stated.get(dimension_key(char))
            if same is not None:   # features on one centre line or plane share the dimension that locates it
                same.characteristics.append(char.id)
                result.placed[char.id] = {"annotation": same.id, "view": same.view, "anchor": list(same.target)}
                continue
            # the view that shows the dimensioned faces most: a face hidden in an earlier view whose projected
            # edge only touches another visible line goes to the view that sees it; ties keep plan order, and
            # projected views and sections keep their preferred order (presentation: section)
            best = None
            for plan in _preferred(char, plans):
                if best is not None and plan.kind != best[1].kind:
                    break
                item = _linear(char, frame, binding, faces, views[plan.id], regime)
                if item is None:
                    continue
                shown = _shown(own, views[plan.id])
                if best is None or shown > best[0] + SHOWN_MARGIN:
                    best = (shown, plan, item)
            if best is not None:
                _, plan, item = best
                result.linears.append(item)
                result.placed[char.id] = {"annotation": item.id, "view": plan.id, "anchor": list(item.target)}
                if dimension_key(char) is not None:
                    stated[dimension_key(char)] = item
                placed = True
        else:
            text = _callout_text(char, regime)
            if text is not None and char.reference:   # a reference dimension is bracketed (ISO 129-1, ASME Y14.5)
                text = f"({text})"
            choice = None if text is None else _best_view(own, _preferred(char, plans), views,
                                                          {v for (f, v) in callouts if f == char.feature})
            if choice is not None:
                plan_id, points = choice
                existing = callouts.get((char.feature, plan_id)) or callout_for(char.feature, plan_id, points)
                for line in text.split("\n"):
                    prefix = count_prefix(char.quantity, regime)
                    if existing.lines and char.quantity > 1 and line.startswith(prefix) \
                            and existing.lines[0].startswith(prefix):
                        line = line[len(prefix):]
                    existing.lines.append(line)
                existing.characteristics.append(char.id)
                result.placed[char.id] = {"annotation": existing.id, "view": plan_id, "anchor": list(existing.anchor)}
                placed = True
        if not placed and char.operation != "profile":
            result.unplaced.append({"characteristic": char.id, "feature": char.feature, "operation": char.operation,
                                    "presentation": char.presentation})
    # feature control frames join their feature's callout, or start one
    profiled = {c.feature: c.id for c in chars if c.operation == "profile"}
    for tolerance in geometric:
        if tolerance["characteristic"] == "profile_surface" and all(f in profiled for f in tolerance["features"]):
            continue   # each controlled surface's profile characteristic draws this frame
        cells = [GDT_SYMBOLS[tolerance["characteristic"]],
                 ("⌀" if tolerance.get("diameter_zone") else "") + number(tolerance["zone_mm"]),
                 *tolerance.get("datum_frame", [])]
        target = _attach(result, callouts, tolerance["features"][0], f"geometric.{tolerance['id']}", cells[0],
                         binding, faces, views, callout_for)
        if target is not None:
            target.frames.append(cells)
    for char in chars:
        if char.operation == "profile":
            cells = [GDT_SYMBOLS["profile_surface"], number(char.value), *char.details.get("datum_frame", [])]
            target = _attach(result, callouts, char.feature, char.id, cells[0], binding, faces, views, callout_for)
            if target is not None:
                target.frames.append(cells)
    for tolerance in geometric:
        key, first = f"geometric.{tolerance['id']}", profiled.get(tolerance["features"][0])
        if key not in result.placed and first in result.placed:
            result.placed[key] = result.placed[first]
    # a feature's own surface texture symbol and edge sizes, exceptions to the sheet's general indications
    for feature_id, intent in intents.items():
        if feature_id not in binding:
            continue
        if "surface_texture" in intent:
            target = _attach(result, callouts, feature_id, f"surface_texture.{feature_id}", "surface_texture",
                             binding, faces, views, callout_for)
            if target is not None:
                target.textures.append(TextureSymbol.of(intent["surface_texture"]))
        if "edges" in intent:
            target = _attach(result, callouts, feature_id, f"edges.{feature_id}", "edges", binding, faces, views,
                             callout_for)
            if target is not None:
                target.lines.extend(edge_lines(intent["edges"], regime))
    # datum features: an axis datum tags its feature's size callout, a plane datum gets its own symbol
    for datum in sorted(frame.datums.values(), key=lambda d: d.label):
        key = f"datum.{datum.label}"
        sized = next((c for (f, _), c in callouts.items() if f == datum.feature and c.lines), None)
        if datum.role != "plane" and sized is not None:
            sized.datum_tag = datum.label
            sized.characteristics.append(key)
            result.placed[key] = {"annotation": sized.id, "view": sized.view, "anchor": list(sized.anchor)}
            continue
        own_faces = [faces[i] for i in binding[datum.feature].faces]
        edge_on = [plan for plan in plans if plan.kind != "detail" and datum.direction is not None
                   and fg.perpendicular(datum.direction, plan.direction)]
        choice = _best_view(own_faces, edge_on, views, set())
        if choice is None:
            result.unplaced.append({"characteristic": key, "feature": datum.feature, "operation": "datum",
                                    "presentation": "edge-on"})
            continue
        plan_id, points = choice
        datum_callout = Callout(id=f"datum-{datum.label.lower()}", view=plan_id, anchor=_anchor(points, views[plan_id]),
                                lines=[], datum=datum.label, characteristics=[key],
                                candidates=[sheet for _, sheet in points])
        result.callouts.append(datum_callout)
        result.placed[key] = {"annotation": datum_callout.id, "view": plan_id, "anchor": list(datum_callout.anchor)}
    result.callouts.extend(c for c in callouts.values() if c.lines or c.frames or c.textures)
    return result


def _attach(result: Presentation, callouts: Mapping[tuple[str, str], Callout], feature: str, key: str, operation: str,
            binding: Mapping[str, ResolvedFeature], faces: Mapping[int, Face], views: Mapping[str, ViewData],
            factory: Any) -> Callout | None:
    """The feature's first callout, or a new one where the feature shows, now carrying ``key``; None if unplaced."""
    target = next((c for (f, _), c in callouts.items() if f == feature), None)
    if target is None:
        target = _new_callout(feature, binding, faces, views, factory)
    if target is None:
        result.unplaced.append({"characteristic": key, "feature": feature, "operation": operation, "presentation": "auto"})
        return None
    target.characteristics.append(key)
    result.placed[key] = {"annotation": target.id, "view": target.view, "anchor": list(target.anchor)}
    return target


def _new_callout(feature: str, binding: Mapping[str, ResolvedFeature], faces: Mapping[int, Face],
                 views: Mapping[str, ViewData], factory: Any) -> Callout | None:
    for view_id, view in views.items():
        points = visible_points([faces[i] for i in binding[feature].faces], view)
        if points:
            return factory(feature, view_id, points)
    return None


def _callout_text(char: Characteristic, regime: str) -> str | None:
    asme = regime == "asme"
    op = char.operation
    if op == "diameter":
        text = size_text(char, regime, "S⌀" if char.details.get("spherical") else "⌀")
        if char.details.get("groove_root"):
            text = ("GROOVE " if asme else "groove ") + text
        return text
    if op == "radius":
        return size_text(char, regime, "SR" if char.details.get("spherical") else "R")
    if op == "chamfer":
        nominal, suffix = tolerance_text(char.tolerance, char.value, regime)
        return (f"{count_prefix(char.quantity, regime)}{nominal}{suffix} {times(regime)} "
                f"{number(char.details.get('angle_deg', 45.0), 1)}°")
    if op == "depth":
        nominal, suffix = tolerance_text(char.tolerance, char.value, regime)
        return f"↧{nominal}{suffix}" if asme else f"depth {nominal}{suffix}"
    if op in ("width", "length"):
        nominal, suffix = tolerance_text(char.tolerance, char.value, regime)
        count = count_prefix(char.quantity, regime)
        word = op.upper() if asme else op
        return f"{count}{word} {nominal}{suffix}"
    if op == "across_flats":
        sides = char.details.get("sides", 6)
        name = {6: "hexagonal socket", 4: "square socket"}.get(sides, f"{sides}-sided socket")
        nominal, suffix = tolerance_text(char.tolerance, char.value, regime)
        return f"{name.upper()} {nominal}{suffix} A/F" if asme else f"{name} across flats {nominal}{suffix}"
    if op == "angle":
        nominal, suffix = tolerance_text(char.tolerance, char.value, regime)
        count = count_prefix(char.quantity, regime)
        return f"{count}{nominal}°{suffix.replace(' ±', ' ±') + ('°' if suffix else '')}"
    if op == "pattern" and char.details.get("grid"):   # nodes of a regular grid inside a circle about one hole
        details = char.details
        nominal, suffix = tolerance_text(char.tolerance, char.value, regime)
        second = "" if abs(details["second_pitch"] - char.value) < 1e-6 else f" × {number(details['second_pitch'])}"
        first_angle = details["first_angle_deg"]
        directions = (f"{number(first_angle, 2)}° {'AND' if asme else 'and'} "
                      f"{number(first_angle + details['angle_deg'], 2)}°")
        if asme:
            return (f"{count_prefix(char.quantity, regime)}GRID PITCH {nominal}{suffix}{second} AT {directions} TO "
                    f"{details['from_axis'].upper()}\nCENTERS WITHIN ⌀{number(details['within_diameter'])} OF LOCATED HOLE")
        return (f"{count_prefix(char.quantity, regime)}grid pitch {nominal}{suffix}{second} at {directions} to "
                f"{details['from_axis']}\ncentres within ⌀{number(details['within_diameter'])} of the located hole")
    if op == "pattern":
        details = char.details
        angles = details["angles_deg"]
        reference = details.get("reference") or details["from_axis"]
        if details.get("equal_spacing"):
            step = 360.0 / len(angles)
            spacing = (f"{'EQSP' if asme else 'EQS'}, first {number(angles[0], 2)}° from {reference}"
                       + (f", {number(step, 2)}° apart" if len(angles) > 2 else ""))
        else:
            spacing = "at " + ", ".join(f"{number(a, 2)}°" for a in angles) + f" from {reference}"
        return f"{count_prefix(char.quantity, regime)}on ⌀{number(char.value)} {'BC' if asme else 'PCD'}\n{spacing}"
    if op == "thread":
        details = char.details
        depth = details.get("full_depth")
        text = details["designation"]
        if depth is not None:
            text += f" ↧{number(depth)}" if asme else f", full thread depth {number(depth)}"
        return text
    if op == "profile":
        return None   # the profile tolerance prints as a feature control frame
    if op == "extent":
        size = char.details["size"]
        return f"engraving {number(size[0])} {times(regime)} {number(size[1])}"
    return None


def _linear(char: Characteristic, frame: DatumFrame, binding: Mapping[str, ResolvedFeature],
            faces: Mapping[int, Face], view: ViewData, regime: str) -> Linear | None:
    """A baseline dimension from the datum to a plane or axis, when this view shows both edge-on."""
    if char.details.get("at"):
        return _at_linear(char, binding, faces, view, regime)
    if char.axis is None:
        return None
    vector = frame.vector(char.axis)
    plan = view.plan
    if not fg.perpendicular(vector, plan.direction):
        return None
    horizontal = fg.parallel(vector, plan.x_direction)
    if not horizontal and not fg.parallel(vector, plan.up):
        return None
    origin = _datum_reference(char.axis, frame, binding, faces, view)
    if char.operation in ("plane_separation", "thickness", "distance") and len(char.details.get("features", ())) == 2:
        # between two features: from the first one's plane, or a hole centre's plane, not the datum
        start_faces = char.details.get("from_faces") or \
            binding[char.details.get("datum_feature", char.details["features"][0])].faces
        start = visible_anchors([faces[i] for i in start_faces], view)
        origin = start[0] if start else None
    if origin is None:
        return None
    if char.operation == "axis_location" or char.details.get("axis_dimension"):
        point = char.details.get("axis_point")
        if point is None:
            return None
        target = view.project(point)
        own = [faces[i] for i in char.faces]
        if not visible_anchors(own, view):
            return None
    else:
        anchors = visible_anchors([faces[i] for i in char.faces], view)
        if not anchors:
            return None
        target = min(anchors, key=lambda p: (p[1], p[0])) if horizontal else max(anchors, key=lambda p: (p[0], -p[1]))
    nominal, suffix = tolerance_text(char.tolerance, abs(char.value), regime)
    boxed = char.tolerance is not None and char.tolerance.kind == "basic"
    text = f"({nominal})" if char.reference else nominal + suffix
    return Linear(id=f"dim-{char.id}".replace(".", "-").replace("_", "-"), view=plan.id, origin=origin, target=target,
                  horizontal=horizontal, text=text, boxed=boxed, reference=char.reference,
                  characteristics=[char.id])


CORNER_MIN_MM = 0.3   # a foot this far from both faces' outlines stands on a theoretical sharp corner


def _at_linear(char: Characteristic, binding: Mapping[str, ResolvedFeature], faces: Mapping[int, Face],
               view: ViewData, regime: str) -> Linear | None:
    """A width or wall thickness stated at a reference plane, between the lines where its two planes meet that
    plane, in a view that sees those lines end-on and both planes' outlines. A foot on a theoretical sharp
    corner (the edge chamfered or rounded away) gets thin lines extending both outlines to it (ISO 129-1)."""
    trace, plan = char.details["trace"], view.plan
    if not fg.parallel(trace["along"], plan.direction):
        return None
    horizontal = fg.parallel(trace["across"], plan.x_direction)
    if not horizontal and not fg.parallel(trace["across"], plan.up):
        return None
    first, second = char.details["pairs"][0]
    if not all(visible_anchors([faces[i]], view) for i in (first, second)):
        return None
    reference = [faces[i] for i in binding[char.details["at"]].faces]
    feet, construction = [], []
    for point, side in ((trace["first"], first), (trace["second"], second)):
        foot = view.project(point)
        feet.append(foot)
        for outline in ([faces[side]], reference):
            ends = [view.project(p) for face in outline for p in face.boundary_points()]
            nearest = min(ends, key=lambda p: math.hypot(p[0] - foot[0], p[1] - foot[1]), default=foot)
            if math.hypot(nearest[0] - foot[0], nearest[1] - foot[1]) > CORNER_MIN_MM:
                construction.append((nearest, foot))
    # on the side of the view the feet are nearer: a reference plane on the left or bottom edge of the view (a
    # rim, a bed) keeps its extension lines outside the view
    box = view.bounds()
    if horizontal:
        side = -1 if sum(y for _, y in feet) / 2 > (box.y0 + box.y1) / 2 else 1
    else:
        side = -1 if sum(x for x, _ in feet) / 2 < (box.x0 + box.x1) / 2 else 1
    nominal, suffix = tolerance_text(char.tolerance, abs(char.value), regime)
    text = count_prefix(char.quantity, regime) + (f"({nominal})" if char.reference else nominal + suffix)
    return Linear(id=f"dim-{char.id}".replace(".", "-").replace("_", "-"), view=plan.id, origin=feet[0],
                  target=feet[1], horizontal=horizontal, text=text,
                  boxed=char.tolerance is not None and char.tolerance.kind == "basic", reference=char.reference,
                  characteristics=[char.id], construction=construction, side=side)


# --- layout ------------------------------------------------------------------------------------------

@dataclass
class ViewLayout:
    footprint: Box                  # view plus everything placed around it
    annotations: list[SvgAnnotation]
    notes: list[str] = field(default_factory=list)
    section: SectionFill | None = None      # section views: each cut face's fill, for the section_hatch gate


def _text(content: str, x: float, y: float, size: float, anchor: str = "start", rotate: float | None = None) -> str:
    transform = f' transform="rotate({rotate:.3f} {x:.3f} {y:.3f})"' if rotate is not None else ""
    anchor_attr = f' text-anchor="{anchor}"' if anchor != "start" else ""
    return (f'<text x="{x:.3f}" y="{y:.3f}" font-size="{size:g}" font-family="osifont" fill="#000" '
            f'stroke="none"{anchor_attr}{transform}>{escape(content)}</text>')


def _line(x1: float, y1: float, x2: float, y2: float, width: float = THIN, dash: str | None = None) -> str:
    dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x1:.3f}" y1="{y1:.3f}" x2="{x2:.3f}" y2="{y2:.3f}" stroke="#000" '
            f'stroke-width="{width:g}"{dash_attr}/>')


def _arrow(tip: tuple[float, float], toward: tuple[float, float]) -> str:
    dx, dy = toward[0] - tip[0], toward[1] - tip[1]
    length = math.hypot(dx, dy) or 1.0
    ux, uy = dx / length, dy / length
    bx, by = tip[0] + ux * ARROW_LENGTH, tip[1] + uy * ARROW_LENGTH
    points = [tip, (bx - uy * ARROW_HALF_WIDTH, by + ux * ARROW_HALF_WIDTH), (bx + uy * ARROW_HALF_WIDTH, by - ux * ARROW_HALF_WIDTH)]
    return f'<polygon points="{" ".join(f"{x:.3f},{y:.3f}" for x, y in points)}" fill="#000" stroke="none"/>'


def _rect(x0: float, y0: float, x1: float, y1: float, width: float = THIN) -> str:
    return (f'<rect x="{x0:.3f}" y="{y0:.3f}" width="{x1 - x0:.3f}" height="{y1 - y0:.3f}" fill="none" stroke="#000" '
            f'stroke-width="{width:g}"/>')


def _frame_width(cells: Sequence[str], size: float) -> float:
    return sum(text_width(cell, size) + 2.0 for cell in cells)


def _block_size(callout: Callout, size: float) -> tuple[float, float]:
    pitch = size * LINE_PITCH_FACTOR
    if callout.datum:
        return size + 2.4, size + 2.4
    if callout.datum_tag:
        width, height = _block_size(replace(callout, datum_tag=None), size)
        return max(width, size + 2.4), height + size + 4.0
    textures = [symbol.size(size) for symbol in callout.textures]
    width = max([text_width(line, size) for line in callout.lines] + [_frame_width(f, size) for f in callout.frames]
                + [w for w, _ in textures] + [0])
    return width, (pitch * len(callout.lines) + (size + 2.0) * len(callout.frames)
                   + sum(h + TEXTURE_GAP for _, h in textures))


def layout_view(view: ViewData, presentation: Presentation, size: float, regime: str,
                 children: Sequence[ViewPlan] = ()) -> ViewLayout:
    """Place this view's dimensions, callouts and child-view marks around it; return the markup and occupied box.

    ``children`` are the section, detail and lettered views based on this view: their cutting-plane lines,
    detail circles and reference arrows are drawn here, and callout columns keep clear of their letters.
    """
    box = view.bounds()
    annotations: list[SvgAnnotation] = []
    footprint = box
    pitch = size * LINE_PITCH_FACTOR
    marks: list[Box] = []
    for child in children:
        markup, boxes = (section_marks(view, child, size, regime) if child.kind == "section"
                         else detail_marks(view, child, size) if child.kind == "detail"
                         else view_marks(view, child, size))
        annotations.append(markup)
        marks.extend(boxes)
        for mark in boxes:
            footprint = footprint.union(mark)
    # parallel dimensions: horizontal ones stack above the view, vertical ones to its right, both beyond the
    # cutting-plane and detail letters on that side, so no dimension text lands on a letter; a dimension stated
    # at a reference plane on the view's left or bottom edge (``Linear.side``) stacks on that side instead, so
    # its extension lines never run through the view
    above = min([box.y0] + [m.y0 for m in marks if m.y1 < box.y0 + 1.0])
    below = max([box.y1] + [m.y1 for m in marks if m.y0 > box.y1 - 1.0])
    right_edge = max([box.x1] + [m.x1 for m in marks if m.x0 > box.x1 - 1.0])
    left_edge = min([box.x0] + [m.x0 for m in marks if m.x1 < box.x0 + 1.0])
    mine_linear = [d for d in presentation.linears if d.view == view.plan.id]
    for side in (1, -1):
        rows = sorted((d for d in mine_linear if d.horizontal and d.side == side),
                      key=lambda d: abs(d.target[0] - d.origin[0]))
        for number_, dim in enumerate(rows):
            y = above - FIRST_ROW - number_ * ROW_PITCH if side > 0 else below + FIRST_ROW + number_ * ROW_PITCH
            annotations.append(_dimension_markup(dim, y, size, regime))
            # the text above the line; a row below the view also reaches the extension lines' overshoot
            footprint = footprint.union(Box(min(dim.origin[0], dim.target[0]) - text_width(dim.text, size),
                                            y - size - 1.5, max(dim.origin[0], dim.target[0]) + text_width(dim.text, size),
                                            y + (EXT_OVERSHOOT if side < 0 else 0.0)))
    x = right_edge + FIRST_ROW
    for dim in sorted((d for d in mine_linear if not d.horizontal and d.side > 0),
                      key=lambda d: abs(d.target[1] - d.origin[1])):
        annotations.append(_dimension_markup(dim, x, size, regime))
        # ISO 129-1 aligns the text with the line; ASME Y14.5 reads it horizontally, right of the line
        right_edge = x + (size + 1.5 if regime == "iso" else 1.0 + text_width(dim.text, size))
        footprint = footprint.union(Box(x - 1.0, min(dim.origin[1], dim.target[1]) - text_width(dim.text, size),
                                        right_edge, max(dim.origin[1], dim.target[1]) + text_width(dim.text, size)))
        x = max(x + ROW_PITCH, right_edge + 2.0)
    x, left_dims = left_edge - FIRST_ROW, box.x0
    for dim in sorted((d for d in mine_linear if not d.horizontal and d.side < 0),
                      key=lambda d: abs(d.target[1] - d.origin[1])):
        annotations.append(_dimension_markup(dim, x, size, regime))
        # the text left of the line in both regimes, away from the view
        left_dims = x - (size + 1.5 if regime == "iso" else 1.0 + text_width(dim.text, size))
        footprint = footprint.union(Box(left_dims, min(dim.origin[1], dim.target[1]) - text_width(dim.text, size),
                                        x + 1.0, max(dim.origin[1], dim.target[1]) + text_width(dim.text, size)))
        x = min(x - ROW_PITCH, left_dims - 2.0)
    label = _view_label(view, size, regime)
    # callout columns, left and right of the view
    mine = [c for c in presentation.callouts if c.view == view.plan.id]
    middle = (box.x0 + box.x1) / 2
    for side in (-1, 1):
        column = [c for c in mine if (c.anchor[0] > middle + 0.5) == (side > 0)]
        if not column:
            continue
        edge = (left_dims - COLUMN_GAP) if side < 0 else (right_edge + COLUMN_GAP)
        reserved = [(m.y0, m.y1) for m in marks if (m.x1 < box.x0 + 1.0) == (side < 0) and
                    (m.x1 < box.x0 + 1.0 or m.x0 > box.x1 - 1.0)]
        if label is not None and (label[1].x0 < edge if side < 0 else label[1].x1 > edge):
            reserved.append((label[1].y0, label[1].y1))   # a label wider than the view reaches over this column
        for callout in column:
            callout.side = side
            callout.anchor = _side_anchor(callout, side, box)
        column.sort(key=lambda c: (round(c.anchor[1], 3), side * c.anchor[0]))
        tops = _stack(column, size, box, reserved)
        for _ in range(len(column) * len(column)):
            swapped = False
            for i in range(len(column) - 1):
                if _leaders_cross(column[i], tops[i], column[i + 1], tops[i + 1], edge, side, pitch):
                    column[i], column[i + 1] = column[i + 1], column[i]
                    tops = _stack(column, size, box, reserved)
                    swapped = True
            if not swapped:
                break
        for callout, (top, bottom) in zip(column, tops):
            w, _ = _block_size(callout, size)
            annotations.append(_callout_markup(callout, edge, top, w, size, pitch))
            x0, x1 = (edge - w - LANDING, edge) if side < 0 else (edge, edge + w + LANDING)
            footprint = footprint.union(Box(min(x0, edge - 2 * LANDING), top - 0.5, max(x1, edge + 2 * LANDING),
                                            bottom + 0.5))
    section = (fill_section(view.plan.id, view.cut_regions, view.project, view.geometry.scale)
               if view.plan.kind == "section" else None)
    annotations.extend(_view_furniture(view, section))
    if label is not None:
        annotations.append(label[0])
        footprint = footprint.union(label[1])
    return ViewLayout(footprint, annotations, section=section)


def _side_anchor(callout: Callout, side: int, box: Box) -> tuple[float, float]:
    """The feature's visible point nearest the callout's column, so the leader enters the view from its side."""
    candidates = [p for p in callout.candidates if (p[0] > (box.x0 + box.x1) / 2 + 0.5) == (side > 0)] \
        or list(callout.candidates) or [callout.anchor]
    reach = (lambda p: p[0] - box.x0) if side < 0 else (lambda p: box.x1 - p[0])
    nearest = min(reach(p) for p in candidates)
    close = [p for p in candidates if reach(p) <= nearest + 0.6]
    return min(close, key=lambda p: (round(abs(p[1] - callout.anchor[1]), 3), round(p[1], 3)))


def _stack(column: Sequence[Callout], size: float, box: Box,
           reserved: Sequence[tuple[float, float]] = ()) -> list[tuple[float, float]]:
    """Block tops and bottoms in column order: each as near its anchor's height as the blocks above allow,
    and clear of the reserved heights (cutting-plane and detail letters on that side)."""
    sizes = [_block_size(c, size)[1] for c in column]
    total = sum(sizes) + BLOCK_GAP * (len(column) - 1)

    def clear(top: float, height: float) -> float:
        moved = True
        while moved:
            moved = False
            for low, high in reserved:
                if top < high + BLOCK_GAP and top + height > low - BLOCK_GAP:
                    top, moved = high + BLOCK_GAP, True
        return top

    tops: list[tuple[float, float]] = []
    for callout, height in zip(column, sizes):
        wanted = callout.anchor[1] - height / 2
        top = wanted if not tops else max(tops[-1][1] + BLOCK_GAP, wanted)
        tops.append((top, top + height))
    overflow = tops[-1][1] - max(box.y1, (box.y0 + box.y1) / 2 + total / 2)
    if overflow > 0:  # pull a column that runs far below the view back up
        tops = [(a - overflow, b - overflow) for a, b in tops]
    if reserved:
        placed: list[tuple[float, float]] = []
        for (top, bottom) in tops:
            height = bottom - top
            top = clear(top if not placed else max(top, placed[-1][1] + BLOCK_GAP), height)
            placed.append((top, top + height))
        tops = placed
    return tops


def _leaders_cross(a: Callout, a_top: tuple[float, float], b: Callout, b_top: tuple[float, float], edge: float,
                   side: int, pitch: float) -> bool:
    ax = edge + LANDING if side < 0 else edge - LANDING
    p1, p2 = (ax, a_top[0] + pitch / 2), a.anchor
    q1, q2 = (ax, b_top[0] + pitch / 2), b.anchor

    def orient(p: tuple[float, float], q: tuple[float, float], r: tuple[float, float]) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1, d2 = orient(q1, q2, p1), orient(q1, q2, p2)
    d3, d4 = orient(p1, p2, q1), orient(p1, p2, q2)
    return d1 * d2 < 0 and d3 * d4 < 0


def _dimension_markup(dim: Linear, at: float, size: float, regime: str) -> SvgAnnotation:
    parts = []
    (ox, oy), (tx, ty) = dim.origin, dim.target
    extension = []
    if dim.horizontal:
        for x, y in ((ox, oy), (tx, ty)):
            extension.append(_line(x, y - EXT_GAP if y > at else y + EXT_GAP, x, at - dim.side * EXT_OVERSHOOT))
        x0, x1 = sorted((ox, tx))
        parts.append(_line(x0, at, x1, at))
        parts.append(_arrow((ox, at), (tx, at)))
        parts.append(_arrow((tx, at), (ox, at)))
        width = text_width(dim.text, size)
        mid = (ox + tx) / 2
        if width + 2 * ARROW_LENGTH > abs(tx - ox):
            mid = x1 + 1.5 + width / 2 if tx >= ox else x0 - 1.5 - width / 2
            parts.append(_line(x1, at, x1 + 1.5 + width, at) if tx >= ox else _line(x0 - 1.5 - width, at, x0, at))
        baseline = at - 1.0
        parts.append(_text(dim.text, mid, baseline, size, "middle"))
        if dim.boxed:
            parts.append(_rect(mid - width / 2 - 0.8, baseline - TEXT_ASCENT * size - 0.6, mid + width / 2 + 0.8,
                               baseline + TEXT_DESCENT * size + 0.4))
    else:
        for x, y in ((ox, oy), (tx, ty)):
            extension.append(_line(x + EXT_GAP if x < at else x - EXT_GAP, y, at + dim.side * EXT_OVERSHOOT, y))
        y0, y1 = sorted((oy, ty))
        parts.append(_line(at, y0, at, y1))
        parts.append(_arrow((at, oy), (at, ty)))
        parts.append(_arrow((at, ty), (at, oy)))
        width = text_width(dim.text, size)
        along = width if regime == "iso" else (TEXT_ASCENT + TEXT_DESCENT) * size   # the text's extent along the line
        mid = (oy + ty) / 2
        if along + 2 * ARROW_LENGTH > abs(ty - oy):
            mid = y0 - 1.5 - along / 2
            parts.append(_line(at, y0 - 1.5 - along, at, y0))
        if regime == "iso":
            parts.append(_text(dim.text, at - 1.0, mid, size, "middle", rotate=-90.0))
            if dim.boxed:
                h = TEXT_ASCENT * size
                parts.append(_rect(at - 1.0 - h - 0.6, mid - width / 2 - 0.8, at - 1.0 + TEXT_DESCENT * size + 0.4,
                                   mid + width / 2 + 0.8))
        elif dim.side > 0:
            parts.append(_text(dim.text, at + 1.0, mid + (TEXT_ASCENT - TEXT_DESCENT) * size / 2, size))
            if dim.boxed:
                parts.append(_rect(at + 0.4, mid - TEXT_ASCENT * size / 2 - 1.0, at + 1.6 + width,
                                   mid + TEXT_ASCENT * size / 2 + 1.0))
        else:   # a column left of the view reads leftward, away from it
            parts.append(_text(dim.text, at - 1.0, mid + (TEXT_ASCENT - TEXT_DESCENT) * size / 2, size, "end"))
            if dim.boxed:
                parts.append(_rect(at - 1.6 - width, mid - TEXT_ASCENT * size / 2 - 1.0, at - 0.4,
                                   mid + TEXT_ASCENT * size / 2 + 1.0))
    for (sx, sy), (fx, fy) in dim.construction:   # the outlines extended, crossing just past the sharp corner
        length = math.hypot(fx - sx, fy - sy)
        past = EXT_OVERSHOOT / length
        extension.append(_line(sx, sy, fx + (fx - sx) * past, fy + (fy - sy) * past))
    markup = "".join(parts) + f'<g class="extension">{"".join(extension)}</g>'
    return SvgAnnotation(id=dim.id, kind="dimension", markup=markup,
                         provenance={"characteristics": ",".join(dim.characteristics)})


def _callout_markup(callout: Callout, edge: float, top: float, width: float, size: float, pitch: float) -> SvgAnnotation:
    side = callout.side
    parts, leader = [], []
    ax, ay = callout.anchor
    if callout.datum:
        box_size = size + 2.4
        x0 = edge - box_size if side < 0 else edge
        parts.append(_rect(x0, top, x0 + box_size, top + box_size, 0.35))
        parts.append(_text(callout.datum, x0 + box_size / 2, top + box_size / 2 + (TEXT_ASCENT - TEXT_DESCENT) * size / 2,
                           size, "middle"))
        foot = (edge if side < 0 else edge, top + box_size / 2)
        leader.append(_line(foot[0], foot[1], ax, ay))
        dx, dy = foot[0] - ax, foot[1] - ay
        length = math.hypot(dx, dy) or 1.0
        ux, uy = dx / length, dy / length
        tri = [(ax - uy * 1.6, ay + ux * 1.6), (ax + uy * 1.6, ay - ux * 1.6), (ax + ux * 2.8, ay + uy * 2.8)]
        leader.append(f'<polygon points="{" ".join(f"{x:.3f},{y:.3f}" for x, y in tri)}" fill="#000" stroke="none"/>')
        markup = f'<g class="datum-label">{"".join(parts)}</g><g class="leader-line">{"".join(leader)}</g>'
        return SvgAnnotation(id=callout.id, kind="datum", markup=markup,
                             provenance={"characteristics": ",".join(callout.characteristics)})
    x_text = edge if side < 0 else edge
    anchor = "end" if side < 0 else "start"
    y = top
    for line in callout.lines:
        y += pitch
        parts.append(_text(line, x_text, y - (pitch - size * TEXT_ASCENT) / 2 - 0.2, size, anchor))
    frames = []
    for cells in callout.frames:
        height = size + 2.0
        total = _frame_width(cells, size)
        x0 = edge - total if side < 0 else edge
        x = x0
        for cell in cells:
            w = text_width(cell, size) + 2.0
            frames.append(_rect(x, y + 0.5, x + w, y + 0.5 + height))
            frames.append(_text(cell, x + w / 2, y + 0.5 + height / 2 + (TEXT_ASCENT - TEXT_DESCENT) * size / 2, size,
                                "middle"))
            x += w
        y += height
    textures = []
    for symbol in callout.textures:
        w, h = symbol.size(size)
        textures.append(symbol.markup(edge - w if side < 0 else edge, y + TEXTURE_GAP, size))
        y += h + TEXTURE_GAP
    first_line_y = top + pitch / 2 if callout.lines else top + (size + 2.0) / 2
    landing_end = edge + LANDING if side < 0 else edge - LANDING
    landing_x = edge + 0.8 if side < 0 else edge - 0.8
    leader.append(_line(landing_x, first_line_y, landing_end, first_line_y))
    leader.append(_line(landing_end, first_line_y, ax, ay))
    leader.append(_arrow((ax, ay), (landing_end, first_line_y)))
    datum = []
    if callout.datum_tag:
        # ISO 5459 / ASME Y14.5 datum feature symbol on the size callout's leader: triangle, line, letter box
        box_size = size + 2.4
        apex_y = first_line_y + 2.8
        datum.append(f'<polygon points="{landing_end - 1.6:.3f},{first_line_y:.3f} {landing_end + 1.6:.3f},'
                     f'{first_line_y:.3f} {landing_end:.3f},{apex_y:.3f}" fill="#000" stroke="none"/>')
        box_top = max(y + 1.0, apex_y + 1.0)
        datum.append(_line(landing_end, apex_y, landing_end, box_top))
        datum.append(_rect(landing_end - box_size / 2, box_top, landing_end + box_size / 2, box_top + box_size, 0.35))
        datum.append(_text(callout.datum_tag, landing_end, box_top + box_size / 2 + (TEXT_ASCENT - TEXT_DESCENT) * size / 2,
                           size, "middle"))
    markup = "".join(parts)
    if frames:
        markup += f'<g class="fcf">{"".join(frames)}</g>'
    if textures:
        markup += f'<g class="texture">{"".join(textures)}</g>'
    if datum:
        markup += f'<g class="datum-label">{"".join(datum)}</g>'
    markup += f'<g class="leader-line">{"".join(leader)}</g>'
    return SvgAnnotation(id=callout.id, kind="leader", markup=markup,
                         provenance={"characteristics": ",".join(callout.characteristics)})


def _view_label(view: ViewData, size: float, regime: str) -> tuple[SvgAnnotation, Box] | None:
    plan = view.plan
    if plan.label is None:
        return None
    if plan.kind == "section":
        text = f"{plan.label}-{plan.label}" if regime == "iso" else f"SECTION {plan.label}-{plan.label}"
        if plan.scale != "auto":   # a section at its own scale states it
            text += f" ({plan.scale})" if regime == "iso" else f" SCALE {plan.scale}"
    elif plan.kind == "detail":
        scale = view.geometry.scale
        ratio = f"{number(scale, 4)}:1" if scale >= 1 else f"1:{number(1 / scale, 4)}"
        text = f"{plan.label} ({ratio})" if regime == "iso" else f"DETAIL {plan.label} SCALE {ratio}"
    else:
        text = f"{plan.label}" if regime == "iso" else f"VIEW {plan.label}"
    box = view.bounds()
    x = (box.x0 + box.x1) / 2
    y = box.y0 - LABEL_GAP
    markup = _text(text, x, y, size + 1.5 if size < 5 else size, "middle")
    width = text_width(text, size + 1.5)
    return (SvgAnnotation(id=f"label-{plan.id}".replace("_", "-"), kind="label", markup=markup),
            Box(x - width / 2, y - (size + 1.5) * TEXT_ASCENT, x + width / 2, y + 1.0))


def _view_furniture(view: ViewData, section: SectionFill | None) -> list[SvgAnnotation]:
    """The section fill of each cut face and the detail boundary circle of the view itself."""
    plan = view.plan
    items = [SvgAnnotation(id=f"hatch-{plan.id}-{fill.face}".replace("_", "-"), kind="hatch", markup=fill_markup(fill))
             for fill in (section.fills if section is not None else ()) if fill.mode == "solid" or fill.lines]
    if plan.kind == "detail" and view.clip_radius:
        cx, cy = view.geometry.centre_mm
        items.append(SvgAnnotation(id=f"detail-boundary-{plan.id}".replace("_", "-"), kind="detail-boundary",
                                   markup=f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{view.clip_radius:.3f}" fill="none" '
                                          f'stroke="#000" stroke-width="{THIN}"/>'))
    return items


def centre_lines(view: ViewData, binding: Mapping[str, ResolvedFeature], faces: Mapping[int, Face]) -> SvgAnnotation | None:
    """One centre line per cylinder axis seen side-on and a centre mark per axis seen end-on."""
    parts = []
    marks: dict[tuple[float, float], float] = {}
    lines: list[list[Any]] = []   # [model point, unit direction, t min, t max]
    direction = view.plan.direction
    for feature in binding.values():
        if feature.kind not in ("bore", "shaft", "groove", "slot"):
            continue
        for inst in cylinder_instances([faces[i] for i in feature.faces]):
            if (faces[inst.faces[0]].span_deg or 360.0) < 179.0:
                continue
            if fg.parallel(inst.axis_dir, direction):
                cx, cy = view.project(inst.axis_point)
                key = (round(cx, 2), round(cy, 2))
                marks[key] = max(marks.get(key, 0.0), inst.radius * view.geometry.scale + 2.0)
            elif fg.perpendicular(inst.axis_dir, direction):
                for line in lines:
                    if fg.parallel(line[1], inst.axis_dir) and fg.axis_distance(inst.axis_point, line[0], line[1]) < 1e-4:
                        shift = fg.dot(fg.sub(inst.axis_point, line[0]), line[1])
                        sense = 1.0 if fg.dot(inst.axis_dir, line[1]) > 0 else -1.0
                        ends = sorted((shift + sense * inst.t0, shift + sense * inst.t1))
                        line[2], line[3] = min(line[2], ends[0]), max(line[3], ends[1])
                        break
                else:
                    lines.append([inst.axis_point, inst.axis_dir, inst.t0, inst.t1])
    for (cx, cy), r in marks.items():
        for a, b in (((cx - r, cy), (cx + r, cy)), ((cx, cy - r), (cx, cy + r))):
            clipped = _clip(view, a, b)
            if clipped:
                parts.append(_line(*clipped[0], *clipped[1], THIN, CHAIN_DASH))
    for point, axis, t0, t1 in lines:
        a = view.project(fg.add(point, fg.scale(axis, t0)))
        b = view.project(fg.add(point, fg.scale(axis, t1)))
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        if length < 1e-6:
            continue
        ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
        clipped = _clip(view, (a[0] - 2.0 * ux, a[1] - 2.0 * uy), (b[0] + 2.0 * ux, b[1] + 2.0 * uy))
        if clipped:
            parts.append(_line(*clipped[0], *clipped[1], THIN, CHAIN_DASH))
    if not parts:
        return None
    return SvgAnnotation(id=f"centerlines-{view.plan.id}".replace("_", "-"), kind="centerline", markup="".join(parts))


def _clip(view: ViewData, a: tuple[float, float], b: tuple[float, float]
          ) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """The part of segment a-b inside a detail view's boundary circle; the whole segment elsewhere."""
    if view.clip_radius is None:
        return a, b
    cx, cy = view.geometry.centre_mm
    dx, dy = b[0] - a[0], b[1] - a[1]
    fx, fy = a[0] - cx, a[1] - cy
    qa, qb, qc = dx * dx + dy * dy, 2 * (fx * dx + fy * dy), fx * fx + fy * fy - view.clip_radius ** 2
    disc = qb * qb - 4 * qa * qc
    if qa == 0 or disc <= 0:
        return None
    t0, t1 = (-qb - math.sqrt(disc)) / (2 * qa), (-qb + math.sqrt(disc)) / (2 * qa)
    t0, t1 = max(t0, 0.0), min(t1, 1.0)
    if t0 >= t1:
        return None
    return (a[0] + t0 * dx, a[1] + t0 * dy), (a[0] + t1 * dx, a[1] + t1 * dy)


def section_marks(base: ViewData, plan: ViewPlan, size: float, regime: str) -> tuple[SvgAnnotation, list[Box]]:
    """The cutting-plane line on the base view, arrows in the viewing direction, letters; and the letters' boxes."""
    origin, normal = plan.section["origin"], plan.section["normal"]
    along = fg.unit(fg.cross(base.plan.direction, normal))
    box = base.bounds()
    centre = base.project(origin)
    a = base.project(fg.add(origin, along))
    ux, uy = a[0] - centre[0], a[1] - centre[1]
    length = math.hypot(ux, uy) or 1.0
    ux, uy = ux / length, uy / length
    reach = math.hypot(box.x1 - box.x0, box.y1 - box.y0) + 4.0   # past both edges from any origin, then clipped

    def clip(p: tuple[float, float]) -> tuple[float, float]:  # just outside the view box
        return (min(max(p[0], box.x0 - 4.0), box.x1 + 4.0), min(max(p[1], box.y0 - 4.0), box.y1 + 4.0))

    p1 = clip((centre[0] - ux * reach, centre[1] - uy * reach))
    p2 = clip((centre[0] + ux * reach, centre[1] + uy * reach))
    look = base.project(fg.add(origin, fg.scale(normal, -1.0)))
    lx, ly = look[0] - centre[0], look[1] - centre[1]
    norm_ = math.hypot(lx, ly) or 1.0
    lx, ly = lx / norm_, ly / norm_
    parts = [_line(p1[0], p1[1], p2[0], p2[1], THIN, CHAIN_DASH)]
    letters, boxes = [], []
    letter_size = size + 1.5
    for end, inward in ((p1, 1.0), (p2, -1.0)):
        parts.append(_line(end[0], end[1], end[0] + inward * ux * 5.0, end[1] + inward * uy * 5.0, 0.7))
        tail = (end[0] - lx * 6.0, end[1] - ly * 6.0)
        parts.append(_line(tail[0], tail[1], end[0], end[1], THIN))
        parts.append(_arrow(end, tail))
        tx, ty = tail[0] - lx * 2.0 - inward * ux * 1.0, tail[1] - ly * 2.0 - inward * uy * 1.0
        baseline = ty + (TEXT_ASCENT - TEXT_DESCENT) * letter_size / 2
        letters.append(_text(plan.label, tx, baseline, letter_size, "middle"))
        half = text_width(plan.label, letter_size) / 2
        boxes.append(Box(min(tx - half, end[0], tail[0]) - 0.5, min(baseline - TEXT_ASCENT * letter_size, end[1], tail[1]) - 0.5,
                         max(tx + half, end[0], tail[0]) + 0.5, max(baseline + TEXT_DESCENT * letter_size, end[1], tail[1]) + 0.5))
    markup = f'<g class="section-line">{"".join(parts)}</g>{"".join(letters)}'
    return SvgAnnotation(id=f"section-line-{plan.id}".replace("_", "-"), kind="section-line", markup=markup), boxes


def detail_marks(base: ViewData, plan: ViewPlan, size: float) -> tuple[SvgAnnotation, list[Box]]:
    """The detail circle on the base view with its letter; and the letter's box."""
    centre = base.project(plan.detail["centre"])
    radius = plan.detail["radius_model"] * base.geometry.scale
    parts = [f'<circle cx="{centre[0]:.3f}" cy="{centre[1]:.3f}" r="{radius:.3f}" fill="none" stroke="#000" '
             f'stroke-width="{THIN}"/>']
    box = base.bounds()
    right = centre[0] >= (box.x0 + box.x1) / 2
    lx = (box.x1 + 6.0) if right else (box.x0 - 6.0)
    ly = box.y0 - 6.0
    edge = (centre[0] + (radius if right else -radius) * math.sqrt(0.5), centre[1] - radius * math.sqrt(0.5))
    parts.append(_line(edge[0], edge[1], lx, ly + 1.0))
    letter_size = size + 1.5
    half = text_width(plan.label, letter_size) / 2
    markup = f'<g class="detail-boundary">{"".join(parts)}</g>' + _text(plan.label, lx, ly, letter_size, "middle")
    return (SvgAnnotation(id=f"detail-mark-{plan.id}".replace("_", "-"), kind="detail-boundary", markup=markup),
            [Box(lx - half - 0.5, ly - TEXT_ASCENT * letter_size - 0.5, lx + half + 0.5, ly + TEXT_DESCENT * letter_size + 0.5)])


VIEW_ARROW_GAP, VIEW_ARROW_LENGTH = 4.0, 10.0


def view_marks(base: ViewData, plan: ViewPlan, size: float) -> tuple[SvgAnnotation, list[Box]]:
    """The reference arrow of a lettered view (ISO 128-3, ASME Y14.3 view indicator) on the view that carries it:
    outside the view on the side its viewer stands, pointing at the part, the letter beyond its tail; and the
    arrow's and letter's box."""
    direction = plan.direction
    sx, sy = fg.dot(direction, base.plan.x_direction), -fg.dot(direction, base.plan.up)
    length = math.hypot(sx, sy) or 1.0
    ux, uy = sx / length, sy / length   # on the sheet, from the view toward the lettered view's viewer
    box = base.bounds()
    cx, cy = (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2
    reach = min((box.x1 - box.x0) / 2 / abs(ux) if abs(ux) > 1e-9 else math.inf,
                (box.y1 - box.y0) / 2 / abs(uy) if abs(uy) > 1e-9 else math.inf)
    tip = (cx + ux * (reach + VIEW_ARROW_GAP), cy + uy * (reach + VIEW_ARROW_GAP))
    tail = (tip[0] + ux * VIEW_ARROW_LENGTH, tip[1] + uy * VIEW_ARROW_LENGTH)
    letter_size = size + 1.5
    half = text_width(plan.label, letter_size) / 2
    reach_letter = half if abs(ux) > abs(uy) else letter_size * (TEXT_ASCENT + TEXT_DESCENT) / 2
    lx, ly = tail[0] + ux * (2.0 + reach_letter), tail[1] + uy * (2.0 + reach_letter)
    baseline = ly + (TEXT_ASCENT - TEXT_DESCENT) * letter_size / 2
    parts = [_line(tail[0], tail[1], tip[0], tip[1], 0.35), _arrow(tip, tail)]
    markup = f'<g class="section-line">{"".join(parts)}</g>' + _text(plan.label, lx, baseline, letter_size, "middle")
    extent = Box(min(tip[0], tail[0], lx - half) - 0.5, min(tip[1], tail[1], baseline - TEXT_ASCENT * letter_size) - 0.5,
                 max(tip[0], tail[0], lx + half) + 0.5, max(tip[1], tail[1], baseline + TEXT_DESCENT * letter_size) + 0.5)
    # never a ``view-`` id: layout_check reads those groups as view geometry
    return (SvgAnnotation(id=f"reference-arrow-{plan.id}".replace("_", "-"), kind="reference-arrow", markup=markup),
            [extent])
