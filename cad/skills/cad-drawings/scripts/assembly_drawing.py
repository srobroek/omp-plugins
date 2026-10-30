#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "defusedxml>=0.7.1", "jsonschema>=4.23", "pyyaml>=6.0"]
# ///
"""Generate the checked assembly drawing package of a built cad-model version.

    assembly_drawing.py HW --version vN|latest [--output-dir DIR] [--replace] [--timeout SECONDS]

The default output is an immutable `hw/drawings/vN/assembly/` bundle. Explicit output directories
are scratch only and must be under `.cad-work/`. A rejected default draft remains in `.cad-work`.

One package of ``assembly.yaml`` ``drawing``: sheet 1 draws the whole assembly, then one sheet per
``subassembly_sheets`` group, each with its assembled and exploded views, item balloons, a parts
list generated from ``bom.csv`` and numbered assembly notes. Stages, each failing with a package
failure code:

1. ``drawing_contract.load_context`` verifies the record and the version's hashes.
2. ``assembly_geometry.read_assembly`` binds every occurrence to its component of the version's
   ``assembly.step``; ``assembly_check.reconcile`` binds items, quantities, BOM and operations.
3. A FreeCAD job measures each view at scale 1 and finds a visible point on every occurrence to
   balloon; ``assembly_sheet.plan_sheet`` picks each sheet's size and scale; a second job draws the
   views there and projects the balloon points.
4. Pages are composed, ``assembly_check.check_sheet`` reads each SVG back, and
   ``drawing_document.publish_package`` checks the layout, exports PDF and PNG and publishes.

Exit 0 published, 1 content findings (nothing is published), 2 invalid input or infrastructure.
Rejected drafts are retained as scratch and never replace a sealed bundle.
"""

from __future__ import annotations

import argparse
import json
import shutil
import signal
import sys
import tempfile
import uuid
from contextlib import contextmanager
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assembly_check  # noqa: E402
import assembly_geometry  # noqa: E402
import assembly_sheet  # noqa: E402
import drawing_contract  # noqa: E402
import drawing_document  # noqa: E402
import freecad_runtime  # noqa: E402
from assembly_check import DIRECTIONS, AssemblyPlan, SheetPlan
from drawing_document import ComposedSheet, CompositionError, CoverageReport, SheetMetadata
from assembly_sheet import BalloonTarget, MeasuredView
from freecad_views import ViewGeometry  # noqa: E402

JOB_SCRIPT = Path(__file__).resolve().with_name("assembly_techdraw_job.py")
SCRIPTS = JOB_SCRIPT.parent


class Failure(Exception):
    """A run that publishes nothing: findings with codes, and the exit status (1 content, 2 input/infrastructure)."""

    def __init__(self, findings: Sequence[Mapping[str, Any]], status: int) -> None:
        super().__init__("; ".join(f["message"] for f in findings))
        self.findings = [dict(f) for f in findings]
        self.status = status


def fail(code: str, message: str, status: int) -> Failure:
    return Failure([assembly_check.finding(code, message)], status)


def allowed_sizes(product: Mapping[str, Any]) -> tuple[str, ...]:
    """The product's declared sheet sizes, else every ISO A size or every ANSI size for its regime."""
    declared = ((product.get("drawing") or {}).get("default_sheet") or {}).get("sizes")
    if declared:
        return tuple(declared)
    sizes = drawing_document.REGIME_SIZES.get(product.get("regime"), ())
    return tuple(s for s in sizes if s.startswith("ANSI")) if product.get("regime") == "asme" else tuple(sizes)


def view_spec(request: assembly_check.ViewRequest, sheet: SheetPlan) -> dict[str, Any]:
    direction, x_direction = DIRECTIONS[request.direction]
    return {"id": request.id, "scene": request.kind, "direction": list(direction), "x_direction": list(x_direction),
            "occurrences": list(sheet.occurrences)}


