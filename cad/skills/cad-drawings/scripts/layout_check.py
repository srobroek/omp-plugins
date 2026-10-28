"""Pure layout checks over a generated drawing SVG.

The check reads element coordinates from the SVG itself and relies on the ids and classes that
sheet composition emits: ``view-*`` groups hold projected view geometry, ``cad-annotations`` holds
dimension and callout groups (``class="dimension"`` or ``class="leader"``), ``cad-title-block`` holds
text added to the title block, and ``projection-symbol`` holds the projection symbol. Text extents are
estimated conservatively from font size and length; the stock template's own lettering is not
checked against itself.
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from defusedxml import ElementTree as SafeET

SVG_NS = "http://www.w3.org/2000/svg"
# Conservative glyph metrics in em units for a proportional sans-serif face.
TEXT_ADVANCE = 0.6
TEXT_ASCENT = 0.8
TEXT_DESCENT = 0.25

Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


@dataclass(frozen=True)
class Box:
    """Axis-aligned rectangle in sheet millimetres, Y down."""

    x0: float
    y0: float
    x1: float
    y1: float

    def intersects(self, other: Box) -> bool:
        return self.x0 < other.x1 and other.x0 < self.x1 and self.y0 < other.y1 and other.y0 < self.y1

    def contains(self, other: Box) -> bool:
        return self.x0 <= other.x0 and self.y0 <= other.y0 and other.x1 <= self.x1 and other.y1 <= self.y1

    def gap(self, other: Box) -> float:
        """Clear distance between two boxes; zero or negative when they touch or overlap."""
        dx = max(other.x0 - self.x1, self.x0 - other.x1)
        dy = max(other.y0 - self.y1, self.y0 - other.y1)
        if dx > 0 and dy > 0:
            return math.hypot(dx, dy)
        return max(dx, dy)

    @staticmethod
    def around(points: Iterable[tuple[float, float]]) -> Box | None:
        xs, ys = [], []
        for x, y in points:
            xs.append(x)
            ys.append(y)
        return Box(min(xs), min(ys), max(xs), max(ys)) if xs else None

    def union(self, other: Box | None) -> Box:
        if other is None:
            return self
        return Box(min(self.x0, other.x0), min(self.y0, other.y0), max(self.x1, other.x1), max(self.y1, other.y1))

    def corners(self) -> list[tuple[float, float]]:
        return [(self.x0, self.y0), (self.x1, self.y0), (self.x1, self.y1), (self.x0, self.y1)]


@dataclass(frozen=True)
class SheetRegions:
    """Template regions the layout is checked against."""

    frame: Box
    title_block: Box
    symbol_cell: Box


def _multiply(a: Matrix, b: Matrix) -> Matrix:
    return (a[0]*b[0] + a[2]*b[1], a[1]*b[0] + a[3]*b[1], a[0]*b[2] + a[2]*b[3], a[1]*b[2] + a[3]*b[3],
            a[0]*b[4] + a[2]*b[5] + a[4], a[1]*b[4] + a[3]*b[5] + a[5])


def _apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    return m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]


_NUMBER = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"


def parse_transform(text: str | None) -> Matrix:
    matrix = IDENTITY
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", text or ""):
        v = [float(n) for n in re.findall(_NUMBER, args)]
        if name == "translate":
            step = (1.0, 0.0, 0.0, 1.0, v[0], v[1] if len(v) > 1 else 0.0)
        elif name == "scale":
            step = (v[0], 0.0, 0.0, v[1] if len(v) > 1 else v[0], 0.0, 0.0)
        elif name == "rotate":
            a = math.radians(v[0])
            step = (math.cos(a), math.sin(a), -math.sin(a), math.cos(a), 0.0, 0.0)
            if len(v) == 3:
                step = _multiply(_multiply((1.0, 0.0, 0.0, 1.0, v[1], v[2]), step), (1.0, 0.0, 0.0, 1.0, -v[1], -v[2]))
        elif name == "matrix" and len(v) == 6:
            step = (v[0], v[1], v[2], v[3], v[4], v[5])
        else:
            raise ValueError(f"unsupported SVG transform: {name}")
        matrix = _multiply(matrix, step)
    return matrix


def _arc_points(x1: float, y1: float, rx: float, ry: float, phi_deg: float, large: bool, sweep: bool,
                x2: float, y2: float) -> list[tuple[float, float]]:
    """Sample an SVG elliptical arc (SVG 1.1 implementation notes F.6.5)."""
    if rx == 0 or ry == 0:
        return [(x2, y2)]
    phi = math.radians(phi_deg)
    cos_p, sin_p = math.cos(phi), math.sin(phi)
    dx, dy = (x1 - x2) / 2, (y1 - y2) / 2
    xp, yp = cos_p*dx + sin_p*dy, -sin_p*dx + cos_p*dy
    rx, ry = abs(rx), abs(ry)
    scale = (xp*xp)/(rx*rx) + (yp*yp)/(ry*ry)
    if scale > 1:
        rx, ry = rx*math.sqrt(scale), ry*math.sqrt(scale)
    num = rx*rx*ry*ry - rx*rx*yp*yp - ry*ry*xp*xp
    den = rx*rx*yp*yp + ry*ry*xp*xp
    factor = math.sqrt(max(0.0, num/den)) if den else 0.0
    if large == sweep:
        factor = -factor
    cxp, cyp = factor*rx*yp/ry, -factor*ry*xp/rx
    cx, cy = cos_p*cxp - sin_p*cyp + (x1 + x2)/2, sin_p*cxp + cos_p*cyp + (y1 + y2)/2

    def angle(ux: float, uy: float, vx: float, vy: float) -> float:
        return math.atan2(ux*vy - uy*vx, ux*vx + uy*vy)

    start = angle(1, 0, (xp - cxp)/rx, (yp - cyp)/ry)
    delta = angle((xp - cxp)/rx, (yp - cyp)/ry, (-xp - cxp)/rx, (-yp - cyp)/ry)
    if not sweep and delta > 0:
        delta -= 2*math.pi
    elif sweep and delta < 0:
        delta += 2*math.pi
    points = []
    for i in range(33):
        t = start + delta*i/32
        ex, ey = rx*math.cos(t), ry*math.sin(t)
        points.append((cos_p*ex - sin_p*ey + cx, sin_p*ex + cos_p*ey + cy))
    return points


def path_points(d: str) -> list[tuple[float, float]]:
    """Points whose bounding box contains the path: vertices, Bézier control points, sampled arcs."""
    tokens = re.findall(rf"[MmLlHhVvCcSsQqTtAaZz]|{_NUMBER}", d)
    points: list[tuple[float, float]] = []
    x = y = start_x = start_y = 0.0
    command = ""
    index = 0
    counts = {"M": 2, "L": 2, "T": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "A": 7, "Z": 0}
    while index < len(tokens):
        token = tokens[index]
        if token.isalpha():
            command = token
            index += 1
            if command in "Zz":
                x, y = start_x, start_y
                points.append((x, y))
                continue
        if not command:
            raise ValueError("SVG path data must start with a command")
        size = counts[command.upper()]
        args = [float(t) for t in tokens[index:index + size]]
        if len(args) < size:
            raise ValueError(f"truncated SVG path data near {command}")
        index += size
        relative = command.islower()
        upper = command.upper()
        if upper == "H":
            x = args[0] + (x if relative else 0)
            points.append((x, y))
        elif upper == "V":
            y = args[0] + (y if relative else 0)
            points.append((x, y))
        elif upper == "A":
            ex, ey = args[5] + (x if relative else 0), args[6] + (y if relative else 0)
            points.extend(_arc_points(x, y, args[0], args[1], args[2], bool(args[3]), bool(args[4]), ex, ey))
            x, y = ex, ey
        else:
            pairs = [(args[i] + (x if relative else 0), args[i + 1] + (y if relative else 0)) for i in range(0, size, 2)]
            points.extend(pairs)
            x, y = pairs[-1]
            if upper == "M":
                start_x, start_y = x, y
                command = "l" if relative else "L"
    return points


def _shape_points(element) -> list[tuple[float, float]]:
    tag = element.tag.rsplit("}", 1)[-1]
    get = element.get
    if tag == "path":
        return path_points(get("d", ""))
    if tag == "line":
        return [(float(get("x1", 0)), float(get("y1", 0))), (float(get("x2", 0)), float(get("y2", 0)))]
    if tag == "rect":
        x, y, w, h = (float(get(k, 0)) for k in ("x", "y", "width", "height"))
        return Box(x, y, x + w, y + h).corners()
    if tag in ("circle", "ellipse"):
        cx, cy = float(get("cx", 0)), float(get("cy", 0))
        rx = float(get("r", 0) if tag == "circle" else get("rx", 0))
        ry = float(get("r", 0) if tag == "circle" else get("ry", 0))
        return [(cx + rx*math.cos(t*math.pi/16), cy + ry*math.sin(t*math.pi/16)) for t in range(32)]
    if tag in ("polygon", "polyline"):
        values = [float(n) for n in re.findall(_NUMBER, get("points", ""))]
        return list(zip(values[0::2], values[1::2]))
    return []


def _style_value(element, name: str) -> str | None:
    match = re.search(rf"(?:^|;)\s*{name}\s*:\s*([^;]+)", element.get("style", ""))
    return match.group(1).strip() if match else element.get(name)


def _font_size(value: str | None) -> float | None:
    match = re.match(rf"\s*({_NUMBER})", value or "")
    return float(match.group(1)) if match else None


# Annotation group classes. Marks of a CLEAR class (dimension lines and arrows, feature control
# frames, datum letter boxes, surface texture symbols) must stay off view geometry and off other
# annotations' text; marks of an OVERLAY class are drawn on the views on purpose (extension, leader and
# centre lines, hatching, cutting planes, detail boundaries) and are not checked. Text is checked in every class.
CLEAR_CLASSES = frozenset({"dimension", "fcf", "datum-label", "texture"})
OVERLAY_CLASSES = frozenset({"extension", "leader", "leader-line", "centerline", "hatch", "section-line",
                             "detail-boundary", "datum-target"})


@dataclass(frozen=True)
class TextItem:
    content: str
    box: Box
    kind: str  # "annotation" (dimensions, callouts), "title" (added title-block text), "field" or "template"
    group: str = ""


@dataclass
class _Scene:
    views: dict[str, Box]
    texts: list[TextItem]
    dimension_marks: list[tuple[str, Box]]
    symbols: list[Box | None]


def geometry_box(element, matrix: Matrix = IDENTITY) -> Box | None:
    """Bounding box of an element's drawn geometry, including descendants and transforms."""
    matrix = _multiply(matrix, parse_transform(element.get("transform")))
    box = Box.around(_apply(matrix, x, y) for x, y in _shape_points(element))
    for child in element:
        child_box = geometry_box(child, matrix)
        box = child_box if box is None else box.union(child_box)
    return box


