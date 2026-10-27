"""Sheet composition: regime templates, title-block fields, and annotations around TechDraw views.

TechDraw (techdraw_job.py) projects and places the views; this module fills the template's
``freecad:editable`` fields the way TechDraw's DrawSVGTemplate does, completes the title block,
places the projection symbol in its cell, and draws dimensions and bore callouts on the sides of
the front view that the projection arrangement leaves free.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from defusedxml import ElementTree as SafeET

import freecad_runtime
from layout_check import SVG_NS, TEXT_ADVANCE, TEXT_ASCENT, TEXT_DESCENT, Box, SheetRegions, geometry_box

FREECAD_NS = "https://www.freecad.org/wiki/index.php?title=Svg_Namespace"
TEMPLATES = freecad_runtime.templates_dir(freecad_runtime.find_freecadcmd())
# Sample values the review found leaking from stock templates; never acceptable on a sheet.
STOCK_PLACEHOLDERS = frozenset({"A. Nemesis", "B. Hecate", "YYYY-MM-DD", "X / Y"})
# Largest first; ISO 5455 recommended enlargement and reduction scales.
STANDARD_SCALES = (50.0, 20.0, 10.0, 5.0, 2.0, 1.0, 1/2, 1/5, 1/10, 1/20, 1/50, 1/100, 1/200, 1/500, 1/1000)

VIEW_SPACING = 12.0       # TechDraw spacingX/spacingY: clear gap between neighbouring views
FRAME_CLEARANCE = 1.0     # between the drawing frame or title block and the view-plus-annotation envelope
OUTLINE_WIDTH = 0.5       # ISO 128 line group 0.5: visible outlines
THIN_WIDTH = 0.25         # dimension, extension and leader lines
TEXT_SIZE = 3.5           # dimension and callout font size (ISO 3098 lettering height 2.5)
TEXT_HEIGHT = (TEXT_ASCENT + TEXT_DESCENT) * TEXT_SIZE
EXT_GAP = 1.0             # extension line gap from the outline
EXT_OVERSHOOT = 1.5       # extension line run past the dimension line
TEXT_GAP = 1.0            # dimension text baseline to dimension line
LINE_CLEAR = 0.3          # text kept clear of line ends
ARROW_LENGTH, ARROW_HALF_WIDTH = 2.5, 0.45
CALLOUT_CLEARANCE = 1.5   # bore callout text from the outline
CALLOUT_OFFSET = 3.0      # bore callout text start from the bore centre
LEADER_GAP = 0.8          # leader end to callout text
# Callout text sits between the outline and the dimension line on the same side.
DIM_OFFSET = CALLOUT_CLEARANCE + TEXT_HEIGHT + 0.8
MAX_DIM_CHARS = 7         # widest overall dimension text reserved for unidirectional ASME text
CAPTION_SIZE, LABEL_SIZE, VALUE_SIZE = 1.8, 2.0, 3.0


@dataclass(frozen=True)
class SheetSpec:
    """One regime's template, projection arrangement, regions and title-block content."""

    regime: str
    template: Path
    projection_type: str
    regions: SheetRegions
    symbol_ids: tuple[str, ...]
    relabels: tuple[tuple[str, str], ...]
    fields: Callable[[dict[str, Any], dict[str, Any], str], dict[str, str]]
    decorate_title_block: Callable[[dict[str, Any], dict[str, Any]], list[ET.Element]]
    scale_text: Callable[[float], str]

    @property
    def first_angle(self) -> bool:
        return self.projection_type == "First angle"

    def view_area(self) -> Box:
        """Region the views and their annotations may occupy: inside the frame, above the title block."""
        frame, block = self.regions.frame, self.regions.title_block
        return Box(frame.x0 + FRAME_CLEARANCE, frame.y0 + FRAME_CLEARANCE, frame.x1 - FRAME_CLEARANCE,
                   block.y0 - FRAME_CLEARANCE)

    def margins(self) -> dict[str, float]:
        """Annotation space reserved on the free sides of the front view, sized for the worst placement."""
        outside = DIM_OFFSET + EXT_OVERSHOOT + LINE_CLEAR
        across = outside + TEXT_HEIGHT
        if self.first_angle:  # top view below, right view left: dimension above and right of the front view
            return {"top": across, "right": across, "bottom": 0.0, "left": 0.0}
        return {"top": 0.0, "right": 0.0, "bottom": across,
                "left": outside + MAX_DIM_CHARS * TEXT_ADVANCE * TEXT_SIZE}