def techdraw_job(geometry: Any, offsets: Mapping[str, Sequence[float]], mode: str,
                 pages: Sequence[Mapping[str, Any]], measure_template: Path | None = None) -> dict[str, Any]:
    """The FreeCAD job: definitions, occurrences with their placements, scenes and the pages of views."""
    job: dict[str, Any] = {
        "scripts": str(SCRIPTS), "mode": mode,
        "definitions": {pn: str(path) for pn, path in geometry.definitions.items()},
        "occurrences": [{"id": o.occurrence_id, "pn": o.pn, "rotation": list(o.rotation),
                         "translation": list(o.translation)} for o in geometry.occurrences],
        "scenes": {"assembled": {}, "exploded": {oid: list(v) for oid, v in offsets.items()}},
        "pages": list(pages),
    }
    if measure_template is not None:
        job["measure_template"] = str(measure_template)
    return job


def run_freecad(freecadcmd: Path, job: dict[str, Any], workdir: Path, timeout: float) -> dict[str, Any]:
    result, message = freecad_runtime.run_job(freecadcmd, JOB_SCRIPT, job, workdir, timeout)
    if result is None:
        code = "empty_drawing" if message.startswith("empty_drawing") else "export_failed"
        raise fail(code, f"FreeCAD {job['mode']} job failed: {message}", 2)
    return result


def targets(plan: SheetPlan, request: assembly_check.ViewRequest, anchors: Mapping[str, Any],
            findings: list[dict[str, Any]]) -> dict[int, str]:
    """Per item, the first of its occurrences on this sheet that the view shows: the balloon's target."""
    chosen = {}
    for row in plan.rows:
        occurrence = next((oid for oid in plan.item_occurrences[row.item] if oid in anchors), None)
        if occurrence is None:
            findings.append(assembly_check.finding(
                "feature_not_presentable", f"item {row.item} ({row.pn}) has no visible occurrence in view {request.id}",
                sheet=plan.number, item=row.item))
            continue
        chosen[row.item] = occurrence
    return chosen


def sheet_notes(regime: str, plan: AssemblyPlan, sheet: SheetPlan,
                acceptance: Mapping[str, Mapping[str, Any]]) -> list[drawing_document.SvgNote]:
    frame = assembly_sheet.frame_note(plan.intent.views)
    if sheet.operations and frame is None:
        raise fail("assembly_instruction_incomplete", f"sheet {sheet.number} states installation directions but has "
                                                      "no orthographic view to show the assembly frame", 1)
    return assembly_sheet.notes(regime, plan.intent.scope, sheet.scope, plan.intent.excludes, sheet.operations, frame,
                                acceptance)


def evidence(regime: str, plan: AssemblyPlan, sheet: SheetPlan, views: Mapping[str, ViewGeometry],
             balloon_views: set[str], anchors: Mapping[str, Mapping[str, Sequence[float]]]) -> dict[str, Any]:
    """What ``check_sheet`` compares a sheet's SVG with; recorded in coverage.json for re-checks."""
    return {
        "kind": "assembly_sheet", "sheet": sheet.number, "scope": sheet.scope, "regime": regime,
        "items": {str(row.item): {"PN": row.pn, "qty": row.qty, "occurrences": list(sheet.item_occurrences[row.item])}
                  for row in sheet.rows},
        "bom": {row.pn: dict(plan.bom[row.pn]) for row in sheet.rows},
        "views": {vid: {"balloons": vid in balloon_views, "bounds": list(view.sheet_bounds()),
                        "anchors": {oid: list(p) for oid, p in anchors.get(vid, {}).items()}}
                  for vid, view in views.items()},
    }


@dataclass
class Inputs:
    """The verified record and version, the occurrences they place and the reconciled drawing plan."""

    context: drawing_contract.DrawingContext
    regime: str
    specs: tuple[drawing_document.SheetSpec, ...]
    geometry: assembly_geometry.AssemblyGeometry
    plan: AssemblyPlan
    offsets: dict[str, tuple[float, float, float]]   # occurrence id -> exploded presentation offset
    labels: dict[str, str]                            # view id -> its label


