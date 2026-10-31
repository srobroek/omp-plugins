#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["defusedxml>=0.7.1", "pyyaml>=6.0"]
# ///
"""Generate a structured GitBuilding guide, an OKH manifest and a DIN SPEC 3105-1 checklist from a
hardware record and built version.

Usage: build_guide.py HW --version vN --out DIR [--rev REV [--date YYYY-MM-DD]] [--replace]

--rev prepares the documents for release REV of vN before release.py seals it, dated --date: the UTC
date release.py will seal it (a sealed REV gives its own date). release.py refuses a generated okh.toml
that names another version, revision or date. Each document starts with a marker that holds the
sha256 of the rest; in hw/docs/ build_guide.py overwrites only an unchanged generated document, and a
file without the marker or edited since needs --replace.
"""

from __future__ import annotations

import argparse
import csv
import datetime
import html
import json
import math
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping, Sequence
from urllib.parse import quote

import yaml

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / "scripts"))
sys.path.insert(0, str(SKILL.parent / "cad-drawings" / "scripts"))
import importlib.util

LAYOUT_PATH = SKILL / "scripts" / "layout.py"
if "cad_record_layout" not in sys.modules:
    _LAYOUT_SPEC = importlib.util.spec_from_file_location("cad_record_layout", LAYOUT_PATH)
    if _LAYOUT_SPEC is None or _LAYOUT_SPEC.loader is None:
        raise ImportError(f"{LAYOUT_PATH} not found")
    LAYOUT = importlib.util.module_from_spec(_LAYOUT_SPEC)
    sys.modules["cad_record_layout"] = LAYOUT
    _LAYOUT_SPEC.loader.exec_module(LAYOUT)
else:
    LAYOUT = sys.modules["cad_record_layout"]
import assembly_data  # noqa: E402
import assembly_check  # noqa: E402
import assembly_sheet  # noqa: E402
import generated_docs  # noqa: E402

EVIDENCE_PATH = re.compile(r"hw/[^\s,;()\"'<>]+")  # a cited path in an evidence cell, as release.py reads it


class GuideError(ValueError):
    """The record or selected version cannot produce a guide without guessing."""


def read_yaml(path: Path, *, optional: bool = False) -> dict[str, Any]:
    if not path.is_file():
        if optional:
            return {}
        raise GuideError(f"required record file is missing: {path}")
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise GuideError(f"cannot read {path}: {exc}") from exc
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise GuideError(f"{path} must contain a YAML mapping")
    return value


def read_csv(path: Path, *, optional: bool = False) -> list[dict[str, str]]:
    if optional and not path.is_file():
        return []
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            return list(csv.DictReader(stream))
    except OSError as exc:
        raise GuideError(f"cannot read {path}: {exc}") from exc


def cell(value: Any) -> str:
    """`value` inside one Markdown table cell: pipes escaped, line breaks as spaces."""
    return str(value).replace("|", "\\|").replace("\n", " ")


def text(value: Any) -> str:
    if value is None or not str(value).strip():
        return "not recorded"
    return cell(str(value).strip())


def table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(text(value) for value in row) + " |" for row in rows)
    return "\n".join(lines)


def relative_path(source: Path, out: Path) -> str:
    return Path(os.path.relpath(source, out)).as_posix()


def relative_link(source: Path, out: Path) -> str:
    return quote(relative_path(source, out), safe="/.-_:@")


def markdown_link(label: str, source: Path, out: Path) -> str:
    return f"[{text(label)}]({relative_link(source, out)})"


def item_geometry(assembly: Mapping[str, Any], frames: Mapping[str, str]) -> SimpleNamespace:
    """Adapt the normalized assembly inventory to the shared drawing reconciliation contract."""
    try:
        inventory = assembly_data.normalize(assembly, frames)
    except (assembly_data.InventoryError, ValueError) as exc:
        raise GuideError(f"cannot normalize assembly occurrences: {exc}") from exc
    groups = {group.id: (group.id, group.title, group.members) for group in inventory.groups}
    memberships: dict[str, list[str]] = defaultdict(list)
    for group in inventory.groups:
        for member in group.members:
            memberships[member].append(group.id)
    parent_of = {joint["child"]: joint["parent"] for joint in assembly.get("joints", [])}
    occurrences = []
    for occurrence in inventory.occurrences:
        placement = occurrence.placement
        half = math.radians(placement.angle_deg) / 2
        sine = math.sin(half)
        quaternion = (*(axis * sine for axis in placement.axis), math.cos(half))
        occurrences.append(SimpleNamespace(occurrence_id=occurrence.id, pn=occurrence.pn, ref=occurrence.ref,
                                           rotation=quaternion, translation=placement.translation_mm,
                                           groups=tuple(memberships[occurrence.id]), parent=parent_of.get(occurrence.id)))
    joints = {joint["id"]: dict(joint) for joint in assembly.get("joints", [])}
    return SimpleNamespace(occurrences=tuple(occurrences), groups=groups, joints=joints)