def candidate_scales(requested: float) -> list[float]:
    """The requested scale, then each smaller standard scale."""
    return [requested, *(s for s in STANDARD_SCALES if s < requested * (1 - 1e-9))]


def _ratio(scale: float) -> tuple[str, str]:
    return (f"{scale:.4g}", "1") if scale >= 1 else ("1", f"{1/scale:.4g}")


def _element(tag: str, attributes: dict[str, Any] | None = None, text: str | None = None) -> ET.Element:
    element = ET.Element(f"{{{SVG_NS}}}{tag}", {k: (f"{v:.3f}" if isinstance(v, float) else str(v))
                                                 for k, v in (attributes or {}).items()})
    element.text = text
    return element


def _text(content: str, x: float, y: float, size: float, anchor: str = "start", **extra: Any) -> ET.Element:
    attributes = {"x": x, "y": y, "font-size": size, "font-family": "sans-serif", "fill": "#111", "stroke": "none"}
    if anchor != "start":
        attributes["text-anchor"] = anchor
    return _element("text", {**attributes, **extra}, content)


def _line(x1: float, y1: float, x2: float, y2: float, width: float = THIN_WIDTH) -> ET.Element:
    return _element("line", {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "stroke": "#111", "stroke-width": width})


def _arrow(tip: tuple[float, float], toward: tuple[float, float]) -> ET.Element:
    """Closed filled arrowhead with its tip at ``tip``, its base toward ``toward``."""
    dx, dy = toward[0] - tip[0], toward[1] - tip[1]
    length = math.hypot(dx, dy) or 1.0
    ux, uy = dx / length, dy / length
    bx, by = tip[0] + ux * ARROW_LENGTH, tip[1] + uy * ARROW_LENGTH
    points = [tip, (bx - uy * ARROW_HALF_WIDTH, by + ux * ARROW_HALF_WIDTH), (bx + uy * ARROW_HALF_WIDTH, by - ux * ARROW_HALF_WIDTH)]
    return _element("polygon", {"points": " ".join(f"{x:.3f},{y:.3f}" for x, y in points), "fill": "#111", "stroke": "none"})


def _text_width(content: str) -> float:
    return len(content) * TEXT_ADVANCE * TEXT_SIZE


def horizontal_dimension(name: str, x0: float, x1: float, edge: float, side: int, value: float, aligned: bool) -> ET.Element:
    """Overall dimension between x0 and x1 beyond the outline edge; side -1 places it above, +1 below.

    Aligned (ISO) text sits above the line; unidirectional (ASME) text sits in a break of the line.
    Text that does not fit between the extension lines moves beyond their ends.
    """
    group = _element("g", {"id": name, "class": "dimension"})
    y = edge + side * DIM_OFFSET
    content = f"{value:.2f}"
    width, mid = _text_width(content), (x0 + x1) / 2
    for x in (x0, x1):
        group.append(_line(x, edge + side * EXT_GAP, x, y + side * EXT_OVERSHOOT))
    outside_baseline = (y - EXT_OVERSHOOT - LINE_CLEAR - TEXT_DESCENT * TEXT_SIZE if side < 0
                        else y + EXT_OVERSHOOT + LINE_CLEAR + TEXT_ASCENT * TEXT_SIZE)
    if aligned:
        baseline = y - TEXT_GAP if width + 2 * LINE_CLEAR <= x1 - x0 else outside_baseline
        group.append(_line(x0, y, x1, y))
    elif width + 2 * (ARROW_LENGTH + LEADER_GAP) <= x1 - x0:
        baseline = y + (TEXT_ASCENT - TEXT_DESCENT) * TEXT_SIZE / 2
        group.append(_line(x0, y, mid - width / 2 - LEADER_GAP, y))
        group.append(_line(mid + width / 2 + LEADER_GAP, y, x1, y))
    else:
        baseline = outside_baseline
        group.append(_line(x0, y, x1, y))
    group.append(_arrow((x0, y), (x1, y)))
    group.append(_arrow((x1, y), (x0, y)))
    group.append(_text(content, mid, baseline, TEXT_SIZE, "middle"))
    return group