@dataclass
class Sheet:
    """One sheet on its way from measured views to a composed page."""

    plan: SheetPlan
    targets: dict[str, dict[int, str]]                # ballooned view id -> item -> occurrence
    points: dict[tuple[str, str], list[float]]         # (view id, occurrence) -> visible model point
    table: drawing_document.SvgTable
    notes: list[drawing_document.SvgNote]
    layout: assembly_sheet.SheetLayout


def read_inputs(args: argparse.Namespace, work: Path, context: drawing_contract.DrawingContext) -> Inputs:
    """Stages 1 and 2: the verified context, the bound occurrences and the reconciled plan."""
    hw = context.hw
    try:
        intent = assembly_check.read_intent(context.assembly)
        specs = drawing_document.sheet_specs(context.product, allowed_sizes(context.product))
    except ValueError as exc:
        raise fail("invalid_drawing_intent", str(exc), 2) from None
    try:
        geometry = assembly_geometry.read_assembly(hw, context.assembly_step, work / "definitions")
    except assembly_geometry.GeometryError as exc:
        raise fail(exc.code, str(exc), 1) from None
    plan, findings = assembly_check.reconcile(intent, geometry, context.bom, context.interfaces)
    if plan is None:
        raise Failure(findings, 1)
    regime = context.product["regime"]
    return Inputs(context=context, regime=regime, specs=specs, geometry=geometry, plan=plan,
                  offsets=geometry.presentation_offsets(plan.explode),
                  labels={v.id: assembly_sheet.view_label(regime, v) for v in intent.views})


def measure(inputs: Inputs, freecadcmd: Path, work: Path, timeout: float) -> dict[str, Any]:
    """Stage 3a: every view at scale 1 with visible points of the occurrences to balloon, and the acceptances."""
    plan = inputs.plan
    pages = [{"sheet": sheet.number,
              "views": [{**view_spec(v, sheet), "anchors": list(sheet.occurrences) if v.balloons else []}
                        for v in plan.intent.views]} for sheet in plan.sheets]
    template = work / "measure-template.svg"
    template.write_text(drawing_document.sheet_specs({"regime": "iso"}, ["A0"])[0].page_template_svg(), encoding="utf-8")
    job = techdraw_job(inputs.geometry, inputs.offsets, "measure", pages, template)
    job["acceptance"] = [op.measurement() for op in plan.sheets[0].operations]
    measured = run_freecad(freecadcmd, job, work, timeout)
    findings = [f for op in plan.sheets[0].operations
                for f in assembly_check.check_acceptance(op, measured["acceptance"].get(op.operation.id))]
    if findings:
        raise Failure(findings, 1)
    return measured


def lay_out(inputs: Inputs, measured: Mapping[str, Any]) -> list[Sheet]:
    """Stage 3b: per sheet the balloon targets, parts list and notes, and the sheet size and scale they fit."""
    by_view = {(entry["sheet"], entry["view"]): entry for entry in measured["views"]}
    findings: list[dict[str, Any]] = []
    sheets = []
    for plan in inputs.plan.sheets:
        chosen, points, views = {}, {}, []
        for request in inputs.plan.intent.views:
            entry = by_view[(plan.number, request.id)]
            if request.balloons:
                chosen[request.id] = targets(plan, request, entry["anchors"], findings)
                points.update({(request.id, oid): entry["anchors"][oid]["point"] for oid in chosen[request.id].values()})
            views.append(MeasuredView(
                request=request, label=inputs.labels[request.id], bounds=tuple(entry["bounds"]),
                anchors={oid: tuple(entry["anchors"][oid]["local"]) for oid in chosen.get(request.id, {}).values()},
                extents=dict(entry["extents"])))
        table = assembly_sheet.parts_list(inputs.regime, plan.rows)
        notes = sheet_notes(inputs.regime, inputs.plan, plan, measured["acceptance"])
        try:
            layout = assembly_sheet.plan_sheet(inputs.specs, views, [table], notes, plan.heading)
        except CompositionError as exc:
            findings.append(assembly_check.finding(exc.code, f"sheet {plan.number}: {exc}", sheet=plan.number))
            continue
        sheets.append(Sheet(plan=plan, targets=chosen, points=points, table=table, notes=notes, layout=layout))
    if findings:
        raise Failure(findings, 1)
    return sheets


