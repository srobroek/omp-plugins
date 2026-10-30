"""Drawing documents: sheet specifications, page composition and checked package publication.

One sheet contract generates every page, so sizes differ only in their dimensions:

- ``sheet_specs`` turns the product's regime, projection and orientation plus the allowed sizes
  into ``SheetSpec`` candidates, smallest sheet first. ISO sheets are ISO 216 A sizes with the
  ISO 5457 frame (20 mm filing margin on the left, 10 mm elsewhere); ASME sheets are ANSI A to E or
  the metric A sizes of Y14.1M, framed 10 mm from every edge. Every sheet has the same 180 mm
  title block (ISO 7200's maximum width) in the frame's lower right corner.
- ``compose_page`` draws the frame, centring marks, title block, projection symbol, views,
  annotations, tables and general notes as one SVG in sheet millimetres with Y down. Its ids and
  classes are the ones ``layout_check.check_layout`` reads: ``view-*`` groups, ``cad-annotations``,
  ``cad-title-block`` and ``projection-symbol``.
- ``publish_package`` checks and exports every sheet inside its supplied draft folder. Passing output
  is later sealed by cad-record's bundle API; a rejected draft is retained in ``.cad-work``.
"""

from __future__ import annotations

import math
import os
import json
import re
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from xml.etree import ElementTree as ET

from defusedxml import ElementTree as SafeET

import freecad_runtime

import sheet_export
from drawing_contract import DrawingContext, layout_api, sha256
from freecad_views import ViewGeometry
from layout_check import SVG_NS, TEXT_ADVANCE, TEXT_ASCENT, TEXT_DESCENT, Box, SheetRegions, check_layout

# Largest first; ISO 5455 recommended enlargement and reduction scales.
STANDARD_SCALES = (50.0, 20.0, 10.0, 5.0, 2.0, 1.0, 1/2, 1/5, 1/10, 1/20, 1/50, 1/100, 1/200, 1/500, 1/1000)
SIZES_MM = {  # (short side, long side)
    "A4": (210.0, 297.0), "A3": (297.0, 420.0), "A2": (420.0, 594.0), "A1": (594.0, 841.0), "A0": (841.0, 1189.0),
    "ANSI A": (215.9, 279.4), "ANSI B": (279.4, 431.8), "ANSI C": (431.8, 558.8), "ANSI D": (558.8, 863.6),
    "ANSI E": (863.6, 1117.6),
}
REGIME_SIZES = {"iso": ("A4", "A3", "A2", "A1", "A0"),
                "asme": ("ANSI A", "ANSI B", "ANSI C", "ANSI D", "ANSI E", "A4", "A3", "A2", "A1", "A0")}
DEFAULT_PROJECTION = {"iso": "first_angle", "asme": "third_angle"}
MARGINS_MM = {"iso": (20.0, 10.0, 10.0, 10.0), "asme": (10.0, 10.0, 10.0, 10.0)}  # left, top, right, bottom

FRAME_WIDTH = 0.7         # ISO 5457 frame line
OUTLINE_WIDTH = 0.5       # ISO 128-2 line group 0.5: visible outlines
THIN_WIDTH = 0.25         # hidden lines, table and title-block rules, symbol centre lines
HIDDEN_DASH = "3 0.75"    # ISO 128-2 line type 02 for a 0.25 mm line: 12d dash, 3d gap
CENTRING_MARK_INSIDE = 5.0
FRAME_CLEARANCE = 1.0     # between the frame or title block and anything placed in the drawing area
TITLE_BLOCK_WIDTH = 180.0
ROW_HEIGHT = 9.0
LABEL_SIZE, VALUE_SIZE, NUMBER_SIZE, MIN_TEXT_SIZE = 1.8, 3.5, 5.0, 1.8
TABLE_TEXT_SIZE, TABLE_ROW, TABLE_PAD = 2.5, 6.0, 1.5
NOTE_SIZE, NOTE_HEADING_SIZE, NOTE_LINE = 2.5, 3.5, 4.0
CELL_PAD = 1.2
ID = re.compile(r"[a-z][a-z0-9_-]*")