def _text_box(element, matrix: Matrix, font_size: float, anchor: str, content: str) -> Box:
    tspan = next((child for child in element if child.tag == f"{{{SVG_NS}}}tspan"), None)
    x = element.get("x") or (tspan.get("x") if tspan is not None else None) or "0"
    y = element.get("y") or (tspan.get("y") if tspan is not None else None) or "0"
    x0, y0 = float(re.findall(_NUMBER, x)[0]), float(re.findall(_NUMBER, y)[0])
    width = len(content) * TEXT_ADVANCE * font_size
    left = x0 - {"middle": width / 2, "end": width}.get(anchor, 0.0)
    local = Box(left, y0 - TEXT_ASCENT * font_size, left + width, y0 + TEXT_DESCENT * font_size)
    return Box.around(_apply(matrix, px, py) for px, py in local.corners())


def _walk(element, matrix: Matrix, font_size: float, anchor: str, context: str, scene: _Scene,
          group: str = "") -> None:
    matrix = _multiply(matrix, parse_transform(element.get("transform")))
    font_size = _font_size(_style_value(element, "font-size")) or font_size
    anchor = _style_value(element, "text-anchor") or anchor
    element_id = element.get("id", "")
    tag = element.tag.rsplit("}", 1)[-1]
    classes = set((element.get("class") or "").split())
    if tag == "g" and element_id.startswith("view-"):
        context = element_id
    elif tag == "g" and element_id == "projection-symbol":
        context = "symbol"
        scene.symbols.append(None)
    elif tag == "g" and context in ("annotations", "dimension", "overlay") and classes & CLEAR_CLASSES:
        context, group = "dimension", group or element_id
    elif tag == "g" and context in ("annotations", "dimension", "overlay") and classes & OVERLAY_CLASSES:
        context, group = "overlay", group or element_id
    elif tag == "g" and context == "annotations":
        group = group or element_id
    elif tag == "g" and element_id == "cad-annotations":
        context = "annotations"
    elif tag == "g" and element_id == "cad-title-block":
        context = "title"
    if tag == "text":
        content = "".join(element.itertext()).strip()
        if content:
            child_size = next((_font_size(_style_value(child, "font-size")) for child in element
                               if _font_size(_style_value(child, "font-size"))), None)
            size = child_size or font_size
            if context in ("annotations", "dimension", "overlay"):
                kind = "annotation"
            elif context == "title":
                kind = "title"
            elif any(key.endswith("}editable") for key in element.attrib):
                kind = "field"  # a template editable field filled from the record
            else:
                kind = "template"
            scene.texts.append(TextItem(content, _text_box(element, matrix, size, anchor, content), kind, group))
        return
    if tag in ("metadata", "defs", "title", "desc"):
        return
    points = _shape_points(element)
    if points:
        box = Box.around(_apply(matrix, x, y) for x, y in points)
        if context.startswith("view-"):
            scene.views[context] = box.union(scene.views.get(context))
        elif context == "symbol":
            scene.symbols[-1] = box.union(scene.symbols[-1])
        elif context == "dimension":
            scene.dimension_marks.append((group, box))
    for child in element:
        _walk(child, matrix, font_size, anchor, context, scene, group)