def draw(inputs: Inputs, sheets: Sequence[Sheet], freecadcmd: Path, work: Path,
         timeout: float, jobs: int = 1, executor: Any = None) -> dict[int, list[Mapping[str, Any]]]:
    """Stage 3c: draw each independent sheet in its own FreeCAD process."""
    def draw_sheet(sheet: Sheet) -> tuple[int, list[Mapping[str, Any]]]:
        template = work / f"sheet-{sheet.plan.number}-template.svg"
        template.write_text(sheet.layout.spec.page_template_svg(), encoding="utf-8")
        pages = [{"sheet": sheet.plan.number, "template": str(template), "views": [
            {**view_spec(v, sheet.plan), "scale": sheet.layout.scale, "position": list(sheet.layout.origins[v.id]),
             "anchors": {oid: sheet.points[(v.id, oid)] for oid in sheet.targets.get(v.id, {}).values()}}
            for v in inputs.plan.intent.views]}]
        drawn = run_freecad(freecadcmd, techdraw_job(inputs.geometry, inputs.offsets, "draw", pages), work, timeout)
        return sheet.plan.number, drawn["views"]

    return dict(freecad_runtime.map_jobs(sheets, jobs, draw_sheet, executor))


def compose(inputs: Inputs, sheet: Sheet, drawn: Sequence[Mapping[str, Any]]) -> tuple[ComposedSheet, dict[str, Any]]:
    """Stage 4a: one page with its views, balloons, labels, parts list and notes, and the evidence to check it by."""
    intent, layout = inputs.plan.intent, sheet.layout
    views = {entry["view"]: ViewGeometry.from_dict(entry["geometry"]) for entry in drawn}
    anchors = {entry["view"]: entry["anchors"] for entry in drawn}
    annotations = [] if sheet.plan.heading is None else [assembly_sheet.heading(layout.spec, sheet.plan.heading)]
    for request in intent.views:
        view = views[request.id]
        if request.balloons:
            annotations += assembly_sheet.balloons(view, [BalloonTarget(item, oid, tuple(anchors[request.id][oid]))
                                                          for item, oid in sheet.targets[request.id].items()])
        annotations.append(assembly_sheet.label(view, inputs.labels[request.id], request.balloons))
    metadata = SheetMetadata(drawing_number=intent.number, revision=intent.rev, title=intent.title,
                             document_type=assembly_sheet.DOCUMENT_TYPE[inputs.regime], sheet_number=sheet.plan.number,
                             sheet_count=len(inputs.plan.sheets), scale=layout.scale,
                             standards=assembly_sheet.STANDARDS[inputs.regime])
    try:
        page = drawing_document.compose_page(layout.spec, metadata, [views[v.id] for v in intent.views], annotations,
                                             [sheet.table], sheet.notes)
    except CompositionError as exc:
        raise fail(exc.code, f"sheet {sheet.plan.number}: {exc}", 1) from None
    record = evidence(inputs.regime, inputs.plan, sheet.plan, views, {v.id for v in intent.views if v.balloons}, anchors)
    return page, {**record, "size": layout.spec.size, "scale": layout.scale,
                  "operations": [op.operation.id for op in sheet.plan.operations]}