# The title block, top row first: (field, width in mm). The projection cell holds the symbol.
TITLE_ROWS = (
    (("material", 70.0), ("general_tolerance", 60.0), ("scale", 25.0), ("projection", 25.0)),
    (("title", 125.0), ("document_type", 55.0)),
    (("drawing_number", 75.0), ("revision", 20.0), ("sheet", 30.0), ("size", 25.0), ("units", 30.0)),
    (("legal_owner", 55.0), ("creator", 40.0), ("approver", 40.0), ("date_of_issue", 45.0)),
    (("standards", 180.0),),
)
LABELS = {
    "iso": {"material": "Material", "general_tolerance": "General tolerances", "scale": "Scale", "projection": "",
            "title": "Title", "document_type": "Document type", "drawing_number": "Identification number",
            "revision": "Rev.", "sheet": "Sheet", "size": "Size", "units": "Units", "legal_owner": "Legal owner",
            "creator": "Created by", "approver": "Approved by", "date_of_issue": "Date of issue",
            "standards": "Standards"},
    "asme": {"material": "MATERIAL", "general_tolerance": "UNLESS OTHERWISE SPECIFIED", "scale": "SCALE",
             "projection": "", "title": "TITLE", "document_type": "DOCUMENT", "drawing_number": "DWG NO.",
             "revision": "REV", "sheet": "SHEET", "size": "SIZE", "units": "UNITS", "legal_owner": "COMPANY",
             "creator": "DRAWN", "approver": "APPROVED", "date_of_issue": "DATE", "standards": "STANDARDS"},
}
NOTES_HEADING = {"iso": "Notes", "asme": "NOTES:"}


class CompositionError(ValueError):
    """Content that cannot be placed on the sheet: ``code`` is ``sheet_no_fit`` or ``layout_check_failed``."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def candidate_scales(requested: float) -> list[float]:
    """The requested scale, then each smaller standard scale."""
    return [requested, *(s for s in STANDARD_SCALES if s < requested * (1 - 1e-9))]


def scale_ratio(scale: float) -> tuple[str, str]:
    """A scale as its ISO 5455 ratio terms, enlargement ``(5, 1)`` or reduction ``(1, 5)``."""
    return (f"{scale:.4g}", "1") if scale >= 1 else ("1", f"{1/scale:.4g}")


def scale_text(regime: str, scale: float) -> str:
    return (" : " if regime == "iso" else ":").join(scale_ratio(scale))


@dataclass(frozen=True)
class SheetSpec:
    """One sheet: regime, size and orientation, projection method and the regions its furniture uses."""

    regime: str
    size: str
    orientation: str
    width_mm: float
    height_mm: float
    projection: str           # "first_angle" or "third_angle"
    regions: SheetRegions     # frame, title block, projection-symbol cell

    @property
    def projection_type(self) -> str:
        """TechDraw's DrawProjGroup.ProjectionType for this sheet."""
        return "First angle" if self.projection == "first_angle" else "Third angle"

    def drawing_area(self) -> Box:
        """Inside the frame, kept clear of it; views must also avoid the title block, tables and notes."""
        frame = self.regions.frame
        return Box(frame.x0 + FRAME_CLEARANCE, frame.y0 + FRAME_CLEARANCE, frame.x1 - FRAME_CLEARANCE,
                   frame.y1 - FRAME_CLEARANCE)

    def page_template_svg(self) -> str:
        """An empty SVG of this sheet's size, for the TechDraw page whose views ``serialize_view`` reads.

        ``serialize_view`` turns TechDraw's Y-up page positions into sheet positions with the
        page template's height, so the FreeCAD page must be this sheet's size.
        """
        return (f'<svg xmlns="{SVG_NS}" width="{self.width_mm:g}mm" height="{self.height_mm:g}mm" '
                f'viewBox="0 0 {self.width_mm:g} {self.height_mm:g}"></svg>\n')


def _spec(regime: str, size: str, orientation: str, projection: str) -> SheetSpec:
    short, long = SIZES_MM[size]
    width, height = (long, short) if orientation == "landscape" else (short, long)
    left, top, right, bottom = MARGINS_MM[regime]
    frame = Box(left, top, width - right, height - bottom)
    block = Box(frame.x1 - TITLE_BLOCK_WIDTH, frame.y1 - ROW_HEIGHT * len(TITLE_ROWS), frame.x1, frame.y1)
    cells = _title_cells(block)
    return SheetSpec(regime=regime, size=size, orientation=orientation, width_mm=width, height_mm=height,
                     projection=projection,
                     regions=SheetRegions(frame=frame, title_block=block, symbol_cell=cells["projection"]))


def sheet_specs(product: Mapping[str, Any], allowed_sizes: Sequence[str]) -> tuple[SheetSpec, ...]:
    """Candidate sheets for a product record, smallest first; raise ValueError for an unusable request.

    The regime comes from ``product.regime``; projection and orientation from ``product.drawing``
    (``projection``, ``default_sheet.orientation``) or the regime's default projection and landscape.
    """
    regime = product.get("regime")
    if regime not in REGIME_SIZES:
        raise ValueError(f"product regime {regime!r} is not iso or asme")
    drawing = product.get("drawing") or {}
    projection = drawing.get("projection", DEFAULT_PROJECTION[regime])
    orientation = (drawing.get("default_sheet") or {}).get("orientation", "landscape")
    if projection not in ("first_angle", "third_angle"):
        raise ValueError(f"projection {projection!r} is not first_angle or third_angle")
    if orientation not in ("landscape", "portrait"):
        raise ValueError(f"orientation {orientation!r} is not landscape or portrait")
    if not allowed_sizes:
        raise ValueError("no sheet size is allowed")
    unknown = sorted(set(allowed_sizes) - set(REGIME_SIZES[regime]))
    if unknown:
        raise ValueError(f"sheet sizes {unknown} are not {regime} sheets; use {', '.join(REGIME_SIZES[regime])}")
    ordered = sorted(set(allowed_sizes), key=lambda size: (SIZES_MM[size][0] * SIZES_MM[size][1], size))
    return tuple(_spec(regime, size, orientation, projection) for size in ordered)