def vertical_dimension(name: str, y0: float, y1: float, edge: float, side: int, value: float, aligned: bool) -> ET.Element:
    """Overall dimension between y0 and y1 beyond the outline edge; side +1 places it right, -1 left.

    Aligned (ISO) text reads from the right, between the outline and the line when it fits.
    Unidirectional (ASME) text stays horizontal beyond the extension line ends.
    """
    group = _element("g", {"id": name, "class": "dimension"})
    x = edge + side * DIM_OFFSET
    content = f"{value:.2f}"
    width, mid = _text_width(content), (y0 + y1) / 2
    for y in (y0, y1):
        group.append(_line(edge + side * EXT_GAP, y, x + side * EXT_OVERSHOOT, y))
    group.append(_line(x, y0, x, y1))
    group.append(_arrow((x, y0), (x, y1)))
    group.append(_arrow((x, y1), (x, y0)))
    clear = EXT_OVERSHOOT + LINE_CLEAR
    if aligned:
        if width + 2 * LINE_CLEAR <= y1 - y0:
            baseline = x - TEXT_GAP
        else:
            baseline = x + clear + TEXT_ASCENT * TEXT_SIZE if side > 0 else x - clear - TEXT_DESCENT * TEXT_SIZE
        group.append(_text(content, baseline, mid, TEXT_SIZE, "middle", transform=f"rotate(-90 {baseline:.3f} {mid:.3f})"))
    else:
        text_y = mid + (TEXT_ASCENT - TEXT_DESCENT) * TEXT_SIZE / 2
        group.append(_text(content, x + side * clear, text_y, TEXT_SIZE, "start" if side > 0 else "end"))
    return group


def bore_callout(hole_id: str, centre: tuple[float, float], radius: float, view: Box, side: int,
                 diameter: float) -> ET.Element:
    """Diameter callout beyond the outline edge on ``side``; its leader ends with an arrow on the bore."""
    group = _element("g", {"id": f"hole-diameter-{hole_id}", "class": "leader"})
    content = f"⌀{diameter:.2f}"
    cx, cy = centre
    baseline = (view.y0 - CALLOUT_CLEARANCE - TEXT_DESCENT * TEXT_SIZE if side < 0
                else view.y1 + CALLOUT_CLEARANCE + TEXT_ASCENT * TEXT_SIZE)
    inward = 1 if cx <= (view.x0 + view.x1) / 2 else -1
    text_x = cx + inward * CALLOUT_OFFSET
    landing = (text_x - inward * LEADER_GAP, baseline - (TEXT_ASCENT - TEXT_DESCENT) * TEXT_SIZE / 2)
    dx, dy = landing[0] - cx, landing[1] - cy
    length = math.hypot(dx, dy)
    tip = (cx + radius * dx / length, cy + radius * dy / length)
    group.append(_line(landing[0], landing[1], tip[0], tip[1]))
    group.append(_arrow(tip, landing))
    group.append(_text(content, text_x, baseline, TEXT_SIZE, "start" if inward > 0 else "end"))
    return group