def build(args: argparse.Namespace, freecadcmd: Path, work: Path, context: drawing_contract.DrawingContext,
          jobs: int = 1, executor: Any = None) -> tuple[drawing_contract.DrawingContext, list[ComposedSheet], CoverageReport]:
    """Stages 1 to 4a; stage 4b, publication, follows in ``run``."""
    inputs = read_inputs(args, work, context)
    measured = measure(inputs, freecadcmd, work, args.timeout)
    sheets = lay_out(inputs, measured)
    drawn = draw(inputs, sheets, freecadcmd, work, args.timeout, jobs, executor)

    def compose_checked(sheet: Sheet) -> tuple[ComposedSheet, dict[str, Any], list[dict[str, Any]]]:
        page, record = compose(inputs, sheet, drawn[sheet.plan.number])
        return page, record, assembly_check.check_sheet(page.svg, record)

    composed_rows = freecad_runtime.map_jobs(sheets, jobs, compose_checked, executor)
    composed = [page for page, _, _ in composed_rows]
    rows = [record for _, record, _ in composed_rows]
    findings = [finding for _, _, sheet_findings in composed_rows for finding in sheet_findings]
    plan = inputs.plan
    rows += [{"kind": "assembly_operation", "operation": op.operation.id, "type": op.operation.kind,
              "interface": op.operation.interface, "items": [op.part_item, op.into_item],
              "acceptance": op.operation.acceptance, "measured": measured["acceptance"][op.operation.id],
              "direction": list(op.direction), "sheets": [s.number for s in plan.sheets if op in s.operations]}
             for op in plan.sheets[0].operations]
    report = CoverageReport(status="fail" if findings else "pass", rows=tuple(rows), findings=tuple(findings))
    return inputs.context, composed, report


def reject(output_dir: Path, findings: Sequence[Mapping[str, Any]], status: int) -> dict[str, Any]:
    """Keep rejected draft files in their supplied .cad-work directory."""
    result = {"status": "fail" if status == 1 else "error", "output_dir": str(output_dir), "findings": list(findings)}
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "rejected.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result

@contextmanager
def _ignore_publish_signals():
    """Defer SIGINT/SIGTERM until a sealed bundle has been claimed."""
    previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)