@dataclass(frozen=True)
class SheetMetadata:
    """Identity and title-block content of one sheet; ``None`` fields print as blank cells."""

    drawing_number: str
    revision: str
    title: str
    document_type: str
    sheet_number: int
    sheet_count: int
    scale: float
    material: str | None = None
    general_tolerance: str | None = None
    standards: tuple[str, ...] = ()
    legal_owner: str | None = None
    creator: str | None = None
    approver: str | None = None
    date_of_issue: str | None = None


@dataclass(frozen=True)
class SvgAnnotation:
    """Dimension, leader, label or symbol markup in sheet millimetres; ``kind`` becomes its SVG class.

    ``layout_check`` checks a ``dimension`` group's lines against view geometry and every
    annotation's text against views, frame and title block. ``provenance`` names the measurement
    and requirement the annotation states (for example ``{"measurement": "m3", "requirement": "r7"}``).
    """

    id: str
    kind: str
    markup: str
    provenance: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SvgTable:
    """A parts list, coordinate or revision table stacked above the title block, header next to it."""

    id: str
    columns: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]


class NoteSymbol(Protocol):
    """A graphical symbol a note carries, such as a general surface texture indication."""

    def size(self, height: float) -> tuple[float, float]: ...

    def markup(self, x: float, y: float, height: float) -> str: ...


@dataclass(frozen=True)
class SvgNote:
    """One numbered general note; a ``symbol`` is drawn on its own row under the note's text."""

    id: str
    text: str
    provenance: Mapping[str, str] = field(default_factory=dict)
    symbol: NoteSymbol | None = None


@dataclass(frozen=True)
class NoteLine:
    """One row of the notes block: wrapped text with its indent, or a note's symbol."""

    text: str
    indent: float
    symbol: NoteSymbol | None = None
    note: str = ""

    @property
    def advance(self) -> float:
        """Baseline to baseline: a text line's pitch, or a symbol row's height and its gap."""
        return NOTE_LINE if self.symbol is None else self.symbol.size(NOTE_SIZE)[1] + 1.0

    @property
    def width(self) -> float:
        return self.indent + (text_width(self.text, NOTE_SIZE) if self.symbol is None else self.symbol.size(NOTE_SIZE)[0])


@dataclass(frozen=True)
class PageLayout:
    """Where the furniture of one page goes; views must stay inside ``drawing_area`` and off ``obstacles``."""

    drawing_area: Box
    title_region: Box                 # title block plus the tables stacked on it
    tables: Mapping[str, Box]
    notes: Box | None
    note_lines: tuple[NoteLine, ...] = ()   # the notes block's rows, top to bottom

    @property
    def obstacles(self) -> tuple[Box, ...]:
        return (self.title_region,) if self.notes is None else (self.title_region, self.notes)


@dataclass(frozen=True)
class ComposedSheet:
    """One composed page: its SVG, the regions to check it against, and what the export must contain."""

    spec: SheetSpec
    metadata: SheetMetadata
    svg: str
    regions: SheetRegions
    placeholders: frozenset[str]
    view_ids: tuple[str, ...]
    annotations: Mapping[str, Mapping[str, str]]   # annotation or note id -> provenance
    required_text: tuple[str, ...]


@dataclass(frozen=True)
class CoverageReport:
    """The completeness gate's verdict for a package: rows of feature -> requirement -> annotation, the recognised
    manufacturing features' size rows (``feature_coverage``), and findings."""

    status: str                                   # "pass" or "fail"
    rows: tuple[Mapping[str, Any], ...] = ()
    findings: tuple[Mapping[str, Any], ...] = ()  # each with a failure ``code`` and ``message``
    features: tuple[Mapping[str, Any], ...] = ()  # recognised feature -> size -> stating characteristic

    def __post_init__(self) -> None:
        if self.status not in ("pass", "fail") or (self.status == "pass") == bool(self.findings):
            raise ValueError("a coverage report passes exactly when it has no findings")

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "rows": [dict(r) for r in self.rows], "findings": [dict(f) for f in self.findings],
                "features": [dict(r) for r in self.features]}