def _iso_fields(part: dict[str, Any], product: dict[str, Any], scale: str) -> dict[str, str]:
    return {
        "drawing_number": str(part["PN"]), "revision_index": str(part["rev"]), "title": str(part["title"]),
        "part_material": str(part["material"]), "general_tolerances": str(product["general_tolerance"]),
        "scale": scale, "sheet_number": "1 / 1", "document_type": "Part drawing", "language_code": "EN",
        # The record carries no author, approver, issue date or legal owner: leave those fields blank.
        "creator": "", "approval_person": "", "date_of_issue": "",
        "legal_owner_1": "", "legal_owner_2": "", "legal_owner_3": "", "legal_owner_4": "",
    }


def _iso_title_block(part: dict[str, Any], product: dict[str, Any]) -> list[ET.Element]:
    """Box the template's material, tolerance and scale row and give the projection symbol a cell.

    The stock ISO 5457 block has 12 mm rows from y=164; the unboxed row above it becomes y=152..164.
    """
    row = [_element("rect", {"x": 107.0, "y": 152.0, "width": 180.0, "height": 12.0, "fill": "none",
                             "stroke": "#000", "stroke-width": 0.7})]
    row.extend(_line(x, 152.0, x, 164.0, 0.35) for x in (187.0, 227.0, 247.0))
    return row


def _asme_fields(part: dict[str, Any], product: dict[str, Any], scale: str) -> dict[str, str]:
    return {
        "DrawingTitle1": str(part["title"]), "drawing_number": str(part["PN"]), "revision_index": str(part["rev"]),
        "scale": f"Scale {scale}", "Weight": "Weight:", "Sheet": "Sheet 1 of 1",
        # The record carries no company, CAGE code, signatures or second title lines: leave them blank.
        "DrawingTitle2": "", "DrawingTitle3": "", "CompanyName": "", "CompanyAddress": "", "Code": "",
        "DrawnBy": "", "CheckedBy": "", "Approved1": "", "Approved2": "",
    }


def _labelled_cell(label: str, value: str, cell: Box) -> list[ET.Element]:
    return [_text(label, cell.x0 + 1.2, cell.y0 + 0.2 + TEXT_ASCENT * LABEL_SIZE, LABEL_SIZE),
            _text(value, cell.x0 + 1.2, cell.y1 - 0.3 - TEXT_DESCENT * VALUE_SIZE, VALUE_SIZE)]


def _asme_title_block(part: dict[str, Any], product: dict[str, Any]) -> list[ET.Element]:
    """Caption the unlabelled ANSI A cells and fill the upper-left block from the record."""
    elements = [_line(112.63, 162.24, 159.85, 162.24, 0.35)]
    elements += _labelled_cell("Material:", str(part["material"]), Box(112.63, 153.5, 159.85, 162.24))
    elements += _labelled_cell("General tolerance:", str(product["general_tolerance"]), Box(112.63, 162.24, 159.85, 170.98))
    elements += _labelled_cell("Units:", "mm", Box(112.63, 170.98, 145.36, 180.33))
    captions = (("Company:", 161.2, 155.0), ("Size:", 160.4, 188.3), ("Code:", 169.7, 188.3),
                ("Drawing no.:", 195.8, 188.3), ("Rev:", 251.9, 188.3))
    elements += [_text(text, x, y, CAPTION_SIZE) for text, x, y in captions]
    return elements


SPECS = {
    "iso": SheetSpec(
        regime="iso", template=TEMPLATES / "ISO/A4_Landscape_ISO5457_minimal.svg", projection_type="First angle",
        regions=SheetRegions(frame=Box(20.0, 10.0, 287.0, 200.0), title_block=Box(107.0, 152.0, 287.0, 200.0),
                             symbol_cell=Box(247.0, 152.0, 287.0, 164.0)),
        symbol_ids=("extras_outlines", "extras_centre_lines"), relabels=(),
        fields=_iso_fields, decorate_title_block=_iso_title_block, scale_text=lambda s: " : ".join(_ratio(s)),
    ),
    "asme": SheetSpec(
        regime="asme", template=TEMPLATES / "ASME/ANSIA_Landscape.svg", projection_type="Third angle",
        regions=SheetRegions(frame=Box(20.107, 14.473, 259.627, 201.673), title_block=Box(112.63, 153.42, 259.42, 201.673),
                             symbol_cell=Box(145.36, 170.98, 159.85, 180.33)),
        symbol_ids=("line5117", "line5119", "polygon5123", "circle5125", "circle5127"),
        relabels=(("text3380", "Released:"),),  # the stock template labels two rows "Approved:"
        fields=_asme_fields, decorate_title_block=_asme_title_block, scale_text=lambda s: ":".join(_ratio(s)),
    ),
}


