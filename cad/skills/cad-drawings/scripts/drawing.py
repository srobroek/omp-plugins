#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["defusedxml>=0.7.1", "pyyaml>=6.0", "jsonschema>=4.23"]
# ///
"""Generate checked, producer-ready part drawings from a built cad-model version.

Usage: drawing.py HW [--version vN|latest] --part PN [--part PN ...] [--output-dir DIR] [--replace]

Without --output-dir, publish each passing part package as an immutable drawing bundle at
hw/drawings/vN/<PN>/. An explicit --output-dir is accepted only under .cad-work/.

A catalogue part with a ``vendor_specification`` or ``source_control`` drawing gets a specification
sheet: its procurement identity, the critical interface dimensions measured from the vendor
envelope, and a note that the remaining geometry is illustrative. A catalogue part without drawing
intent needs no drawing; its procurement record is still checked.

stdout: JSON summary per part. Exit 0 every drawing passed, 1 a content check failed, 2 invalid input
or an infrastructure failure.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections.abc import Mapping, Sequence
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import completeness  # noqa: E402
import drawing_contract  # noqa: E402
import drawing_document  # noqa: E402
import drawing_intent  # noqa: E402
import feature_coverage  # noqa: E402
import feature_geometry as fg  # noqa: E402
import feature_recognition  # noqa: E402
import freecad_runtime  # noqa: E402
import part_views  # noqa: E402
import sheet  # noqa: E402
from drawing_document import CompositionError, SheetMetadata, SvgAnnotation, SvgNote, SvgTable  # noqa: E402
from freecad_views import ViewGeometry  # noqa: E402
from layout_check import Box  # noqa: E402
from section_hatch import CutRegion  # noqa: E402

TECHDRAW_JOB = Path(__file__).resolve().parent / "techdraw_job.py"
SCRIPTS = Path(__file__).resolve().parent
MAX_AUTO_SCALE = 10.0
MIN_AUTO_SCALE = 1 / 10
READABLE_EXTENT_MM = 60.0     # the largest view should span at least this on paper unless the part is tiny
VIEW_GAP = 12.0               # between the footprints of neighbouring views
DOCUMENT_TYPES = {"detail": "Detail drawing", "vendor_specification": "Vendor item specification",
                  "source_control": "Source control drawing"}


class DrawingError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = 1) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def fail(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"status": "error" if code in ("freecad_unavailable", "projection_failed", "io_error") else "fail",
            "error": {"code": code, "message": message}, **extra}


# --- FreeCAD jobs ---------------------------------------------------------------------------------

def run_job(freecadcmd: Path, job: dict[str, Any], workdir: Path, timeout: float) -> dict[str, Any]:
    data, message = freecad_runtime.run_job(freecadcmd, TECHDRAW_JOB, {**job, "scripts": str(SCRIPTS)}, workdir, timeout)
    if data is None:
        raise DrawingError("projection_failed", message, 2)
    return data


def view_jobs(plans: Sequence[part_views.ViewPlan], scales: Mapping[str, float], centres: Mapping[str, tuple[float, float]],
              details: Mapping[str, Mapping[str, Any]]) -> list[dict[str, Any]]:
    jobs = []
    for plan in plans:
        if plan.kind == "detail" and plan.id not in details:
            continue
        job = {"id": plan.id, "kind": plan.kind, "role": plan.role, "direction": list(plan.direction),
               "x_direction": list(plan.x_direction), "scale": scales[plan.id], "centre_mm": list(centres[plan.id]),
               "label": plan.label or ""}
        if plan.kind == "section":
            job.update(base=plan.base, section={"origin": list(plan.section["origin"]), "normal": list(plan.section["normal"])})
        if plan.kind == "detail":
            job.update(base=plan.base, detail=details[plan.id])
        jobs.append(job)
    return jobs


def view_data(result: Mapping[str, Any], plans: Sequence[part_views.ViewPlan],
              clip: Mapping[str, float] | None = None) -> dict[str, sheet.ViewData]:
    found = {}
    for plan in plans:
        entry = result["views"].get(plan.id)
        if entry is None:
            continue
        found[plan.id] = sheet.ViewData(
            plan=plan, geometry=ViewGeometry.from_dict(entry["geometry"]), affine=entry["affine"],
            cut_faces={int(k): v for k, v in entry.get("cut_faces", {}).items()},
            cut_regions=tuple(CutRegion.from_dict(r) for r in entry.get("cut_regions", [])),
            clip_radius=(clip or {}).get(plan.id))
    return found


# --- planning ---------------------------------------------------------------------------------------

def scale_candidates(intent_scale: str | None, product_scale: str | None) -> list[float]:
    fixed = part_views.parse_scale(intent_scale or product_scale or "auto")
    if fixed is not None:
        return [fixed]
    return [s for s in drawing_document.STANDARD_SCALES if MIN_AUTO_SCALE - 1e-9 <= s <= MAX_AUTO_SCALE + 1e-9]


def detail_setup(plan: part_views.ViewPlan, base: sheet.ViewData, measured: drawing_intent.Measured,
                 binding: fg.Binding, faces: Mapping[int, fg.Face]) -> dict[str, Any]:
    """Detail centre (an outline point of the feature in the base view) and its model radius."""
    feature = binding.features[plan.detail["feature"]]
    points = sheet.visible_points([faces[i] for i in feature.faces], base)
    if not points:
        raise DrawingError("feature_not_presentable", f"detail {plan.id}: {feature.id} has no visible outline in "
                           f"{plan.base}")
    box = base.bounds()
    model, at = min(points, key=lambda mp: min(mp[1][1] - box.y0, box.y1 - mp[1][1], mp[1][0] - box.x0, box.x1 - mp[1][0]))
    sizes = [c.value for c in measured.characteristics if c.feature == feature.id and c.value > 0
             and c.operation in ("width", "diameter", "radius", "chamfer", "depth", "across_flats")]
    radius = max(0.8, 1.6 * min(sizes)) if sizes else 3.0
    return {"centre": model, "radius_model": radius, "pivot": at}


def plan_layout(plans: Sequence[part_views.ViewPlan], probe: Mapping[str, sheet.ViewData],
                details: Mapping[str, Mapping[str, Any]], presentation_for: Any, spec: drawing_document.SheetSpec,
                scale: float, text: float, regime: str, notes: Sequence[SvgNote], tables: Sequence[SvgTable],
                reserved: Sequence[str] = (), relax: bool = False,
                ) -> tuple[list[part_views.ViewPlan], dict[str, tuple[float, float]], dict[str, float]] | None:
    """The plans and view centres, each view on its own sheet's ``spec`` at ``scale``, when every sheet's views,
    annotations and furniture fit; the notes and tables go on sheet 1. One presentation over every view assigns
    each characteristic to one view, so a dimension appears once in the whole package.

    With ``relax`` a sheet that does not fit is relieved one view at a time (``_relieve``) until every sheet
    fits: more sheets of this size rather than a larger, emptier one."""
    plans = list(plans)
    while True:
        planned = _layout_sheets(plans, probe, details, presentation_for, spec, scale, text, regime, notes, tables)
        if isinstance(planned, tuple):
            return plans, *planned
        relieved = _relieve(plans, planned, spec.projection, reserved) if relax and planned is not None else None
        if relieved is None:
            return None
        plans = relieved


def _layout_sheets(plans: Sequence[part_views.ViewPlan], probe: Mapping[str, sheet.ViewData],
                   details: Mapping[str, Mapping[str, Any]], presentation_for: Any, spec: drawing_document.SheetSpec,
                   scale: float, text: float, regime: str, notes: Sequence[SvgNote], tables: Sequence[SvgTable],
                   ) -> tuple[dict[str, tuple[float, float]], dict[str, float]] | int | None:
    """The view centres and scales when every sheet fits; else the number of the first sheet that does not, or
    None when the sheet furniture itself does not fit."""
    scales, placed = {}, {}
    for plan in plans:
        if plan.kind == "detail":
            setup = details[plan.id]
            base = probe[plan.base]
            detail_scale = part_views.parse_scale(plan.scale) or _detail_scale(scale, setup["radius_model"])
            scales[plan.id] = detail_scale
            placed[plan.id] = base.placed(detail_scale, (0.0, 0.0), pivot=setup["pivot"], plan=plan,
                                          clip_radius=setup["radius_model"] * detail_scale)
        else:
            view_scale = part_views.parse_scale(plan.scale) or scale
            scales[plan.id] = view_scale
            placed[plan.id] = probe[plan.id].placed(view_scale, (0.0, 0.0), plan=plan)
    presentation = presentation_for(placed)
    footprints = {view_id: sheet.layout_view(view, presentation, text, regime,
                                             [p for p in plans if p.base == view_id]).footprint
                  for view_id, view in placed.items()}
    centres: dict[str, tuple[float, float]] = {}
    principal = next(p.id for p in plans if p.relation == "front")
    for number in sorted({p.sheet for p in plans}):
        try:
            layout = drawing_document.page_layout(spec, tables if number == 1 else [], notes if number == 1 else [])
        except CompositionError:
            return None
        region = Box(layout.drawing_area.x0, layout.drawing_area.y0, layout.drawing_area.x1,
                     min(o.y0 for o in layout.obstacles) - VIEW_GAP / 2)
        here = [p for p in plans if p.sheet == number]
        placed_here = arrange(here, footprints, spec.projection, region, any(p.id == principal for p in here))
        if placed_here is None:
            return number
        centres.update(placed_here)
    return centres, scales


def _relieve(plans: Sequence[part_views.ViewPlan], number: int, projection: str, reserved: Sequence[str]
             ) -> list[part_views.ViewPlan] | None:
    """One step toward fitting sheet ``number``: on the principal's sheet a projected view not next to the
    principal (the rear view) leaves the projection grid, lettered with a reference arrow, so it can be packed;
    else the sheet's last other view moves to the next sheet. Views next to the principal keep their
    projected places on its sheet. None when the sheet holds one view, or only views that cannot move."""
    if sum(1 for p in plans if p.sheet == number) < 2:
        return None   # a view that fits no sheet of this size alone
    here = [p for p in plans if p.sheet == number and p.relation != "front"]
    if number == next(p.sheet for p in plans if p.relation == "front"):
        for plan in here:
            cell = part_views.grid_cell(plan.relation, projection)
            moved = part_views.relocated(plans, plan.id, reserved) if cell and sum(map(abs, cell)) > 1 else None
            if moved is not None:
                return moved
    for plan in reversed(here):
        moved = part_views.relocated(plans, plan.id, reserved, sheet=number + 1)
        if moved is not None:
            return moved
    return None


def _detail_scale(scale: float, radius_model: float) -> float:
    """The largest standard scale, at least twice the sheet scale, that keeps the detail circle within ~22 mm radius."""
    target = 22.0 / radius_model
    options = [s for s in drawing_document.STANDARD_SCALES if 2 * scale - 1e-9 <= s <= target + 1e-9]
    if options:
        return max(options)
    return min((s for s in drawing_document.STANDARD_SCALES if s >= 2 * scale - 1e-9), default=2 * scale)


def arrange(plans: Sequence[part_views.ViewPlan], footprints: Mapping[str, Box], projection: str,
            region: Box, principal: bool = True) -> dict[str, tuple[float, float]] | None:
    """Projection-aligned grid placement, the views out of it packed beside the grid, the whole centred.

    On the principal's sheet adjacent projected views share the principal's rows and columns; every other
    view (a lettered view, a section or detail with no projected place, or any view on another sheet) goes
    to the free place nearest the top left, largest first, so the views fill the sheet."""
    cells: dict[str, tuple[int, int]] = {}
    for plan in plans:
        cell = part_views.grid_cell(plan.relation, projection) if principal else None
        if cell is not None and cell not in cells.values():
            cells[plan.id] = cell
    occupied: list[Box] = []
    centres: dict[str, tuple[float, float]] = {}
    if cells:
        columns = sorted({c for c, _ in cells.values()})
        rows = sorted({r for _, r in cells.values()})
        left = {c: max(-footprints[v].x0 for v, (cc, _) in cells.items() if cc == c) for c in columns}
        right = {c: max(footprints[v].x1 for v, (cc, _) in cells.items() if cc == c) for c in columns}
        top = {r: max(-footprints[v].y0 for v, (_, rr) in cells.items() if rr == r) for r in rows}
        bottom = {r: max(footprints[v].y1 for v, (_, rr) in cells.items() if rr == r) for r in rows}
        column_x, row_y, x, y = {}, {}, region.x0, region.y0
        for c in columns:
            column_x[c] = x + left[c]
            x += left[c] + right[c] + VIEW_GAP
        for r in rows:
            row_y[r] = y + top[r]
            y += top[r] + bottom[r] + VIEW_GAP
        for view, (c, r) in cells.items():
            centres[view] = (column_x[c], row_y[r])
            occupied.append(_shifted(footprints[view], centres[view]))
    free = sorted((p.id for p in plans if p.id not in cells),
                  key=lambda v: -(footprints[v].x1 - footprints[v].x0) * (footprints[v].y1 - footprints[v].y0))
    for view in free:
        corner = _free_corner(footprints[view], occupied, region)
        if corner is None:
            return None
        centres[view] = (corner[0] - footprints[view].x0, corner[1] - footprints[view].y0)
        occupied.append(_shifted(footprints[view], centres[view]))
    used = occupied[0]
    for box in occupied[1:]:
        used = used.union(box)
    if used.x1 > region.x1 + 1e-6 or used.y1 > region.y1 + 1e-6:
        return None
    dx = region.x0 + (region.x1 - region.x0 - (used.x1 - used.x0)) / 2 - used.x0
    dy = region.y0 + (region.y1 - region.y0 - (used.y1 - used.y0)) / 2 - used.y0
    return {view: (x + dx, y + dy) for view, (x, y) in centres.items()}


def _shifted(box: Box, centre: tuple[float, float]) -> Box:
    return Box(box.x0 + centre[0], box.y0 + centre[1], box.x1 + centre[0], box.y1 + centre[1])


def _free_corner(footprint: Box, occupied: Sequence[Box], region: Box) -> tuple[float, float] | None:
    """The top-left corner nearest the region's top left where ``footprint`` fits clear of the occupied boxes by
    VIEW_GAP: candidates at the region's corner and beside or below each occupied box."""
    width, height = footprint.x1 - footprint.x0, footprint.y1 - footprint.y0
    xs = {region.x0, *(b.x1 + VIEW_GAP for b in occupied)}
    ys = {region.y0, *(b.y1 + VIEW_GAP for b in occupied)}
    for y, x in sorted((y, x) for x in xs for y in ys):
        if x + width > region.x1 + 1e-6 or y + height > region.y1 + 1e-6:
            continue
        if all(x + width + VIEW_GAP <= b.x0 or b.x1 + VIEW_GAP <= x or y + height + VIEW_GAP <= b.y0
               or b.y1 + VIEW_GAP <= y for b in occupied):
            return x, y
    return None