@dataclass(frozen=True)
class PackageReport:
    """The outcome of one publication run; ``package.json`` holds it only when it passed."""

    hw: Path
    status: str                                   # "pass", "fail" (content) or "error" (infrastructure)
    run_id: str
    output_dir: Path
    provenance: Mapping[str, Any]
    sheets: tuple[Mapping[str, Any], ...]
    coverage: Mapping[str, Any]
    findings: tuple[Mapping[str, Any], ...] = ()
    release: tuple[Mapping[str, Any], ...] = ()    # release-readiness blockers; empty means releasable

    @property
    def exit_code(self) -> int:
        return {"pass": 0, "fail": 1, "error": 2}[self.status]

    def to_dict(self) -> dict[str, Any]:
        api = layout_api()
        sheets = [{**dict(sheet), "files": {kind: api.relative(self.hw, self.output_dir / Path(name).name)
                                              for kind, name in sheet.get("files", {}).items()}}
                  for sheet in self.sheets]
        target_rel = api.relative(self.hw, self.output_dir)
        return {"status": self.status, "run_id": self.run_id, "output_dir": target_rel,
                "provenance": dict(self.provenance), "sheets": sheets, "coverage": dict(self.coverage),
                "findings": [dict(f) for f in self.findings],
                "release": {"ready": not self.release, "blockers": [dict(r) for r in self.release]}}


def _title_cells(block: Box) -> dict[str, Box]:
    cells, y = {}, block.y0
    for row in TITLE_ROWS:
        x = block.x0
        for name, width in row:
            cells[name] = Box(x, y, x + width, y + ROW_HEIGHT)
            x += width
        y += ROW_HEIGHT
    return cells


def _element(tag: str, attributes: Mapping[str, Any] | None = None, text: str | None = None) -> ET.Element:
    element = ET.Element(f"{{{SVG_NS}}}{tag}", {k: (f"{v:.3f}" if isinstance(v, float) else str(v))
                                                 for k, v in (attributes or {}).items()})
    element.text = text
    return element


def _text(content: str, x: float, y: float, size: float, anchor: str = "start", bold: bool = False) -> ET.Element:
    attributes: dict[str, Any] = {"x": x, "y": y, "font-size": size, "font-family": "osifont", "fill": "#000",
                                  "stroke": "none"}
    if anchor != "start":
        attributes["text-anchor"] = anchor
    if bold:
        attributes["font-weight"] = "bold"
    return _element("text", attributes, content)


def _line(x1: float, y1: float, x2: float, y2: float, width: float = THIN_WIDTH, **extra: Any) -> ET.Element:
    return _element("line", {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "stroke": "#000", "stroke-width": width, **extra})


def _rect(box: Box, width: float) -> ET.Element:
    return _element("rect", {"x": box.x0, "y": box.y0, "width": box.x1 - box.x0, "height": box.y1 - box.y0,
                             "fill": "none", "stroke": "#000", "stroke-width": width})


def text_width(content: str, size: float) -> float:
    """The conservative text width ``layout_check`` assumes for ``content`` at ``size``."""
    return len(content) * TEXT_ADVANCE * size


def _fitted_size(content: str, size: float, room: float, where: str) -> float:
    if not content or text_width(content, size) <= room:
        return size
    fitted = room / (len(content) * TEXT_ADVANCE)
    if fitted < MIN_TEXT_SIZE:
        raise CompositionError("layout_check_failed", f"{where} {content!r} needs {text_width(content, MIN_TEXT_SIZE):.1f} mm "
                                                      f"at the {MIN_TEXT_SIZE} mm minimum lettering; the cell is {room:.1f} mm")
    return math.floor(fitted * 100) / 100


def _wrap(text: str, size: float, room: float) -> list[str]:
    words, lines, current = text.split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and text_width(candidate, size) > room:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    if any(text_width(line, size) > room for line in lines):
        raise CompositionError("sheet_no_fit", f"a note word does not fit the {room:.1f} mm notes column: {text!r}")
    return lines


def _table_size(table: SvgTable) -> tuple[list[float], float]:
    widths = [max(text_width(cell, TABLE_TEXT_SIZE) for cell in column) + 2 * TABLE_PAD
              for column in zip(table.columns, *table.rows)]
    return widths, TABLE_ROW * (1 + len(table.rows))


def _note_lines(notes: Sequence[SvgNote], room: float) -> list[NoteLine]:
    """Each row of the notes block; continuation lines and a note's symbol hang under the note text."""
    lines: list[NoteLine] = []
    for number, note in enumerate(notes, start=1):
        prefix = f"{number}. "
        indent = text_width(prefix, NOTE_SIZE)
        for index, line in enumerate(_wrap(note.text, NOTE_SIZE, room - indent)):
            lines.append(NoteLine(prefix + line, 0.0) if index == 0 else NoteLine(line, indent))
        if note.symbol is not None:
            if indent + note.symbol.size(NOTE_SIZE)[0] > room:
                raise CompositionError("sheet_no_fit", f"note {note.id}'s symbol does not fit the {room:.1f} mm "
                                                       f"notes column")
            lines.append(NoteLine("", indent, note.symbol, note.id))
    return lines