@dataclass(frozen=True)
class Sheet:
    svg: str
    placeholders: frozenset[str]
    warnings: tuple[str, ...]


def _register_namespaces(template: Path) -> None:
    """Keep the template's namespace prefixes on output, with SVG as the default namespace."""
    for _, (prefix, uri) in SafeET.iterparse(str(template), events=("start-ns",), forbid_dtd=True):
        if uri != SVG_NS:
            ET.register_namespace(prefix, uri)
    ET.register_namespace("", SVG_NS)


def _fill_editable_fields(root: ET.Element, values: dict[str, str]) -> dict[str, str]:
    """Replace each freecad:editable text like DrawSVGTemplate; return the template defaults."""
    defaults: dict[str, str] = {}
    for text in root.iter(f"{{{SVG_NS}}}text"):
        name = text.get(f"{{{FREECAD_NS}}}editable")
        if name is None:
            continue
        defaults[name] = "".join(text.itertext()).strip()
        spans = text.findall(f"{{{SVG_NS}}}tspan")
        if not spans:
            spans = [ET.SubElement(text, f"{{{SVG_NS}}}tspan")]
        for span in spans:
            span.text = None
            for child in list(span):
                span.remove(child)
        spans[0].text = values.get(name, "")
    missing, unknown = sorted(set(defaults) - set(values)), sorted(set(values) - set(defaults))
    if missing or unknown:
        raise ValueError(f"template editable fields mismatch: unassigned {missing}, unknown {unknown}")
    return defaults


def _hoist_span_font_sizes(root: ET.Element) -> None:
    """Move a tspan's font-size onto its text element; the AppKit renderer ignores it on tspans."""
    for text in root.iter(f"{{{SVG_NS}}}text"):
        if text.get("font-size") or "font-size" in text.get("style", ""):
            continue
        sized = next((span.get("font-size") for span in text.findall(f"{{{SVG_NS}}}tspan") if span.get("font-size")), None)
        if sized:
            text.set("font-size", sized)


def _place_symbol(root: ET.Element, ids: tuple[str, ...], cell: Box) -> None:
    """Gather the template's projection symbol into one group scaled and centred in its cell."""
    parents = {child: parent for parent in root.iter() for child in parent}
    elements = [element for element in root.iter() if element.get("id") in ids]
    if len(elements) != len(ids):
        raise ValueError(f"drawing template lacks projection symbol elements {ids}")
    source = None
    for element in elements:
        box = geometry_box(element)
        source = box if source is None else source.union(box)
    pad = 1.0
    factor = min(1.0, (cell.x1 - cell.x0 - 2 * pad) / (source.x1 - source.x0), (cell.y1 - cell.y0 - 2 * pad) / (source.y1 - source.y0))
    sx, sy = (source.x0 + source.x1) / 2, (source.y0 + source.y1) / 2
    cx, cy = (cell.x0 + cell.x1) / 2, (cell.y0 + cell.y1) / 2
    group = _element("g", {"id": "projection-symbol",
                           "transform": f"translate({cx:.3f} {cy:.3f}) scale({factor:.4f}) translate({-sx:.3f} {-sy:.3f})"})
    first_parent = parents[elements[0]]
    first_parent.insert(list(first_parent).index(elements[0]), group)
    for element in elements:
        parents[element].remove(element)
        group.append(element)