@dataclass(frozen=True)
class ReleaseRef:
    """The release the documents describe: sealed (its manifest exists) or prepared with --rev."""

    rev: str
    date: str  # YYYY-MM-DD: the sealed manifest's released_at, or the --date release.py will seal a prepared one
    manifest: Path
    sealed: bool

    def label(self) -> str:
        return f"hw/releases/{self.rev}/manifest.json"


def _read_manifest(path: Path) -> dict[str, Any] | None:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return manifest if isinstance(manifest, dict) else None


def _holds(manifest: Mapping[str, Any], product_id: str, version: str) -> bool:
    """A version 2 manifest names the version in frozen.version, a version 1 manifest lists its files in place."""
    if manifest.get("product_id") != product_id:
        return False
    if "schema_version" in manifest:
        frozen = manifest.get("frozen")
        return isinstance(frozen, Mapping) and frozen.get("version") == version
    return any(re.search(rf"(?:^|/)versions/{re.escape(version)}(?:/|$)", item)
               for item in manifest.get("files", []) if isinstance(item, str))


def release_reference(hw: Path, product_id: str, version: str, rev: str | None,
                      date: str | None = None) -> ReleaseRef | None:
    """Release `rev` of `version`: sealed, dated by its manifest, or prepared, dated `date` (the UTC date
    release.py will seal it). Without `rev`, the newest sealed release of `version`, or None."""
    if rev is not None:
        path = LAYOUT.locate(hw, LAYOUT.load().path("release.package", {"REV": rev})) / "manifest.json"
        if not path.exists():
            if date is None:
                raise GuideError(f"release {rev} is not sealed yet: pass --date YYYY-MM-DD, the UTC date "
                                 "release.py will seal it, which its okh.toml release_date must match")
            return ReleaseRef(rev, date, path, sealed=False)
        manifest = _read_manifest(path)
        if manifest is None or not _holds(manifest, product_id, version):
            raise GuideError(f"hw/releases/{rev}/manifest.json does not release {version} of {product_id or 'this product'}")
        sealed = str(manifest.get("released_at", ""))[:10]
        if date is not None and date != sealed:
            raise GuideError(f"release {rev} was sealed on {sealed}, not {date}")
        return ReleaseRef(rev, sealed, path, sealed=True)
    candidates = []
    for path in (hw / "releases").glob("*/manifest.json"):
        manifest = _read_manifest(path)
        if manifest is not None and _holds(manifest, product_id, version):
            candidates.append((str(manifest.get("released_at", "")), str(path), path))
    if not candidates:
        return None
    released_at, _, path = max(candidates)
    return ReleaseRef(path.parent.name, released_at[:10], path, sealed=True)


def release_cell(release: ReleaseRef | None, version: str, hw: Path, out: Path) -> str:
    """The release manifest a Markdown document cites: a link once sealed."""
    if release is None:
        return f"MISSING: no hw/releases/<REV>/manifest.json approves {version}"
    if release.sealed:
        return record_link(release.label(), release.manifest, hw, out)
    return f"{release.label()} (release.py seals it with these documents)"


def built_manufacturing(layout: Any, hw: Path, version: str, pn: str, process: str, out: Path) -> str | None:
    """Link the canonical manufacturing STEP, and the FDM STL when applicable."""
    directory = layout.manufacturing_dir(hw, version, pn)
    files = ["part.step"]
    if process == "fdm":
        files.append("part.stl")
    links = [markdown_link(name, directory / name, out) for name in files if (directory / name).is_file()]
    return "<br>".join(links) if links else None