def page_layout(spec: SheetSpec, tables: Sequence[SvgTable] = (), notes: Sequence[SvgNote] = ()) -> PageLayout:
    """Where ``compose_page`` puts the tables and notes of a page; raise CompositionError when they do not fit.

    Tables stack on the title block, right-aligned with it. Notes take the frame's lower left
    corner when the title block and its tables leave at least 60 mm beside them, else the space
    above the tables. A table wider than the title block narrows that corner: ``layout_check``
    keeps every annotation off the box round the title block and its tables.
    """
    area = spec.drawing_area()
    block = spec.regions.title_block
    region, boxes, top = block, {}, block.y0
    for table in tables:
        widths, height = _table_size(table)
        box = Box(block.x1 - sum(widths), top - height, block.x1, top)
        if box.x0 < area.x0 or box.y0 < area.y0:
            raise CompositionError("sheet_no_fit", f"table {table.id} ({sum(widths):.1f} x {height:.1f} mm) does not fit "
                                                   f"above the title block of {spec.size}")
        boxes[table.id] = box
        region = region.union(box)
        top = box.y0
    notes_box, lines = None, []
    if notes:
        beside = region.x0 - FRAME_CLEARANCE - area.x0
        room = beside if beside >= 60.0 else area.x1 - area.x0
        bottom = area.y1 if beside >= 60.0 else region.y0 - FRAME_CLEARANCE
        lines = _note_lines(notes, room)
        height = (NOTE_HEADING_SIZE * (TEXT_ASCENT + TEXT_DESCENT) + 1.0 + sum(line.advance for line in lines)
                  + TEXT_DESCENT * NOTE_SIZE)
        width = max(text_width(NOTES_HEADING[spec.regime], NOTE_HEADING_SIZE), *(line.width for line in lines))
        notes_box = Box(area.x0, bottom - height, area.x0 + width, bottom)
        if notes_box.y0 < area.y0:
            raise CompositionError("sheet_no_fit", f"{len(notes)} notes need {height:.1f} mm; {spec.size} has no room")
    return PageLayout(drawing_area=area, title_region=region, tables=boxes, notes=notes_box, note_lines=tuple(lines))


def _title_values(spec: SheetSpec, metadata: SheetMetadata) -> dict[str, str]:
    sheet = (f"{metadata.sheet_number} / {metadata.sheet_count}" if spec.regime == "iso"
             else f"{metadata.sheet_number} OF {metadata.sheet_count}")
    return {"material": metadata.material or "", "general_tolerance": metadata.general_tolerance or "",
            "scale": scale_text(spec.regime, metadata.scale), "projection": "", "title": metadata.title,
            "document_type": metadata.document_type, "drawing_number": metadata.drawing_number,
            "revision": metadata.revision, "sheet": sheet, "size": spec.size, "units": "mm",
            "legal_owner": metadata.legal_owner or "", "creator": metadata.creator or "",
            "approver": metadata.approver or "", "date_of_issue": metadata.date_of_issue or "",
            "standards": " · ".join(metadata.standards)}


def _title_block(spec: SheetSpec, metadata: SheetMetadata) -> ET.Element:
    group = _element("g", {"id": "cad-title-block"})
    block = spec.regions.title_block
    group.append(_rect(block, FRAME_WIDTH))
    cells = _title_cells(block)
    values = _title_values(spec, metadata)
    labels = LABELS[spec.regime]
    for name, cell in cells.items():
        group.append(_rect(cell, THIN_WIDTH))
        if labels[name]:
            group.append(_text(labels[name], cell.x0 + CELL_PAD, cell.y0 + 0.5 + TEXT_ASCENT * LABEL_SIZE, LABEL_SIZE))
        if values[name]:
            preferred = NUMBER_SIZE if name == "drawing_number" else VALUE_SIZE
            size = _fitted_size(values[name], preferred, cell.x1 - cell.x0 - 2 * CELL_PAD, f"title block {name}")
            group.append(_text(values[name], cell.x0 + CELL_PAD, cell.y1 - 0.8 - TEXT_DESCENT * size, size,
                               bold=name == "drawing_number"))
    return group