def run(args: argparse.Namespace, freecadcmd: Path, jobs: int = 1) -> tuple[dict[str, Any], int]:
    hw = args.hw.resolve()
    hw = hw / "hw" if hw.name != "hw" and (hw / "hw").is_dir() else hw
    api = drawing_contract.layout_api()
    label, version_dir, _ = api.built_version(hw, args.version)
    context = drawing_contract.load_context(hw, version_dir)
    intent = assembly_check.read_intent(context.assembly)
    recipe = {"drawing": context.provenance("assembly"), "bom": list(context.bom)}
    params = {"V": label, "S": "assembly"}
    if args.output_dir is None:
        existing = api.reusable(hw, "bundle.drawings", params, recipe, replace=args.replace)
        if existing is not None:
            return {"status": "pass", "cache": "hit", "output_dir": str(existing)}, 0
        output_dir = api.staging(hw, "bundle.drawings")
    else:
        output_dir = api.scratch_path(hw, args.output_dir, "--output-dir")
        output_dir.mkdir(parents=True, exist_ok=False)
    work_root = hw.parent / ".cad-work" / "assembly-drawing"
    work_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cad-assembly-drawing-", dir=work_root) as work:
        try:
            with ThreadPoolExecutor(max_workers=jobs, thread_name_prefix="cad-assembly") as executor:
                bundle_path = api.bundle_dir(hw, "drawings", label, "assembly") if args.output_dir is None else output_dir
                _, sheets, report = build(args, freecadcmd, Path(work), context, jobs, executor)
                package = drawing_document.publish_package(context, sheets, report, output_dir, freecadcmd,
                                                           args.timeout, jobs=jobs, executor=executor,
                                                           bundle_path=bundle_path if report.status == "pass" else output_dir)
        except Failure as failure:
            return reject(output_dir, failure.findings, failure.status), failure.status
    result = package.to_dict()
    if package.exit_code == 0 and args.output_dir is None:
        with _ignore_publish_signals():
            output_dir = api.publish(hw, "bundle.drawings", {"V": label, "S": "assembly"}, output_dir,
                                     recipe=recipe, producer="cad-drawings assembly_drawing.py",
                                     status="pass", replace=args.replace).path
        result["output_dir"] = str(output_dir)
    result["files"] = [{"sheet": s["sheet"], "size": s["size"],
                        **{kind: str(hw.parent / name) for kind, name in s["files"].items()}}
                       for s in package.sheets]
    return result, package.exit_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("hw", type=Path, help="hardware design record directory (hw/)")
    parser.add_argument("--version", required=True, help="built version label or latest")
    parser.add_argument("--output-dir", type=Path, help="write scratch package under .cad-work only")
    parser.add_argument("--replace", action="store_true", help="retain and replace a conflicting bundle")
    parser.add_argument("--timeout", type=float, default=600.0, help="seconds for each FreeCAD job and export")
    parser.add_argument("--jobs", type=int, help="maximum concurrent FreeCAD jobs (default: CPU and memory bound)")
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.jobs is not None and args.jobs < 1:
        parser.error("--jobs must be a positive integer")
    freecadcmd = freecad_runtime.find_freecadcmd()
    if freecadcmd is None or not freecadcmd.is_file():
        print(json.dumps({"status": "error", "findings": [assembly_check.finding(
            "freecad_unavailable", f"FreeCAD not found ({freecadcmd}); set FREECADCMD or put freecadcmd on PATH")]}))
        return 2
    try:
        hw = args.hw.resolve()
        hw = hw / "hw" if hw.name != "hw" and (hw / "hw").is_dir() else hw
        api = drawing_contract.layout_api()
        label, version_dir, _ = api.built_version(hw, args.version)
        context = drawing_contract.load_context(hw, version_dir)
        intent = assembly_check.read_intent(context.assembly)
        recipe = {"drawing": context.provenance("assembly"), "bom": list(context.bom)}
        if args.output_dir is None:
            existing = api.reusable(hw, "bundle.drawings", {"V": label, "S": "assembly"}, recipe,
                                    replace=args.replace)
            if existing is not None:
                print(json.dumps({"status": "pass", "cache": "hit", "output_dir": str(existing)}, indent=2))
                return 0
        else:
            output = api.scratch_path(hw, args.output_dir, "--output-dir")
            if output.exists():
                raise api.LayoutError(f"--output-dir already exists and will not be overwritten: {output}")
    except (drawing_contract.ContractError, assembly_check.IntentError, api.LayoutError, OSError, ValueError, KeyError) as exc:
        findings = [dict(f) for f in getattr(exc, "findings", ())]
        if not findings:
            findings = [assembly_check.finding(getattr(exc, "code", "invalid_input"), str(exc))]
        print(json.dumps({"status": "error", "findings": findings}, indent=2))
        return 2
    jobs = freecad_runtime.jobs_for(args.jobs, 1 + len(intent.subassembly_sheets),
                                    freecad_runtime.FREECAD_JOB_PEAK_RSS_BYTES)
    try:
        with freecad_runtime.terminate_jobs_on_signal():
            result, status = run(args, freecadcmd, jobs)
    except (Failure, api.PublishConflict, api.LayoutError) as exc:
        findings = [dict(f) for f in getattr(exc, "findings", ())]
        if not findings:
            findings = [assembly_check.finding(getattr(exc, "code", "invalid_input"), str(exc))]
        result, status = {"status": "error", "findings": findings}, 2
    except freecad_runtime.JobInterrupted as exc:
        result, status = {"status": "error", "findings": [assembly_check.finding("interrupted", str(exc))]}, 128 + exc.signum
    print(json.dumps(result, indent=2))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