def text_size(spec: drawing_document.SheetSpec) -> float:
    """ISO 3098 / ASME Y14.2 lettering: 2.5 mm on A4 and ANSI A, 3.5 mm on larger sheets."""
    return 2.5 if spec.size in ("A4", "ANSI A") else 3.5


# --- notes and identity -------------------------------------------------------------------------------

def sheet_notes(context: drawing_contract.DrawingContext, part: drawing_contract.PartContext,
                measured: drawing_intent.Measured, regime: str) -> list[SvgNote]:
    record = part.record
    drawing = record.get("drawing") or {}
    product_drawing = context.product.get("drawing") or {}
    standards = product_drawing.get("standards") or {}
    asme = regime == "asme"
    notes = []
    policy = measured_policy(context, record)
    if policy is not None:
        if asme:
            notes.append(SvgNote("general-tolerance", f"UNLESS OTHERWISE SPECIFIED: DIMENSIONS IN MILLIMETERS; "
                                 f"TOLERANCES {policy.label.upper()}; INTERPRET PER {standards.get('dimensioning', 'ASME Y14.5')}.",
                                 {"policy": policy.name}))
        else:
            gps = standards.get("gps_fundamentals", "ISO 8015")
            notes.append(SvgNote("general-tolerance", f"General tolerances {policy.label}"
                                 f"{' (' + policy.reference + ')' if policy.kind == 'limits' and policy.reference else ''}; "
                                 f"tolerancing {gps}. Dimensions in mm.", {"policy": policy.name}))
    if any(c.tolerance is not None and c.tolerance.kind == "fit" for c in measured.characteristics):
        notes.append(SvgNote("fits", ("FITS PER ASME B4.2 / " if asme else "Fits and limits per ") +
                             standards.get("fits", "ISO 286-1") + "."))
    profiles = [c for c in measured.characteristics if c.operation == "profile"]
    if profiles:
        notes.append(SvgNote("model", (f"SURFACES WITHOUT DIMENSIONS ARE DEFINED BY STEP {part.step.name} "
                                       f"SHA256 {part.step_sha256[:16]}." if asme else
                                       f"Surfaces without dimensions are defined by STEP {part.step.name} "
                                       f"(sha256 {part.step_sha256[:16]}) within their profile tolerance."),
                             {"step_sha256": part.step_sha256}))
    manufacturing = drawing.get("manufacturing") or {}
    if manufacturing.get("dimensions_apply"):
        text = "Dimensions apply " + manufacturing["dimensions_apply"].replace("_", " ") + "."
        notes.append(SvgNote("finish-stage", text.upper() if asme else text))
    for step in manufacturing.get("post_processing", []):
        notes.append(SvgNote(f"post-{len(notes)}", step))
    features = (drawing.get("features") or {}).values()
    if "edges" in drawing:
        exceptions = any("edges" in intent for intent in features)
        notes.append(SvgNote("edges", sheet.edge_note(drawing["edges"], regime, exceptions), {"kind": "edge"}))
    general = [c for c in measured.characteristics if c.presentation == sheet.GENERAL_NOTE]
    if general:   # edge fillets and edge breaks the drawing states once, for every face they apply to
        notes.append(SvgNote(sheet.GENERAL_NOTE_ID, sheet.general_edges_note(general, regime), {"kind": "general_edges"}))
    if "surface_texture" in drawing:
        notes.append(texture_note(drawing["surface_texture"], regime, standards,
                                  any("surface_texture" in intent for intent in features)))
    for index, note in enumerate(drawing.get("notes", [])):
        text = note["text"].upper() if asme else note["text"]
        notes.append(SvgNote(f"note-{index + 1}", text, {"kind": note["kind"]}))
    return notes