def _projection_symbol(projection: str, cell: Box) -> ET.Element:
    """ISO 5456-2 / ASME Y14.3 projection symbol: a truncated cone and its end view, fitted to ``cell``.

    The end view shows the cone's small end; first angle puts it right of the cone, third angle left.
    """
    pad = 1.5
    unit = min((cell.x1 - cell.x0 - 2 * pad) / 4.5, (cell.y1 - cell.y0 - 2 * pad) / 2)
    cx, cy = (cell.x0 + cell.x1) / 2, (cell.y0 + cell.y1) / 2
    left = cx - 2.25 * unit
    if projection == "first_angle":
        cone_x0, circle_x = left, left + 3.5 * unit
        small_x, large_x = cone_x0, cone_x0 + 2 * unit
    else:
        circle_x, cone_x0 = left + unit, left + 2.5 * unit
        small_x, large_x = cone_x0, cone_x0 + 2 * unit
    group = _element("g", {"id": "projection-symbol", "fill": "none", "stroke": "#000"})
    points = [(small_x, cy - unit / 2), (large_x, cy - unit), (large_x, cy + unit), (small_x, cy + unit / 2)]
    group.append(_element("polygon", {"points": " ".join(f"{x:.3f},{y:.3f}" for x, y in points),
                                      "stroke-width": OUTLINE_WIDTH}))
    for radius in (unit, unit / 2):
        group.append(_element("circle", {"cx": circle_x, "cy": cy, "r": radius, "stroke-width": OUTLINE_WIDTH}))
    dash = {"stroke-dasharray": "2 0.5 0.5 0.5"}
    group.append(_line(min(cone_x0, circle_x - unit) - 0.5, cy, max(large_x, circle_x + unit) + 0.5, cy, THIN_WIDTH, **dash))
    group.append(_line(circle_x, cy - unit - 0.5, circle_x, cy + unit + 0.5, THIN_WIDTH, **dash))
    return group


def _frame(spec: SheetSpec) -> ET.Element:
    """The frame and the four ISO 5457 centring marks, from the trimmed edge to 5 mm inside the frame."""
    group = _element("g", {"id": "sheet-frame"})
    frame = spec.regions.frame
    group.append(_rect(frame, FRAME_WIDTH))
    mx, my = spec.width_mm / 2, spec.height_mm / 2
    for x1, y1, x2, y2 in ((mx, 0.0, mx, frame.y0 + CENTRING_MARK_INSIDE),
                           (mx, spec.height_mm, mx, frame.y1 - CENTRING_MARK_INSIDE),
                           (0.0, my, frame.x0 + CENTRING_MARK_INSIDE, my),
                           (spec.width_mm, my, frame.x1 - CENTRING_MARK_INSIDE, my)):
        group.append(_line(x1, y1, x2, y2, FRAME_WIDTH))
    return group


def _view_group(view: ViewGeometry) -> ET.Element:
    cx, cy = view.centre_mm
    group = _element("g", {"id": f"view-{view.view_id}", "class": "view", "data-role": view.role,
                           "transform": f"translate({cx:.4f} {cy:.4f})"})
    for layer, paths, attributes in (
            ("visible", view.visible, {"stroke-width": OUTLINE_WIDTH}),
            ("hidden", view.hidden, {"stroke-width": THIN_WIDTH, "stroke-dasharray": HIDDEN_DASH})):
        if not paths:
            continue
        layer_group = _element("g", {"class": layer, "fill": "none", "stroke": "#000", "stroke-linecap": "round",
                                     "stroke-linejoin": "round", **attributes})
        layer_group.extend(_element("path", {"d": d}) for d in paths)
        group.append(layer_group)
    return group


def _markup(annotation: SvgAnnotation) -> ET.Element:
    try:
        fragment = SafeET.fromstring(f'<g xmlns="{SVG_NS}">{annotation.markup}</g>', forbid_dtd=True)
    except Exception as exc:  # noqa: BLE001 - defusedxml raises several parser error types
        raise ValueError(f"annotation {annotation.id} markup is not well-formed SVG: {exc}") from exc
    fragment.set("id", annotation.id)
    fragment.set("class", annotation.kind)
    return fragment


def _table_group(table: SvgTable, box: Box) -> ET.Element:
    """Rows read upward from the header, which sits next to the title block (ISO 7573)."""
    group = _element("g", {"id": f"table-{table.id}", "class": "table"})
    widths, _ = _table_size(table)
    group.append(_rect(box, OUTLINE_WIDTH))
    for index, row in enumerate((table.columns, *table.rows)):
        y1 = box.y1 - index * TABLE_ROW
        if index:
            group.append(_line(box.x0, y1, box.x1, y1))
        x = box.x0
        for column, (cell, width) in enumerate(zip(row, widths)):
            if column:
                group.append(_line(x, box.y0, x, box.y1))
            group.append(_text(cell, x + TABLE_PAD, y1 - (TABLE_ROW - TABLE_TEXT_SIZE * (TEXT_ASCENT - TEXT_DESCENT)) / 2,
                               TABLE_TEXT_SIZE, bold=index == 0))
            x += width
    return group