def _view_group(name: str, view: dict[str, Any]) -> ET.Element:
    fragment = SafeET.fromstring(f'<g xmlns="{SVG_NS}">{view["svg"]}</g>', forbid_dtd=True)
    for element in fragment.iter():
        element.attrib.pop("id", None)
        if element.get("stroke-width"):
            element.set("stroke-width", f"{OUTLINE_WIDTH:g}")
    fragment.set("id", f"view-{name}")
    fragment.set("transform", f"translate({view['center'][0]:.4f} {view['center'][1]:.4f})")
    return fragment


def _sheet_box(view: dict[str, Any]) -> Box:
    (cx, cy), (x0, y0, x1, y1) = view["center"], view["box"]
    return Box(cx + x0, cy + y0, cx + x1, cy + y1)


def _annotations(projection: dict[str, Any], spec: SheetSpec) -> tuple[ET.Element, list[str]]:
    front = projection["views"]["front"]
    box = _sheet_box(front)
    aligned = spec.regime == "iso"
    horizontal_side = -1 if spec.first_angle else 1
    vertical_side = 1 if spec.first_angle else -1
    group = _element("g", {"id": "cad-annotations"})
    extent = projection["extent_mm"]
    group.append(horizontal_dimension("overall-front-width", box.x0, box.x1,
                                      box.y0 if horizontal_side < 0 else box.y1, horizontal_side, extent["width"], aligned))
    group.append(vertical_dimension("overall-front-height", box.y0, box.y1,
                                    box.x1 if vertical_side > 0 else box.x0, vertical_side, extent["height"], aligned))
    warnings = []
    for bore in projection["bores"]:
        if bore["view"] != "front":
            warnings.append(f"bore {bore['id']} is not seen along its axis in the front view; no callout drawn")
            continue
        if not bore["matched"]:
            raise ValueError(f"metrics_mismatch: bore {bore['id']} has no matching circle in the front view")
        cx, cy, radius = bore["circle"]
        group.append(bore_callout(bore["id"], (front["center"][0] + cx, front["center"][1] + cy), radius, box,
                                  horizontal_side, bore["diameter_mm"]))
    return group, warnings


def compose(projection: dict[str, Any], part: dict[str, Any], product: dict[str, Any], spec: SheetSpec) -> Sheet:
    """Build the drawing SVG from a TechDraw projection result and the record."""
    _register_namespaces(spec.template)
    root = SafeET.parse(str(spec.template), forbid_dtd=True).getroot()
    values = spec.fields(part, product, spec.scale_text(projection["scale"]))
    defaults = _fill_editable_fields(root, values)
    _hoist_span_font_sizes(root)
    for element_id, label in spec.relabels:
        target = next((t for t in root.iter(f"{{{SVG_NS}}}text") if t.get("id") == element_id), None)
        if target is None:
            raise ValueError(f"drawing template lacks label {element_id}")
        spans = target.findall(f"{{{SVG_NS}}}tspan") or [target]
        spans[0].text = label
    _place_symbol(root, spec.symbol_ids, spec.regions.symbol_cell)
    title_block = _element("g", {"id": "cad-title-block"})
    title_block.extend(spec.decorate_title_block(part, product))
    root.append(title_block)
    width, height = (root.get("viewBox") or "").split()[2:4]
    root.insert(0, _element("rect", {"id": "paper-background", "x": 0, "y": 0, "width": width, "height": height, "fill": "#fff"}))
    content = _element("g", {"id": "cad-drawing-content"})
    for name in ("front", "top", "right"):
        content.append(_view_group(name, projection["views"][name]))
    annotations, warnings = _annotations(projection, spec)
    content.append(annotations)
    root.append(content)
    placeholders = (frozenset(defaults.values()) - frozenset(values.values())) | STOCK_PLACEHOLDERS
    return Sheet(ET.tostring(root, encoding="unicode") + "\n", frozenset(p for p in placeholders if p), tuple(warnings))