def texture_note(texture: Mapping[str, Any], regime: str, standards: Mapping[str, str], others: bool) -> SvgNote:
    """The general surface texture (ISO 21920-1 §9.1.2, ASME Y14.36 §5.1) near the title block, or why it is open.

    ``others``: some features carry their own requirement, so the ISO indication ends in the basic symbol
    in parentheses.
    """
    asme = regime == "asme"
    standard = standards.get("surface_texture", "ASME Y14.36" if asme else "ISO 21920-1")
    if "open" in texture:
        text = f"Surface texture {standard}: OPEN, {texture['open']}."
        return SvgNote("surface-texture", text.upper() if asme else text, {"kind": "surface_texture", "open": "true"})
    symbol = replace(sheet.TextureSymbol.of(texture), others=others and not asme)
    text = (f"UNLESS OTHERWISE SPECIFIED, SURFACE TEXTURE PER {standard}:" if asme
            else f"Surface texture {standard}, unless otherwise indicated:")
    return SvgNote("surface-texture", text, {"kind": "surface_texture"}, symbol)


def measured_policy(context: drawing_contract.DrawingContext, record: Mapping[str, Any]) -> drawing_intent.Policy | None:
    """The general tolerance policy of a detail drawing; a vendor item's sheet has none."""
    drawing = record.get("drawing") or {}
    if drawing.get("type") in drawing_intent.VENDOR_TYPES:
        return None
    defined = drawing_intent.policies(context.product)
    name = drawing.get("tolerance_policy") or (context.product.get("drawing") or {}).get("general_tolerance_policy")
    return defined.get(name) if name else None