def _notes_group(regime: str, layout: PageLayout) -> ET.Element:
    group = _element("g", {"id": "general-notes", "class": "note"})
    box = layout.notes
    baseline = box.y0 + TEXT_ASCENT * NOTE_HEADING_SIZE
    group.append(_text(NOTES_HEADING[regime], box.x0, baseline, NOTE_HEADING_SIZE, bold=True))
    baseline += TEXT_DESCENT * NOTE_HEADING_SIZE + 1.0
    for line in layout.note_lines:
        if line.symbol is None:
            baseline += line.advance
            group.append(_text(line.text, box.x0 + line.indent, baseline, NOTE_SIZE))
            continue
        top = baseline + TEXT_DESCENT * NOTE_SIZE + 1.0
        group.append(_markup(SvgAnnotation(f"{line.note}-symbol", "texture",
                                           line.symbol.markup(box.x0 + line.indent, top, NOTE_SIZE))))
        baseline += line.advance
    return group


def _unique(kind: str, ids: Sequence[str]) -> None:
    for item in ids:
        if not ID.fullmatch(item):
            raise ValueError(f"{kind} id {item!r} must be lower-case letters, digits, '_' or '-'")
    duplicates = sorted({item for item in ids if list(ids).count(item) > 1})
    if duplicates:
        raise ValueError(f"{kind} ids are not unique: {duplicates}")


def compose_page(spec: SheetSpec, metadata: SheetMetadata, views: Sequence[ViewGeometry],
                 annotations: Sequence[SvgAnnotation], tables: Sequence[SvgTable],
                 notes: Sequence[SvgNote]) -> ComposedSheet:
    """Compose one page; raise ValueError for invalid content and CompositionError when furniture cannot fit.

    Views keep the sheet positions they were serialised with; overlaps, clipping and illegible
    text are left to ``check_layout``, which ``publish_package`` runs on every page.
    """
    if not 1 <= metadata.sheet_number <= metadata.sheet_count:
        raise ValueError(f"sheet {metadata.sheet_number} of {metadata.sheet_count} is out of range")
    if not math.isfinite(metadata.scale) or metadata.scale <= 0:
        raise ValueError(f"scale {metadata.scale} must be positive and finite")
    for name in ("drawing_number", "revision", "title", "document_type"):
        if not str(getattr(metadata, name)).strip():
            raise ValueError(f"sheet metadata {name} is empty")
    if not views:
        raise ValueError("a page needs at least one view")
    _unique("view", [view.view_id for view in views])
    _unique("annotation", [a.id for a in annotations] + [n.id for n in notes])
    _unique("table", [table.id for table in tables])
    for table in tables:
        if not table.columns or any(len(row) != len(table.columns) for row in table.rows):
            raise ValueError(f"table {table.id} rows must match its {len(table.columns)} columns")

    layout = page_layout(spec, tables, notes)
    root = _element("svg", {"width": f"{spec.width_mm:g}mm", "height": f"{spec.height_mm:g}mm",
                            "viewBox": f"0 0 {spec.width_mm:g} {spec.height_mm:g}"})
    root.append(_element("rect", {"id": "paper-background", "x": 0, "y": 0, "width": f"{spec.width_mm:g}",
                                  "height": f"{spec.height_mm:g}", "fill": "#fff"}))
    root.append(_frame(spec))
    title_block = _title_block(spec, metadata)
    for table in tables:
        title_block.append(_table_group(table, layout.tables[table.id]))
    root.append(title_block)
    root.append(_projection_symbol(spec.projection, spec.regions.symbol_cell))
    content = _element("g", {"id": "cad-drawing-content"})
    content.extend(_view_group(view) for view in views)
    annotation_group = _element("g", {"id": "cad-annotations"})
    annotation_group.extend(_markup(annotation) for annotation in annotations)
    if notes:
        annotation_group.append(_notes_group(spec.regime, layout))
    content.append(annotation_group)
    root.append(content)

    ET.register_namespace("", SVG_NS)
    values = _title_values(spec, metadata)
    required = tuple(values[name] for name in ("drawing_number", "revision", "title", "sheet", "material",
                                               "general_tolerance") if values[name])
    regions = SheetRegions(frame=spec.regions.frame, title_block=layout.title_region,
                           symbol_cell=spec.regions.symbol_cell)
    provenance = {**{a.id: dict(a.provenance) for a in annotations}, **{n.id: dict(n.provenance) for n in notes}}
    return ComposedSheet(spec=spec, metadata=metadata, svg=ET.tostring(root, encoding="unicode") + "\n",
                         regions=regions, placeholders=frozenset(), view_ids=tuple(v.view_id for v in views),
                         annotations=provenance, required_text=required)


def _check_identity(sheets: Sequence[ComposedSheet]) -> None:
    if not sheets:
        raise ValueError("a package needs at least one sheet")
    first = sheets[0].metadata
    for index, sheet in enumerate(sheets, start=1):
        meta = sheet.metadata
        if (meta.drawing_number, meta.revision) != (first.drawing_number, first.revision):
            raise ValueError(f"sheet {index} is {meta.drawing_number} rev {meta.revision}, not "
                             f"{first.drawing_number} rev {first.revision}")
        if (meta.sheet_number, meta.sheet_count) != (index, len(sheets)):
            raise ValueError(f"sheet {index} is numbered {meta.sheet_number} of {meta.sheet_count}; "
                             f"expected {index} of {len(sheets)}")