def guide_measurements(hw: Path, version_dir: Path, version: str, product_id: str,
                       operation_ids: set[str]) -> dict[str, Mapping[str, Any]]:
    bundle = LAYOUT.bundle_dir(hw, "drawings", version, "assembly")
    reports = {(bundle / name, False) for name in ("coverage.json", "package.json")}
    releases = hw / "releases"
    if releases.is_dir():
        for manifest_path in releases.glob("*/manifest.json"):
            try:
                release = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if release.get("product_id") != product_id:
                continue
            has_version = any(isinstance(item, str) and
                              re.search(rf"(?:^|/)versions/{re.escape(version)}(?:/|$)", item)
                              for item in release.get("files", []))
            for relative in release.get("files", []):
                if isinstance(relative, str) and relative.endswith(("coverage.json", "package.json")):
                    report_path = hw / relative
                    if report_path.is_file():
                        reports.add((report_path, has_version))

    found: dict[str, Mapping[str, Any]] = {}
    for path, release_report in sorted(reports, key=lambda report: str(report[0])):
        try:
            content = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if path.name == "package.json":
            if (content.get("provenance", {}).get("version") != version or
                    content.get("provenance", {}).get("subject") != "LMP-ASM" and release_report):
                continue
            coverage = content.get("coverage") or {}
        else:
            if release_report and not any(isinstance(item, str) and
                    re.search(rf"(?:^|/)versions/{re.escape(version)}(?:/|$)", item)
                    for item in content.get("files", [])):
                continue
            coverage = content
        rows = coverage.get("rows", [])
        if not isinstance(rows, list):
            continue
        for row in rows:
            operation = row.get("operation")
            measured = row.get("measured")
            if row.get("kind") == "assembly_operation" and operation in operation_ids and isinstance(measured, Mapping):
                found[operation] = measured
    return found


def recorded_tools(operations: Sequence[Mapping[str, Any]]) -> list[tuple[str, str, str]]:
    """List only tools and consumables explicitly recorded on assembly operations."""
    return [(name, str(operation.get("id") or "not recorded"), str(operation.get("interface") or "not recorded"))
            for operation in operations for key in ("tools", "consumables")
            for name in operation.get(key, [])]


def record_link(label: str, source: Path, hw: Path, out: Path) -> str:
    return markdown_link(label, source, out) if source.is_file() else f"MISSING: {label} ({LAYOUT.relative(hw, source)})"


def evidence_links(evidence: str, hw: Path, out: Path) -> str:
    """The evidence text with each cited hw/ path that exists, a file or a bundle directory, as a link
    and each other cited path marked MISSING. Unescaped Markdown: the caller escapes the table cell."""
    evidence = evidence or ""
    pieces: list[str] = []
    cursor = 0
    for match in EVIDENCE_PATH.finditer(evidence):
        cited = match.group(0).rstrip(".")  # a full stop ends the sentence, not the path
        try:
            source = LAYOUT.locate(hw, cited.rstrip("/"))
        except LAYOUT.LayoutError:
            source = None
        pieces.append(evidence[cursor:match.start()])
        pieces.append(markdown_link(cited, source, out) if source is not None and source.exists()
                      else f"MISSING: {cited}")
        pieces.append(match.group(0)[len(cited):])
        cursor = match.end()
    pieces.append(evidence[cursor:])
    return "".join(pieces).strip() or "not recorded"


def toml_string(value: Any) -> str:
    return json.dumps(str(value), ensure_ascii=False)[1:-1]


def licenses(product: Mapping[str, Any]) -> dict[str, str | None]:
    """product.yaml license.hardware and license.documentation, None where not recorded."""
    data = product.get("license") if isinstance(product.get("license"), Mapping) else {}
    return {key: value.strip() if isinstance(value := data.get(key), str) and value.strip() else None
            for key in ("hardware", "documentation")}


def license_text(product: Mapping[str, Any], key: str) -> str:
    return licenses(product)[key] or f"HUMAN-OWNED / MISSING: product.license.{key}"


def okh_path(label: str, source: Path, out: Path, *, directory: bool = False) -> str:
    """A path from the okh.toml in `out` to `source`, or MISSING when it does not exist."""
    if directory:
        return relative_path(source, out) + "/" if source.is_dir() else f"MISSING: {label}"
    return relative_path(source, out) if source.is_file() else f"MISSING: {label}"