def metadata(context: drawing_contract.DrawingContext, part: drawing_contract.PartContext, scale: float,
             number: int, count: int) -> SheetMetadata:
    record = part.record
    drawing = record.get("drawing") or {}
    policy = measured_policy(context, record)
    vendor = drawing.get("type") in drawing_intent.VENDOR_TYPES
    standards = tuple((context.product.get("drawing") or {}).get("standards", {}).values())
    general = policy.label if policy else ("per specification" if vendor else str(context.product["general_tolerance"]))
    return SheetMetadata(drawing_number=part.pn, revision=str(record["rev"]), title=str(record["title"]),
                         document_type=DOCUMENT_TYPES[drawing.get("type", "detail")], sheet_number=number,
                         sheet_count=count, scale=scale, material=str(record["material"]),
                         general_tolerance=general, standards=standards[:4])


def procurement_findings(record: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Content failures of a catalogue item's orderable identity; a field declared ``open`` is a release blocker.

    A standard part is ordered by the designation of its product standard (``procurement.standard``, such as
    DIN 471 - 5x0.6), which any conforming source satisfies; it needs no manufacturer or part number.
    """
    procurement = record.get("procurement") or {}
    found = []
    if procurement.get("mode") == "catalog":
        declared = {**procurement.get("open", {}), **procurement}
        if not procurement.get("designation"):
            found.append(drawing_intent.finding("procurement_incomplete", "a catalogue item needs a designation"))
        for field in () if procurement.get("standard") else ("manufacturer", "manufacturer_part_number"):
            if not declared.get(field):
                found.append(drawing_intent.finding("procurement_incomplete", f"a catalogue item needs its {field}, "
                                                    f"a procurement.open entry giving why it is open, or the "
                                                    f"designation of a product standard in procurement.standard"))
        if not procurement.get("specification"):
            found.append(drawing_intent.finding("procurement_incomplete", "a catalogue item needs its specification "
                                                "(reference, revision, sha256 and an artifact under hw/ or a url)"))
        if (record.get("drawing") or {}).get("type") == "source_control":
            if not procurement.get("approved_sources") or not procurement.get("qualification_evidence"):
                found.append(drawing_intent.finding("procurement_incomplete", "a source control drawing needs approved "
                                                    "sources and qualification evidence"))
    return found


def procurement_table(record: Mapping[str, Any]) -> SvgTable:
    procurement = record.get("procurement") or {}
    spec = procurement.get("specification") or {}
    open_fields = procurement.get("open", {})

    def cell(field: str) -> str:
        return procurement.get(field) or (f"OPEN: {open_fields[field]}" if field in open_fields else "—")

    rows = [("Designation", cell("designation"))]
    if "standard" in procurement:
        rows.append(("Standard", procurement["standard"]))
    rows += [("Manufacturer", cell("manufacturer")), ("Manufacturer PN", cell("manufacturer_part_number")),
             ("Supplier PN", cell("supplier_part_number")),
             ("Specification", f"{spec.get('reference', '—')} rev {spec.get('revision', '—')}"),
             ("Spec. sha256", spec.get("sha256", "—")[:16])]
    for source in procurement.get("approved_sources", []):
        rows.append(("Approved source", f"{source['name']} {source.get('part_number', '')}".strip()))
    return SvgTable("procurement", ("Procurement", "Value"), tuple(rows))


def sourcing_note(record: Mapping[str, Any]) -> SvgNote | None:
    """A specification known only by url and hash is a sourcing input the record does not hold."""
    spec = (record.get("procurement") or {}).get("specification") or {}
    if not spec or "artifact" in spec:
        return None
    return SvgNote("sourcing", f"Specification {spec['reference']} rev {spec['revision']} is a sourcing input kept "
                               f"outside this record: {spec['url']} (sha256 {spec['sha256'][:16]}).")


# --- one part -------------------------------------------------------------------------------------------

def run_part(context: drawing_contract.DrawingContext, pn: str, output_dir: Path, freecadcmd: Path,
             timeout: float, bundle_path: Path | None = None) -> tuple[dict[str, Any], int]:
    part = context.part(pn)
    record = part.record
    drawing = record.get("drawing")
    regime = context.product["regime"]
    procurement = procurement_findings(record)
    if not drawing and (record.get("procurement") or {}).get("mode") == "catalog":
        status = "fail" if procurement else "not_required"
        blockers = completeness.release_blockers(record)
        return {"pn": pn, "status": status, "findings": procurement,
                "release": {"ready": not blockers, "blockers": blockers}}, 1 if procurement else 0
    work = output_dir.parent / f".{output_dir.name}.work-{uuid.uuid4().hex}"
    work.mkdir(parents=True)
    try:
        bound = run_job(freecadcmd, {"mode": "bind", "step": str(part.step), "locators": part.features or {}},
                        work, timeout)
        recognition = feature_recognition.Recognition.from_dict(bound["recognized"])
        missing = ("part.yaml has no drawing intent" if not drawing else
                   "model.py defines no drawing_features hook" if part.features is None else None)
        if missing is not None:   # never a sheet, and never silence: name what the drawing must dimension
            return fail("drawing_intent_missing", f"{pn}: {missing}; run drawing_draft.py for a proposal",
                        pn=pn, findings=feature_coverage.undimensioned(recognition, missing),
                        recognized=[item.describe() for item in recognition.features]), 1
        vendor = drawing["type"] in drawing_intent.VENDOR_TYPES
        faces = [fg.Face.from_dict(f) for f in bound["faces"]]
        face_map = {f.index: f for f in faces}
        binding = fg.resolve(part.features, bound["bound"], faces)
        if vendor:
            binding = fg.Binding(binding.features, binding.owner,
                                 tuple(f for f in binding.findings if f["code"] != "geometry_unaccounted"))
        measured = drawing_intent.measure(pn, record, context.product, context.interfaces, binding, faces)
        if measured.frame is None:
            report = completeness.evaluate(pn, record, context.interfaces, binding, measured, None, part.step_sha256,
                                           recognition=recognition, faces=face_map)
            return {"pn": pn, "status": "fail", "coverage": report.to_dict()}, 1
        plans = part_views.plan_views(drawing, measured.frame, binding.features, face_map)
        result, code = compose_and_publish(context, part, drawing, regime, binding, face_map, measured, plans,
                                           procurement, vendor, output_dir, freecadcmd, timeout, work, recognition,
                                           bundle_path)
        return result, code
    except drawing_intent.IntentError as exc:
        return fail(exc.code, str(exc), pn=pn), 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


def compose_and_publish(context: drawing_contract.DrawingContext, part: drawing_contract.PartContext,
                        drawing: Mapping[str, Any], regime: str, binding: fg.Binding, faces: Mapping[int, fg.Face],
                        measured: drawing_intent.Measured, plans: list[part_views.ViewPlan],
                        procurement: list[dict[str, Any]], vendor: bool, output_dir: Path, freecadcmd: Path,
                        timeout: float, work: Path, recognition: feature_recognition.Recognition,
                        bundle_path: Path | None = None) -> tuple[dict[str, Any], int]:
    record = part.record
    sizes = (drawing.get("sheet") or {}).get("sizes") or \
        ((context.product.get("drawing") or {}).get("default_sheet") or {}).get("sizes") or \
        list(drawing_document.REGIME_SIZES[regime][:3])
    specs = drawing_document.sheet_specs(context.product, sizes)
    probe_spec = drawing_document.sheet_specs({**context.product, "drawing": {
        **(context.product.get("drawing") or {}), "default_sheet": {"orientation": "landscape"}}},
        ["A0"])[0] if regime == "iso" else drawing_document.sheet_specs(context.product, ["ANSI E"])[0]
    template = work / "probe-page.svg"
    template.write_text(probe_spec.page_template_svg(), encoding="utf-8")
    centre = (probe_spec.width_mm / 2, probe_spec.height_mm / 2)
    probe_plans = [p for p in plans if p.kind != "detail"]
    probe_result = run_job(freecadcmd, {"mode": "views", "step": str(part.step), "page_template": str(template),
                                        "sheet_height_mm": probe_spec.height_mm,
                                        "views": view_jobs(probe_plans, {p.id: 1.0 for p in probe_plans},
                                                           {p.id: centre for p in probe_plans}, {})}, work, timeout)
    probe = view_data(probe_result, plans)
    details = {}
    for index, plan in enumerate(plans):
        if plan.kind == "detail":
            setup = detail_setup(plan, probe[plan.base], measured, binding, faces)
            details[plan.id] = setup
            plans[index] = replace(plan, detail={**plan.detail, "centre": setup["centre"],
                                                 "radius_model": setup["radius_model"]})
    plans_by_id = {p.id: p for p in plans}
    intents = drawing.get("features") or {}
    notes = sheet_notes(context, part, measured, regime)
    tables = [procurement_table(record)] if vendor else []
    if vendor:
        notes.insert(0, SvgNote("vendor", ("DIMENSIONS IN MILLIMETERS. ONLY DIMENSIONED INTERFACES ARE CONTROLLED, TO THE "
                                        "ITEM SPECIFICATION; ENVELOPE GEOMETRY IS ILLUSTRATIVE, AND EDGES AND SURFACE "
                                        "TEXTURE ARE AS SUPPLIED TO THAT SPECIFICATION. DO NOT MANUFACTURE TO THIS SHEET."
                                        if regime == "asme" else
                                        "Dimensions in mm. Only the dimensioned interfaces are controlled, to the item's "
                                        "specification; the envelope geometry is illustrative, and edges and surface "
                                        "texture are as supplied to that specification. Do not manufacture to this "
                                        "sheet.")))
    sourcing = sourcing_note(record)
    if sourcing is not None:
        notes.append(sourcing)

    def presentation_for(views: Mapping[str, sheet.ViewData]) -> sheet.Presentation:
        return sheet.build_presentation(measured.characteristics, measured.frame, binding.features, faces, views,
                                        regime, measured.geometric, intents)

    chosen = None
    product_scale = ((context.product.get("drawing") or {}).get("default_sheet") or {}).get("scale")
    candidates = scale_candidates((drawing.get("sheet") or {}).get("scale"), product_scale)
    fallback = None
    reserved = list(measured.frame.datums)
    for spec in specs:
        text = text_size(spec)
        # every view in its projected place first; only when no allowed scale fits that way, more sheets of
        # this size (``plan_layout`` relax) before a larger, emptier sheet
        for relax in (False, True):
            fitted = False
            for scale in candidates:
                planned = plan_layout(plans, probe, details, presentation_for, spec, scale, text, regime, notes,
                                      tables, reserved, relax)
                if planned is None:
                    continue
                fitted = True
                extent = max(max(b.x1 - b.x0, b.y1 - b.y0) for b in (probe[p.id].bounds() for p in probe_plans)) * scale
                fallback = fallback or (spec, scale, planned)
                if extent >= READABLE_EXTENT_MM or scale >= MAX_AUTO_SCALE - 1e-9 or len(candidates) == 1:
                    chosen = (spec, scale, planned)
                break
            if fitted:
                break
        if chosen is not None:
            break
    chosen = chosen or fallback
    if chosen is None:
        coverage = completeness.evaluate(part.pn, record, context.interfaces, binding, measured, None, part.step_sha256,
                                         recognition=recognition, faces=faces)
        return {"pn": part.pn, "status": "fail", "error": {"code": "sheet_no_fit", "message":
                f"no allowed sheet {sizes} and scale fits the views and annotations"},
                "coverage": coverage.to_dict()}, 1
    spec, scale, (plans, centres, scales) = chosen
    plans_by_id = {p.id: p for p in plans}
    page = work / "page.svg"
    page.write_text(spec.page_template_svg(), encoding="utf-8")
    final_details = {}
    for view_id, setup in details.items():
        base = probe[plans_by_id[view_id].base]
        cx, cy = base.geometry.centre_mm
        px, py = setup["pivot"]
        final_details[view_id] = {"anchor_view": [(px - cx) / base.geometry.scale, -(py - cy) / base.geometry.scale, 0.0],
                                  "radius_mm": setup["radius_model"]}
    final = run_job(freecadcmd, {"mode": "views", "step": str(part.step), "page_template": str(page),
                                 "sheet_height_mm": spec.height_mm,
                                 "views": view_jobs(plans, scales, centres, final_details)}, work, timeout)
    views = view_data(final, plans, {v: details[v]["radius_model"] * scales[v] for v in details})
    text = text_size(spec)
    presentation = presentation_for(views)
    numbers = sorted({p.sheet for p in plans})
    annotations: dict[int, list[SvgAnnotation]] = {number: [] for number in numbers}
    sections = []
    for view in views.values():
        children = [p for p in plans if p.base == view.plan.id and p.id in views]
        layout = sheet.layout_view(view, presentation, text, regime, children)
        annotations[view.plan.sheet].extend(layout.annotations)
        if layout.section is not None:
            sections.append(layout.section)
        lines = sheet.centre_lines(view, binding.features, faces)
        if lines is not None:
            annotations[view.plan.sheet].append(lines)
    report = completeness.evaluate(part.pn, record, context.interfaces, binding, measured, presentation, part.step_sha256,
                                   sections, recognition=recognition, faces=faces)
    if procurement:
        report = replace(report, status="fail", findings=(*report.findings, *procurement))
    pages = []
    try:
        for number in numbers:   # the notes and tables go on sheet 1, the title block on every sheet
            pages.append(drawing_document.compose_page(
                spec, metadata(context, part, scale, number, len(numbers)),
                [v.geometry for v in views.values() if v.plan.sheet == number], annotations[number],
                tables if number == 1 else [], notes if number == 1 else []))
    except (CompositionError, ValueError) as exc:
        return fail(getattr(exc, "code", "layout_check_failed"), str(exc), pn=part.pn), 1
    package = drawing_document.publish_package(context, pages, report, output_dir, freecadcmd, timeout,
                                               completeness.release_blockers(record),
                                               bundle_path=bundle_path if report.status == "pass" else output_dir)
    retained_dir = package.output_dir if package.exit_code != 0 else output_dir
    previews = sorted(str(retained_dir / p.name) for p in retained_dir.glob("*.png"))
    summary = {"pn": part.pn, "status": package.status, "type": drawing["type"], "sheet": spec.size,
               "sheets": len(numbers), "scale": drawing_document.scale_text(regime, scale),
               "output_dir": str(package.output_dir), "run_id": package.run_id,
               "views": [p.id for p in plans], "characteristics": len(measured.characteristics),
               "findings": [dict(f) for f in package.findings],
               "release": {"ready": not package.release, "blockers": [dict(r) for r in package.release]},
               "previews": previews}
    return summary, package.exit_code




def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("hw", type=Path, help="the hardware project's hw/ folder")
    parser.add_argument("--version", help="built version label (default: versions/latest.json)")
    parser.add_argument("--part", action="append", required=True, help="part number; repeat for several parts")
    parser.add_argument("--output-dir", type=Path, help="write scratch packages under .cad-work only")
    parser.add_argument("--replace", action="store_true", help="retain and replace conflicting bundles")
    parser.add_argument("--timeout", type=float, default=300.0, help="seconds per FreeCAD job")
    parser.add_argument("--jobs", type=int, help="maximum concurrent FreeCAD jobs (default: CPU and memory bound)")
    args = parser.parse_args(argv)
    if args.jobs is not None and args.jobs < 1:
        parser.error("--jobs must be a positive integer")
    if len(set(args.part)) != len(args.part):
        print(json.dumps(fail("invalid_input", "--part values must be unique because each part has one output package"), indent=2))
        return 2
    hw = args.hw.resolve()
    api = drawing_contract.layout_api()
    try:
        label, version_dir, _ = api.built_version(hw, args.version or "latest")
        context = drawing_contract.load_context(hw, version_dir)
        output_root = api.scratch_path(hw, args.output_dir, "--output-dir") if args.output_dir else None
        if output_root is not None and output_root.exists():
            raise api.LayoutError(f"--output-dir already exists and will not be overwritten: {output_root}")
    except (api.LayoutError, drawing_contract.ContractError, OSError, KeyError, ValueError) as exc:
        print(json.dumps(fail(getattr(exc, "code", "invalid_input"), str(exc),
                              findings=[dict(f) for f in getattr(exc, "findings", ())]), indent=2))
        return 1 if getattr(exc, "code", None) == "invalid_drawing_intent" else 2
    freecadcmd = freecad_runtime.find_freecadcmd()
    if freecadcmd is None or not freecadcmd.is_file():
        print(json.dumps(fail("freecad_unavailable", "freecadcmd not found; set FREECADCMD or put freecadcmd on PATH")))
        return 2
    if output_root is not None and len(args.part) > 1:
        try:
            output_root.mkdir(parents=True, exist_ok=False)
        except OSError as exc:
            print(json.dumps(fail("io_error", str(exc)), indent=2))
            return 2
    jobs = freecad_runtime.jobs_for(args.jobs, len(args.part), freecad_runtime.FREECAD_JOB_PEAK_RSS_BYTES)

    def draw_part(pn: str) -> tuple[dict[str, Any], int]:
        subject = pn
        recipe = {"part": pn, "provenance": context.provenance(pn)}
        try:
            if output_root is None:
                existing = api.reusable(hw, "bundle.drawings", {"V": label, "S": subject}, recipe,
                                        replace=args.replace)
                if existing is not None:
                    return {"pn": pn, "status": "pass", "cache": "hit", "output_dir": str(existing)}, 0
                draft = api.staging(hw, "bundle.drawings")
            else:
                draft = output_root if len(args.part) == 1 else output_root / pn
                if draft.exists():
                    return fail("output_exists", f"--output-dir already exists and will not be overwritten: {draft}",
                                pn=pn), 2
                draft.parent.mkdir(parents=True, exist_ok=True)
                draft.mkdir()
            bundle_path = api.bundle_dir(hw, "drawings", label, subject) if output_root is None else draft
            result, code = run_part(context, pn, draft, freecadcmd, args.timeout, bundle_path)
            if code != 0:
                result.setdefault("output_dir", str(draft))
                rejected = draft / "rejected.json"
                if not rejected.exists():
                    rejected.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            elif result.get("status") == "pass" and output_root is None:
                result["output_dir"] = str(api.publish(
                    hw, "bundle.drawings", {"V": label, "S": subject}, draft, recipe=recipe,
                    producer="cad-drawings drawing.py", status="pass", replace=args.replace).path)
            return result, code
        except api.PublishConflict as exc:
            return fail("publish_conflict", str(exc), pn=pn), 2
        except drawing_contract.ContractError as exc:
            return fail(exc.code, str(exc), pn=pn), 2
        except DrawingError as exc:
            return fail(exc.code, str(exc), pn=pn), exc.exit_code
        except (OSError, ValueError, KeyError) as exc:
            return fail("io_error", str(exc), pn=pn), 2
    try:
        with freecad_runtime.terminate_jobs_on_signal():
            outcomes = freecad_runtime.map_jobs(args.part, jobs, draw_part)
    except freecad_runtime.JobInterrupted as exc:
        print(json.dumps(fail("interrupted", str(exc)), indent=2))
        return 128 + exc.signum
    results = [result for result, _ in outcomes]
    status = max((code for _, code in outcomes), default=0)
    print(json.dumps({"version": label, "parts": results}, indent=2, default=str))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