PACKAGE_MARKERS = ("package.json", "rejected.json")


def publish_package(context: DrawingContext, sheets: Sequence[ComposedSheet], report: CoverageReport,
                    output_dir: Path, freecadcmd: Path, timeout: float,
                    release: Sequence[Mapping[str, Any]] = (), jobs: int = 1, executor: Any = None,
                    bundle_path: Path | None = None) -> PackageReport:
    """Check and export one drawing into an empty draft folder; rejected output stays in .cad-work."""
    _check_identity(sheets)
    if timeout <= 0:
        raise ValueError("timeout must be positive")
    drawing_number = sheets[0].metadata.drawing_number
    provenance = context.provenance(drawing_number)
    if bundle_path is None:
        subject = "assembly" if sheets[0].metadata.document_type in ("Assembly drawing", "ASSEMBLY DRAWING") else drawing_number
        bundle_path = layout_api().bundle_dir(context.hw, "drawings", context.label, subject)
    output_dir = output_dir.resolve()
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    if output_dir.exists():
        if not output_dir.is_dir() or any(output_dir.iterdir()):
            raise ValueError(f"{output_dir} must be an empty draft folder")
    else:
        output_dir.mkdir()
    run_id = uuid.uuid4().hex
    retained = context.hw.parent / ".cad-work" / "rejected-drawings" / run_id
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = output_dir.parent / f".drawing-draft-{run_id}"
    staging.mkdir(parents=True, exist_ok=False)
    try:
        findings: list[dict[str, Any]] = [dict(f) for f in report.findings]
        layout_ok = True
        for sheet in sheets:
            number = sheet.metadata.sheet_number
            (staging / f"sheet-{number}.svg").write_text(sheet.svg, encoding="utf-8")
            violations = check_layout(sheet.svg, sheet.regions, sheet.placeholders)
            if violations:
                layout_ok = False
                findings.append({"code": "layout_check_failed", "sheet": number, "message": "; ".join(violations)})
        records: list[dict[str, Any]] = []
        if layout_ok:
            def export(sheet: ComposedSheet) -> tuple[dict[str, Any] | None, sheet_export.ExportError | None]:
                number = sheet.metadata.sheet_number
                paths = {kind: staging / f"sheet-{number}.{kind}" for kind in ("svg", "pdf", "png")}
                try:
                    exported = sheet_export.export_sheet(freecadcmd, paths["svg"], paths["pdf"], paths["png"],
                                                         sheet.required_text, timeout)
                except sheet_export.ExportError as exc:
                    return None, exc
                return {"sheet": number, "size": sheet.spec.size,
                        "files": {k: p.name for k, p in paths.items()},
                        "sha256": {k: sha256(p) for k, p in paths.items()}, "export": exported}, None

            exported_rows = freecad_runtime.map_jobs(sheets, jobs, export, executor)
            for sheet, (record, error) in zip(sheets, exported_rows):
                if error is not None:
                    findings.append({"code": error.code, "sheet": sheet.metadata.sheet_number, "message": str(error)})
                elif record is not None:
                    records.append(record)
        status = "pass" if not findings else ("error" if any(f["code"] == "export_failed" for f in findings) else "fail")
        reported_output = retained if status != "pass" else (
            bundle_path if bundle_path is not None else output_dir)
        result = PackageReport(hw=context.hw, status=status, run_id=run_id, output_dir=reported_output,
                               provenance=provenance, sheets=tuple(records), coverage=report.to_dict(),
                               findings=tuple(findings), release=tuple(dict(r) for r in release))
        if status == "pass":
            (staging / "coverage.json").write_text(json.dumps(report.to_dict(), indent=2) + "\n", encoding="utf-8")
            (staging / "package.json").write_text(json.dumps(result.to_dict(), indent=2) + "\n", encoding="utf-8")
        else:
            for path in list(staging.iterdir()):
                if path.suffix == ".pdf":
                    path.unlink()
                elif path.suffix in (".svg", ".png"):
                    path.rename(path.with_suffix(".rejected" + path.suffix))
            (staging / "rejected.json").write_text(json.dumps(result.to_dict(), indent=2) + "\n", encoding="utf-8")
        if not (staging / "rejected.json").is_file():
            for path in staging.iterdir():
                target = output_dir / path.name
                if target.exists():
                    raise ValueError(f"draft output collision: {target}")
                os.replace(path, target)
        return result
    finally:
        if (staging / "rejected.json").is_file():
            retained.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging, retained)
        else:
            shutil.rmtree(staging, ignore_errors=True)