def _scene(svg_text: str) -> _Scene:
    root = SafeET.fromstring(svg_text, forbid_dtd=True)
    scene = _Scene({}, [], [], [])
    _walk(root, IDENTITY, 16.0, "start", "", scene)
    return scene


def _pairs(items: list) -> Iterator[tuple]:
    for i, first in enumerate(items):
        for second in items[i + 1:]:
            yield first, second


def check_layout(svg_text: str, regions: SheetRegions, placeholders: Iterable[str],
                 min_view_gap: float = 10.0) -> list[str]:
    """Return every layout violation in a drawing SVG; an empty list means the layout passes."""
    scene = _scene(svg_text)
    problems: list[str] = []
    forbidden = {p for p in placeholders if p.strip()}
    for item in scene.texts:
        if item.content in forbidden:
            problems.append(f"template placeholder remains: {item.content!r}")
    if not scene.views:
        problems.append("no view geometry found")
    for name, box in scene.views.items():
        if not regions.frame.contains(box):
            problems.append(f"{name} lies outside the drawing frame")
        if box.intersects(regions.title_block):
            problems.append(f"{name} overlaps the title block")
    for (first, a), (second, b) in _pairs(list(scene.views.items())):
        if a.gap(b) < min_view_gap:
            problems.append(f"{first} and {second} are {a.gap(b):.2f} mm apart; minimum is {min_view_gap:g} mm")
    for item in (t for t in scene.texts if t.kind == "annotation"):
        label = f"annotation text {item.content!r}"
        if not regions.frame.contains(item.box):
            problems.append(f"{label} crosses the drawing frame")
        if item.box.intersects(regions.title_block):
            problems.append(f"{label} overlaps the title block")
        for name, box in scene.views.items():
            if item.box.intersects(box):
                problems.append(f"{label} overlaps {name} geometry")
    for first, second in _pairs(scene.texts):
        if first.kind == second.kind == "template":
            continue  # the stock template's own lettering is not ours to re-layout
        if first.box.intersects(second.box):
            problems.append(f"{first.kind} text {first.content!r} overlaps {second.kind} text {second.content!r}")
    for mark_group, mark in scene.dimension_marks:
        for name, box in scene.views.items():
            if mark.intersects(box):
                problems.append(f"a dimension line or frame at ({mark.x0:.1f}, {mark.y0:.1f}) crosses {name} geometry")
        for item in scene.texts:
            if item.kind == "annotation" and item.group != mark_group and item.box.intersects(mark):
                problems.append(f"annotation text {item.content!r} overlaps the dimension line or frame of {mark_group}")
    if len(scene.symbols) != 1:
        problems.append(f"expected exactly one projection symbol, found {len(scene.symbols)}")
    for symbol in scene.symbols:
        if symbol is None or not regions.symbol_cell.contains(symbol):
            problems.append("projection symbol lies outside its title-block cell")
    return problems