def okh_document(hw: Path, out: Path, product: Mapping[str, Any], version: str,
                 release: ReleaseRef | None, processes: Sequence[str]) -> str:
    template = (SKILL / "assets" / "docs-templates" / "okh.toml").read_text(encoding="utf-8")
    recorded = licenses(product)
    manufacturing = LAYOUT.version_dir(hw, version) / "manufacturing"
    values = {
        "name": product.get("id") or "not recorded",
        "version": version,
        "license": recorded["documentation"] or "HUMAN-OWNED: set product.license.documentation (SPDX expression)",
        "hardware_license": recorded["hardware"] or "HUMAN-OWNED: set product.license.hardware (SPDX expression)",
        "release": release.rev if release else "not released",
        "release_date": release.date if release else "not released",
        "bom_source": okh_path("hw/bom.csv", hw / "bom.csv", out),
        "parts_to_make": "index.md#parts-to-make",
        "parts_to_buy": "index.md#parts-to-buy",
        "manufacturing_files": okh_path(f"hw/versions/{version}/manufacturing/", manufacturing, out, directory=True),
        "manufacturing_processes": ", ".join(map(str, processes)) or "MISSING: product.manufacturing.processes",
        "assembly_steps": "index.md#assembly-steps",
        "tools_and_consumables": "index.md#tools-and-consumables",
        "validation_method": okh_path("hw/verification.csv", hw / "verification.csv", out),
        "validation_description": "See index.md#checks-before-use for verification status and evidence.",
    }
    for key, value in values.items():
        template = template.replace("{{" + key + "}}", toml_string(value))
    missing = [f"product.license.{key}" for key in ("hardware", "documentation") if not recorded[key]]
    if release is None:
        manifest = f"MISSING: no hw/releases/<REV>/manifest.json approves {version}"
    else:
        manifest = relative_path(release.manifest, out) + ("" if release.sealed else
                                                           " (release.py seals it with these documents)")
    return template + "\n# Planned product processes: " + ", ".join(processes or ["MISSING: product.manufacturing.processes"]) + "\n" + \
           "# Record-derived release manifest: " + manifest + "\n" + \
           "# HUMAN-OWNED: licensor, author, design_owner, repository URL, software, tools, readiness level.\n" + \
           ("# HUMAN-OWNED / MISSING: " + ", ".join(missing) + "; record approved SPDX expressions.\n" if missing else "")


def din_document(hw: Path, out: Path, version: str, release: ReleaseRef | None, processes: Sequence[str],
                 verification: Sequence[Mapping[str, str]], decisions: Sequence[Path],
                 requirements: Mapping[str, Any], product: Mapping[str, Any]) -> str:
    template = (SKILL / "assets" / "docs-templates" / "din-spec-3105-1-checklist.md").read_text(encoding="utf-8")
    decision_links = ", ".join(markdown_link(path.stem, path, out) for path in decisions) or \
                     "MISSING: hw/decisions/DR-###.md"
    verification_evidence = record_link("hw/verification.csv", hw / "verification.csv", hw, out) + "; " + "; ".join(
         f"{row.get('requirement_id')}: {row.get('result') or 'not recorded'} — " +
         evidence_links(row.get("evidence", ""), hw, out)
         for row in verification
    )
    requirements_ids = ", ".join(str(item.get("id")) for item in requirements.get("requirements", [])
                                  if isinstance(item, Mapping)) or "MISSING: hw/requirements.yaml requirements"
    release_link = release_cell(release, version, hw, out)
    records = {
        "purpose_evidence": f"{record_link('product.yaml', hw / 'product.yaml', hw, out)}; "
                            f"{record_link('requirements.yaml', hw / 'requirements.yaml', hw, out)} ({requirements_ids})",
        "interface_evidence": f"{record_link('interfaces.yaml', hw / 'interfaces.yaml', hw, out)}; "
                              f"{record_link('assembly.yaml', hw / 'assembly.yaml', hw, out)}",
        "part_evidence": f"{record_link('assembly.yaml', hw / 'assembly.yaml', hw, out)}; "
                         f"{record_link('bom.csv', hw / 'bom.csv', hw, out)}",
        "manufacturing_evidence": f"processes: {', '.join(processes) if processes else 'MISSING: product.manufacturing.processes'}; "
                                  f"{record_link('bom.csv', hw / 'bom.csv', hw, out)}",
        "decision_evidence": decision_links,
        "verification_evidence": cell(verification_evidence),
        "release_evidence": release_link,
        "guide_evidence": "index.md",
        "license_evidence": f"documentation: {license_text(product, 'documentation')}; "
                            f"hardware: {license_text(product, 'hardware')}",
        "change_evidence": f"{record_link('bom.csv', hw / 'bom.csv', hw, out)}; {release_link}; {decision_links}",
    }
    for key, value in records.items():
        template = template.replace("{{" + key + "}}", value)
    return template.replace("{{requirements_evidence}}", requirements_ids)


