#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["defusedxml>=0.7.1", "pyyaml>=6.0"]
# ///
"""Generate a structured GitBuilding guide from a hardware record and built version.

Usage: build_guide.py HW --version vN --out DIR
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import math
import os
import re
import sys
from collections import defaultdict
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


def text(value: Any) -> str:
    if value is None or not str(value).strip():
        return "not recorded"
    return str(value).strip().replace("|", "\\|").replace("\n", " ")


def table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    lines.extend("| " + " | ".join(text(value) for value in row) + " |" for row in rows)
    return "\n".join(lines)


def relative_link(source: Path, out: Path) -> str:
    return quote(Path(os.path.relpath(source, out)).as_posix(), safe="/.-_:@")


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


def release_manifest(hw: Path, product_id: str, version: str) -> Path | None:
    """The newest release of `version`: a version 2 manifest names it in frozen.version, a version 1
    manifest lists its files in place. None when no release holds that version."""
    releases = hw / "releases"
    if not releases.is_dir():
        return None
    candidates = []
    for path in releases.glob("*/manifest.json"):
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(manifest, dict) or manifest.get("product_id") != product_id:
            continue
        if "schema_version" in manifest:
            frozen = manifest.get("frozen")
            holds_version = isinstance(frozen, Mapping) and frozen.get("version") == version
        else:
            holds_version = any(re.search(rf"(?:^|/)versions/{re.escape(version)}(?:/|$)", item)
                                for item in manifest.get("files", []) if isinstance(item, str))
        if holds_version:
            candidates.append((str(manifest.get("released_at", "")), str(path), path))
    return max(candidates, default=(None, None, None))[2]


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


def make_guide(hw: Path, version: str, out: Path) -> str:
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
    interfaces = read_yaml(hw / "interfaces.yaml", optional=True).get("interfaces", [])
    bom_rows = read_csv(hw / "bom.csv", optional=True)
    verification = read_csv(hw / "verification.csv", optional=True)
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
    manifest_path = release_manifest(hw, str(product_id or ""), version)
    overview.append(("Release manifest", markdown_link(
        f"hw/releases/{manifest_path.parent.name}/manifest.json", manifest_path, out) if manifest_path else None))

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
            [(row.get("requirement_id"), row.get("method"), row.get("criteria"), row.get("result"), row.get("evidence"))
             for row in verification] or [(None,) * 5]),
    ]
    bom_path = hw / "bom.csv"
    return (f"# {text(product_id)} build guide\n\n"
            f"<parts src=\"{html.escape(relative_link(bom_path, out), quote=True)}\" />\n\n"
            + "\n\n".join(sections) + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("hw", type=Path, help="hardware design record directory (hw/)")
    parser.add_argument("--version", required=True, help="built version label, such as v3")
    parser.add_argument("--out", required=True, type=Path, help="new output directory under .cad-work/ beside hw/")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"v[1-9][0-9]*", args.version):
        parser.error("--version must be vN")
    scratch = (args.hw / ".." / ".cad-work").resolve()
    out = args.out.resolve()
    if out == scratch or scratch not in out.parents or (out.exists() and any(out.iterdir())):
        parser.error("--out must be a new directory under .cad-work/ beside hw/")
    try:
        content = make_guide(args.hw, args.version, out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "index.md").write_text(content, encoding="utf-8")
    except (GuideError, OSError, ValueError, KeyError) as exc:
        print(f"build_guide.py: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())