def make_guide(hw: Path, version: str, out: Path, rev: str | None = None, date: str | None = None) -> dict[str, str]:
    """The generated documents by file name, before their marker line; `rev` prepares them for that
    release, sealed on `date` when it is not sealed yet."""
    hw = hw.resolve()
    version_dir = LAYOUT.version_dir(hw, version)
    version_manifest = version_dir / "manifest.json"
    if not version_manifest.is_file():
        raise GuideError(f"version manifest is missing: {version_manifest}")
    try:
        built = json.loads(version_manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise GuideError(f"cannot read version manifest {version_manifest}: {exc}") from exc

    product = read_yaml(hw / "product.yaml", optional=True)
    assembly = read_yaml(hw / "assembly.yaml", optional=True)
    requirements = read_yaml(hw / "requirements.yaml", optional=True)
    interfaces = read_yaml(hw / "interfaces.yaml", optional=True).get("interfaces", [])
    bom_rows = read_csv(hw / "bom.csv", optional=True)
    verification = read_csv(hw / "verification.csv", optional=True)
    decision_paths = sorted((hw / "decisions").glob("DR-[0-9][0-9][0-9].md"))
    manufacturing = product.get("manufacturing") if isinstance(product.get("manufacturing"), Mapping) else {}
    processes = manufacturing.get("processes", [])
    processes = processes if isinstance(processes, list) else []
    product_id = product.get("id")
    part_records = {path.parent.name: record for path in sorted((hw / "parts").glob("*/part.yaml"))
                    if isinstance((record := read_yaml(path, optional=True)), dict)}
    frames = {pn: record.get("model_frame", assembly_data.DEFAULT_FRAME) for pn, record in part_records.items()}
    assembly_drawing = assembly.get("drawing")
    plan, intent = None, None
    if isinstance(assembly_drawing, Mapping):
        try:
            intent = assembly_check.read_intent(assembly)
            plan, findings = assembly_check.reconcile(intent, item_geometry(assembly, frames), bom_rows, interfaces)
        except (assembly_check.IntentError, KeyError, TypeError, ValueError) as exc:
            raise GuideError(f"cannot resolve assembly instructions: {exc}") from exc
        if findings or plan is None:
            reasons = "; ".join(finding["message"] for finding in findings)
            raise GuideError(f"assembly drawing does not reconcile with the BOM and interfaces: {reasons}")

    bom_by_pn = {row.get("PN", ""): row for row in bom_rows}
    rolled = assembly_check.bom_rollup(bom_rows) if bom_rows else {}
    items = {entry.pn: entry.item for entry in intent.items} if intent else {}
    part_numbers = list(dict.fromkeys(row.get("PN", "") for row in bom_rows if row.get("PN")))
    if plan is not None:
        part_numbers = [row.pn for row in sorted(plan.sheets[0].rows, key=lambda row: row.item)]

    revision = assembly_drawing.get("rev") if isinstance(assembly_drawing, Mapping) else None
    if not revision:
        revisions = {row.get("rev", "").strip() for row in bom_rows if row.get("rev", "").strip()}
        revision = next(iter(revisions)) if len(revisions) == 1 else None
    overview = [("Product", product_id), ("Revision", revision), ("Version", version)]
    release = release_reference(hw, str(product_id or ""), version, rev, date)
    overview.append(("Release manifest", release_cell(release, version, hw, out)))

    make_rows: list[tuple[Any, ...]] = []
    buy_rows: list[tuple[Any, ...]] = []
    for pn in part_numbers:
        part = part_records.get(pn, {})
        bom = bom_by_pn.get(pn, {})
        quantity = rolled.get(pn, {}).get("qty", bom.get("qty"))
        common = (items.get(pn), pn)
        if part.get("make_buy", bom.get("make_buy")) == "make":
            process = str(part.get("process") or bom.get("process") or "")
            manufacturing = built_manufacturing(LAYOUT, hw, version, pn, process, out)
            make_rows.append((*common, part.get("title") or bom.get("title"), quantity,
                              part.get("material") or bom.get("material"), process, manufacturing))
        elif part.get("make_buy", bom.get("make_buy")) == "buy":
            procurement = part.get("procurement") or {}
            designation = (procurement.get("designation") or bom.get("designation")
                           or procurement.get("manufacturer_part_number") or bom.get("manufacturer_part_number"))
            if not designation:
                designation = bom.get("title")
            supplier = part.get("supplier") or bom.get("supplier")
            order_code = procurement.get("supplier_part_number") or bom.get("supplier_part_number")
            open_fields = procurement.get("open") or {}
            if "manufacturer_part_number" in open_fields:
                designation = (f"{designation or 'not recorded'}; OPEN — manufacturer_part_number: "
                               f"{open_fields['manufacturer_part_number']}")
            if "supplier" in open_fields:
                supplier = f"{supplier or 'not recorded'}; OPEN — supplier: {open_fields['supplier']}"
            if "supplier_part_number" in open_fields:
                order_code = f"OPEN — supplier_part_number: {open_fields['supplier_part_number']}"
            drawing_link = None
            if procurement.get("mode") == "made_to_drawing" and part.get("drawing") is not None:
                drawing = LAYOUT.bundle_dir(hw, "drawings", version, pn) / "sheet-1.pdf"
                if drawing.is_file():
                    drawing_link = markdown_link("drawing sheet PDF", drawing, out)
            buy_rows.append((*common, designation, quantity, supplier, order_code, drawing_link))

    operations = assembly_drawing.get("operations", []) if isinstance(assembly_drawing, Mapping) else []
    resolved = plan.sheets[0].operations if plan is not None else ()
    measurements = guide_measurements(hw, version_dir, version, str(product_id or ""),
                                      {operation.operation.id for operation in resolved})
    steps: list[str] = []
    for number, resolved_operation in enumerate(resolved, start=1):
        operation = resolved_operation.operation
        try:
            note = assembly_sheet.operation_note(resolved_operation, measurements.get(operation.id, {}),
                                                 str(product.get("regime") or "iso"))
        except (KeyError, TypeError, ValueError) as exc:
            raise GuideError(f"cannot format assembly operation {operation.id}: {exc}") from exc
        if operation.acceptance == "standoff" and measurements.get(operation.id, {}).get("gap") is None:
            note = note.replace("gap not measured", f"gap not measured: run the assembly drawing for {version}")
        steps.append(f"{number}. {text(note)}")

    tool_rows = []
    for step_number, resolved_operation in enumerate(resolved, start=1):
        names = [*resolved_operation.operation.tools, *resolved_operation.operation.consumables]
        if names:
            operation = resolved_operation.operation
            relation = "onto" if operation.kind == "retaining_ring" else "into"
            tool_rows.append((step_number,
                              f"{resolved_operation.part_item} {relation} {resolved_operation.into_item}",
                              "; ".join(names)))
    sections = [
        "## Overview\n\n" + table(("Field", "Value"), overview),
        "## Parts to make\n\n" + table(("Item no.", "PN", "Title", "Qty", "Material", "Process", "Manufacturing file"),
                                           make_rows or [(None,) * 7]),
        "## Parts to buy\n\n" + table(("Item no.", "PN", "Designation or manufacturer PN", "Qty", "Supplier", "Order code", "Drawing"),
                                          buy_rows or [(None,) * 7]),
        "## Tools and consumables\n\n" + table(
            ("Step", "Items", "Tool or consumable"), tool_rows or [(None, None, None)]),
        "## Assembly steps\n\n" + ("\n".join(steps) if steps else "not recorded"),
        "## Checks before use\n\n" + table(("Requirement", "Method", "Criteria", "Status", "Evidence"),
            [(row.get("requirement_id"), row.get("method"), row.get("criteria"), row.get("result"),
              evidence_links(row.get("evidence", ""), hw, out)) for row in verification] or
             [("MISSING: hw/verification.csv rows", None, None, None, None)]),
        "## Design decisions\n\n" + (", ".join(markdown_link(path.stem, path, out) for path in decision_paths)
                                          if decision_paths else "MISSING: hw/decisions/DR-###.md"),
        "## Manufacturing processes\n\n" + (", ".join(map(text, processes)) if processes else
                                                 "MISSING: product.yaml manufacturing.processes"),
        "## Reuse terms\n\n" + table(("Field", "Value"), [
            ("Hardware license", license_text(product, "hardware")),
            ("Documentation license", license_text(product, "documentation")),
            ("Licensor", "HUMAN-OWNED / MISSING: product.licensor"),
            ("Author", "HUMAN-OWNED / MISSING: product.author"),
            ("Design owner", "HUMAN-OWNED / MISSING: product.design_owner"),
        ]),
    ]
    if not any(row.get("tools") or row.get("consumables") for row in operations):
        sections[3] = "## Tools and consumables\n\n" + table(
            ("Step", "Items", "Tool or consumable"),
            [("MISSING: assembly.yaml drawing.operations[].tools / consumables", None, None)])
    bom_path = hw / "bom.csv"
    guide = (f"# {text(product_id)} build guide\n\n"
             f"<parts src=\"{html.escape(relative_link(bom_path, out), quote=True)}\" />\n\n"
             + "\n\n".join(sections) + "\n")
    return {
        "index.md": guide,
        "okh.toml": okh_document(hw, out, product, version, release, processes),
        "din-spec-3105-1-checklist.md": din_document(
            hw, out, version, release, processes, verification, decision_paths, requirements, product),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("hw", type=Path, help="hardware design record directory (hw/)")
    parser.add_argument("--version", required=True, help="built version label, such as v3")
    parser.add_argument("--out", required=True, type=Path,
                        help="project hw/docs/ record directory or a new .cad-work/ scratch directory")
    parser.add_argument("--rev", help="prepare the documents for release REV of --version before release.py seals it")
    parser.add_argument("--date", help="with --rev, the UTC date YYYY-MM-DD release.py will seal it; "
                                       "a sealed release gives its own")
    parser.add_argument("--replace", action="store_true",
                        help="overwrite hw/docs/ files that build_guide.py did not generate or that were edited since")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"v[1-9][0-9]*", args.version):
        parser.error("--version must be vN")
    if args.date is not None:
        if args.rev is None:
            parser.error("--date dates the release --rev names; pass --rev too")
        try:
            if datetime.date.fromisoformat(args.date).isoformat() != args.date:
                raise ValueError(args.date)
        except ValueError:
            parser.error("--date must be a calendar date YYYY-MM-DD")
    hw = args.hw.resolve()
    scratch = (hw / ".." / ".cad-work").resolve()
    docs = (hw / "docs").resolve()
    out = args.out.resolve()
    canonical_docs = out == docs
    scratch_output = out != scratch and scratch in out.parents
    if not (canonical_docs or scratch_output) or (out.exists() and any(out.iterdir()) and not canonical_docs):
        parser.error("--out must be hw/docs/ or a new directory under .cad-work/ beside hw/")
    names = ("index.md", "okh.toml", "din-spec-3105-1-checklist.md")
    owned = {name: generated_docs.state(out / name) for name in names}
    kept = [f"hw/docs/{name} " + ("was edited after build_guide.py generated it" if state == "edited"
                                  else "was not generated by build_guide.py")
            for name, state in owned.items() if state in ("edited", "foreign")]
    if kept and not args.replace:
        print(f"build_guide.py: refusing to overwrite {'; '.join(kept)}; nothing was written. Rerun with "
              "--replace to overwrite them.", file=sys.stderr)
        return 2
    try:
        documents = make_guide(args.hw, args.version, out, args.rev, args.date)
        out.mkdir(parents=True, exist_ok=True)
        for name, body in documents.items():
            (out / name).write_text(generated_docs.stamp(name, body), encoding="utf-8")
    except (GuideError, OSError, ValueError, KeyError) as exc:
        print(f"build_guide.py: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())