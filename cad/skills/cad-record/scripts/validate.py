#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["jsonschema>=4.23", "pyyaml>=6.0"]
# ///
"""Validate a CAD hardware design record and print a JSON findings report."""

from __future__ import annotations

import argparse
import csv
import functools
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

SCHEMAS = Path(__file__).resolve().parent.parent / "schemas"
BOM_COLUMNS = ["level", "PN", "rev", "qty", "title", "material", "process", "make_buy", "supplier", "mass"]
# Appended procurement columns, generated from part.yaml `procurement`; a BOM carries all or none of them.
BOM_PROCUREMENT_COLUMNS = ["unit", "designation", "manufacturer", "manufacturer_part_number",
                           "supplier_part_number", "specification_ref", "specification_rev"]
CSV_COLUMNS = {
    "bom.csv": (BOM_COLUMNS, BOM_COLUMNS + BOM_PROCUREMENT_COLUMNS),
    "verification.csv": (["requirement_id", "method", "criteria", "result", "evidence"],),
}
DATUM_LABEL = re.compile(r"[A-HJ-NPR-Z]{1,2}")


def finding(path: str, message: str, *, severity: str = "error") -> dict[str, str]:
    return {"path": path, "message": message, "severity": severity}


def load_yaml(path: Path, findings: list[dict[str, str]]) -> Any:
    try:
        with path.open(encoding="utf-8") as stream:
            return yaml.safe_load(stream)
    except (OSError, yaml.YAMLError) as error:
        findings.append(finding(str(path), f"cannot read YAML: {error}"))
        return None


def load_json(path: Path, findings: list[dict[str, str]]) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        findings.append(finding(str(path), f"cannot read JSON: {error}"))
        return None


@functools.cache
def schema_registry() -> Registry:
    """Every bundled schema by its $id, so `drawing.schema.json#/$defs/...` references resolve offline."""
    resources = []
    for path in sorted(SCHEMAS.glob("*.schema.json")):
        contents = json.loads(path.read_text(encoding="utf-8"))
        resources.append((contents["$id"], Resource.from_contents(contents)))
    return Registry().with_resources(resources)


def validate_document(
    data: Any, schema_name: str, path: str, findings: list[dict[str, str]]
) -> bool:
    schema_path = SCHEMAS / schema_name
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        findings.append(finding(str(schema_path), f"cannot load schema: {error}"))
        return False
    validator = Draft202012Validator(schema, registry=schema_registry(), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(data), key=lambda error: list(error.absolute_path))
    for error in errors:
        location = "/".join(str(part) for part in error.absolute_path)
        findings.append(finding(path, f"{location + ': ' if location else ''}{error.message}"))
    return not errors


def read_csv(path: Path, accepted: tuple[list[str], ...], findings: list[dict[str, str]]) -> list[dict[str, str]]:
    """Rows of a CSV whose header is exactly one of the `accepted` column lists."""
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            if reader.fieldnames not in accepted:
                orders = " or ".join(",".join(columns) for columns in accepted)
                findings.append(finding(str(path), f"expected CSV columns in order: {orders}"))
                return []
            return list(reader)
    except OSError as error:
        findings.append(finding(str(path), f"cannot read CSV: {error}"))
        return []


def procurement_cells(part: dict[str, Any]) -> dict[str, str | None]:
    """The appended BOM columns as cad-bom generates them from a part.yaml; `unit` names what qty counts."""
    procurement = part.get("procurement") or {}
    specification = procurement.get("specification") or {}
    return {
        "unit": "pcs",
        "designation": procurement.get("designation"),
        "manufacturer": procurement.get("manufacturer"),
        "manufacturer_part_number": procurement.get("manufacturer_part_number"),
        "supplier_part_number": procurement.get("supplier_part_number"),
        "specification_ref": specification.get("reference"),
        "specification_rev": specification.get("revision"),
    }


def stated_general_tolerance(policy: dict[str, Any]) -> str | float:
    """The `general_tolerance` text or number that states a structured tolerance policy."""
    if policy["kind"] == "standard":
        return f"ISO 2768-{policy['class']}"  # the only standard policy the schema admits is ISO 2768-1:1989
    return policy["linear_mm"]


def check_product_drawing(product: dict[str, Any], path: str, findings: list[dict[str, str]]) -> None:
    drawing = product.get("drawing")
    if not isinstance(drawing, dict):
        return
    name = drawing["general_tolerance_policy"]
    policy = drawing["tolerance_policies"].get(name)
    if policy is None:
        findings.append(finding(path, f"drawing/general_tolerance_policy {name!r} is not in drawing/tolerance_policies"))
    elif product["general_tolerance"] != stated_general_tolerance(policy):
        findings.append(finding(path, f"general_tolerance {product['general_tolerance']!r} does not state the {name} "
                                      f"policy; expected {stated_general_tolerance(policy)!r}"))
    family = {"iso": "ISO ", "asme": "ASME "}[product["regime"]]
    dimensioning = drawing["standards"]["dimensioning"]
    if not dimensioning.startswith(family):
        findings.append(finding(path, f"drawing/standards/dimensioning {dimensioning!r} does not belong to the "
                                      f"{product['regime']} regime"))


def check_part_drawing(part: dict[str, Any], path: str, product_drawing: dict[str, Any] | None,
                       findings: list[dict[str, str]]) -> None:
    """Cross-references inside part.yaml `drawing` and to product.yaml's tolerance policies."""
    drawing = part.get("drawing")
    if not isinstance(drawing, dict):
        return
    datums = set(drawing.get("datum_features", {}))

    def datum(where: str, ref: Any) -> None:
        if isinstance(ref, str) and DATUM_LABEL.fullmatch(ref) and ref not in datums:
            findings.append(finding(path, f"drawing/{where}: datum {ref} is not declared in drawing/datum_features"))

    frame = drawing.get("coordinate_frame", {})
    origin = frame.get("origin", {})
    for ref in [*origin.get("intersection", []), origin.get("at")]:
        datum("coordinate_frame/origin", ref)
    for axis in ("x", "y", "z"):
        for key, ref in frame.get(axis, {}).items():
            datum(f"coordinate_frame/{axis}/{key}", ref)
    for key, ref in drawing.get("manufacturing", {}).get("build_direction", {}).items():
        datum(f"manufacturing/build_direction/{key}", ref)

    views = drawing.get("views", [])
    view_ids = [view["id"] for view in views]
    for duplicate in sorted({v for v in view_ids if view_ids.count(v) > 1}):
        findings.append(finding(path, f"drawing/views: view id {duplicate} is used more than once"))
    for index, view in enumerate(views):
        for key in ("normal_to", "along_axis", "parallel_to", "perpendicular_to", "toward"):
            datum(f"views/{index}/{key}", view.get(key))
        through = view.get("through")
        for ref in through if isinstance(through, list) else [through]:
            datum(f"views/{index}/through", ref)
        if "opposite" in view and (view["opposite"] == view["id"] or view["opposite"] not in view_ids):
            findings.append(finding(path, f"drawing/views/{index}/opposite: {view['opposite']!r} is not another view"))

    policies: list[tuple[str, str]] = []
    if "tolerance_policy" in drawing:
        policies.append(("tolerance_policy", drawing["tolerance_policy"]))
    for feature, intent in drawing.get("features", {}).items():
        datum(f"features/{feature}/axial_location_from", intent.get("axial_location_from"))
        if "tolerance_policy" in intent:
            policies.append((f"features/{feature}/tolerance_policy", intent["tolerance_policy"]))
    dimensions = drawing.get("dimensions", [])
    dimension_ids = [dimension["id"] for dimension in dimensions]
    for duplicate in sorted({d for d in dimension_ids if dimension_ids.count(d) > 1}):
        findings.append(finding(path, f"drawing/dimensions: dimension id {duplicate} is used more than once"))
    for index, dimension in enumerate(dimensions):
        for ref in dimension.get("datum_frame", []):
            datum(f"dimensions/{index}/datum_frame", ref)
        tolerance = dimension.get("tolerance", {})
        if "policy" in tolerance:
            policies.append((f"dimensions/{index}/tolerance/policy", tolerance["policy"]))
        lower, upper = tolerance.get("deviation_mm", (0.0, 1.0))
        if lower >= upper:
            findings.append(finding(path, f"drawing/dimensions/{index}/tolerance/deviation_mm: lower {lower} "
                                          f"must be below upper {upper}"))

    defined = (product_drawing or {}).get("tolerance_policies", {})
    for where, name in policies:
        policy = defined.get(name)
        if policy is None:
            findings.append(finding(path, f"drawing/{where}: {name!r} is not a product.yaml drawing/tolerance_policies entry"))
        elif part["process"] not in policy["applies_to"]:
            findings.append(finding(path, f"drawing/{where}: policy {name} applies to {', '.join(policy['applies_to'])}, "
                                          f"not to process {part['process']}"))


def check_procurement(part: dict[str, Any], path: str, hw: Path, findings: list[dict[str, str]]) -> None:
    procurement = part.get("procurement")
    if not isinstance(procurement, dict):
        return
    mode = procurement["mode"]
    if mode == "catalog" and part["make_buy"] != "buy":
        findings.append(finding(path, "procurement/mode catalog requires make_buy: buy"))
    drawing_type = (part.get("drawing") or {}).get("type")
    if drawing_type is not None and (mode == "made_to_drawing") != (drawing_type == "detail"):
        findings.append(finding(path, f"procurement/mode {mode} contradicts drawing/type {drawing_type}: a made-to-drawing "
                                      "part needs a detail drawing, a catalogue item a vendor_specification or "
                                      "source_control sheet"))
    specification = procurement.get("specification")
    if specification is None:
        return
    root = hw.resolve()
    artifact = root / specification["artifact"]
    try:
        artifact.resolve().relative_to(root)
        data = artifact.read_bytes()
    except (OSError, ValueError):
        findings.append(finding(path, f"procurement/specification/artifact {specification['artifact']!r} is not a file in hw/"))
        return
    if hashlib.sha256(data).hexdigest() != specification["sha256"]:
        findings.append(finding(path, f"procurement/specification/sha256 does not match {specification['artifact']}"))


def check_interfaces(interfaces: dict[str, Any], path: str, part_records: dict[str, Any],
                     findings: list[dict[str, str]]) -> None:
    """Fit endpoints and heat-set pairs must name existing parts."""
    for index, interface in enumerate(interfaces["interfaces"]):
        limits = interface.get("limits", {})
        for kind in ("press_fit", "running_fit"):
            fit = limits.get(kind)
            if not isinstance(fit, dict):
                continue
            where = f"interfaces/{index}/limits/{kind}"
            if "pair" in fit:
                pns = fit["pair"]
            else:
                pns = [fit["hole"]["PN"], fit["shaft"]["PN"]]
                if pns[0] == pns[1]:
                    findings.append(finding(path, f"{where}: hole and shaft are both on {pns[0]}"))
            for pn in pns:
                if pn not in part_records:
                    findings.append(finding(path, f"{where}: part {pn} does not exist"))
        for number, entry in enumerate(limits.get("heat_set", [])):
            where = f"interfaces/{index}/limits/heat_set/{number}"
            for pn in entry["pair"]:
                if pn not in part_records:
                    findings.append(finding(path, f"{where}: part {pn} does not exist"))
            lower, upper = entry.get("hole_tol", (0.0, 0.0))
            if lower > upper:
                findings.append(finding(path, f"{where}/hole_tol: lower deviation {lower} exceeds upper {upper}"))


def validate_project(project_dir: Path) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    hw = project_dir / "hw" if (project_dir / "hw").is_dir() else project_dir
    required_yaml = {
        "product.yaml": "product.schema.json",
        "requirements.yaml": "requirements.schema.json",
        "interfaces.yaml": "interfaces.schema.json",
        "assembly.yaml": "assembly.schema.json",
    }
    documents: dict[str, Any] = {}
    valid: dict[str, bool] = {}
    for filename, schema in required_yaml.items():
        path = hw / filename
        if not path.is_file():
            findings.append(finding(str(path), "required record file is missing"))
            continue
        data = load_yaml(path, findings)
        documents[filename] = data
        valid[filename] = validate_document(data, schema, str(path), findings)
    product_drawing = None
    if valid.get("product.yaml"):
        check_product_drawing(documents["product.yaml"], str(hw / "product.yaml"), findings)
        product_drawing = documents["product.yaml"].get("drawing")
    concept_handoff = hw / "concept" / "handoff.json"
    if concept_handoff.is_file():
        concept_schema = Path(__file__).resolve().parents[2] / "cad-concept" / "assets" / "schemas" / "handoff.schema.json"
        if concept_schema.is_file():
            schema = load_json(concept_schema, findings)
            handoff = load_json(concept_handoff, findings)
            if schema is not None and handoff is not None:
                errors = sorted(
                    Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(handoff),
                    key=lambda error: list(error.absolute_path),
                )
                for error in errors:
                    location = "/".join(str(part) for part in error.absolute_path)
                    findings.append(finding(str(concept_handoff), f"{location + ': ' if location else ''}{error.message}"))
        else:
            findings.append(finding(str(concept_handoff), f"skipped handoff schema validation; schema not found at {concept_schema}", severity="info"))
    part_records: dict[str, tuple[dict[str, Any], str]] = {}
    parts_dir = hw / "parts"
    if not parts_dir.is_dir():
        findings.append(finding(str(parts_dir), "parts directory is missing"))
    else:
        for part_path in sorted(parts_dir.glob("*/part.yaml")):
            part = load_yaml(part_path, findings)
            if not validate_document(part, "part.schema.json", str(part_path), findings):
                continue
            if not isinstance(part, dict):
                continue
            pn = part["PN"]
            if part_path.parent.name != pn:
                findings.append(finding(str(part_path), f"directory name does not match PN {pn}"))
            if pn in part_records:
                findings.append(finding(str(part_path), f"duplicate part number {pn}"))
            for decision in part.get("decisions", []):
                decision_path = hw / "decisions" / f"{decision}.md"
                if not decision_path.is_file():
                    findings.append(finding(str(part_path), f"decision {decision} does not exist at decisions/{decision}.md"))
            check_part_drawing(part, str(part_path), product_drawing, findings)
            check_procurement(part, str(part_path), hw, findings)
            part_records[pn] = (part, str(part_path))
        if not part_records:
            findings.append(finding(str(parts_dir), "no part records found"))
    if valid.get("interfaces.yaml"):
        check_interfaces(documents["interfaces.yaml"], str(hw / "interfaces.yaml"), part_records, findings)

    bom = read_csv(hw / "bom.csv", CSV_COLUMNS["bom.csv"], findings)
    bom_levels: list[int | None] = []
    for index, row in enumerate(bom, start=2):
        row_path = f"{hw / 'bom.csv'}:{index}"
        normalized: dict[str, Any] = dict(row)
        for number in ("level", "qty"):
            try:
                normalized[number] = int(row[number])
            except (TypeError, ValueError):
                findings.append(finding(row_path, f"{number} must be an integer"))
                if number == "level":
                    normalized[number] = None
        bom_levels.append(normalized.get("level"))
        if row.get("mass", "") == "":
            normalized["mass"] = None
        else:
            try:
                normalized["mass"] = float(row["mass"])
            except (TypeError, ValueError):
                findings.append(finding(row_path, "mass must be a positive number or blank"))
        for field in ("rev", "title", "material", "process", "make_buy", "supplier"):
            normalized[field] = row.get(field) or None
        for field in BOM_PROCUREMENT_COLUMNS:
            if field in row:
                normalized[field] = row[field] or None
        validate_document(normalized, "bom-row.schema.json", row_path, findings)

    for position, row in enumerate(bom):
        index = position + 2
        row_path = f"{hw / 'bom.csv'}:{index}"
        level = bom_levels[position]
        has_children = level == 0 or (
            level is not None
            and position + 1 < len(bom_levels)
            and bom_levels[position + 1] is not None
            and bom_levels[position + 1] > level
        )
        pn = row.get("PN", "")
        if pn not in part_records:
            if not has_children:
                findings.append(finding(row_path, f"BOM PN {pn!r} has no matching parts/<PN>/part.yaml and is not an assembly"))
            continue
        part, part_path = part_records[pn]
        for field, part_field in (("rev", "rev"), ("title", "title"), ("material", "material"),
                                  ("process", "process"), ("make_buy", "make_buy"),
                                  ("supplier", "supplier")):
            bom_value = row.get(field) or None
            part_value = part.get(part_field)
            if bom_value != part_value:
                findings.append(finding(row_path, f"{field} {bom_value!r} does not match {part_path} ({part_value!r})"))
        try:
            mass = float(row["mass"]) if row.get("mass") else None
        except ValueError:
            mass = None
        if mass != part.get("mass_target"):
            findings.append(finding(row_path, f"mass {mass!r} does not match {part_path} mass_target ({part.get('mass_target')!r})"))
        if "unit" in row:
            for field, part_value in procurement_cells(part).items():
                bom_value = row.get(field) or None
                if bom_value != part_value:
                    findings.append(finding(row_path, f"{field} {bom_value!r} does not match {part_path} ({part_value!r})"))

    previous_level: int | None = None
    for index, level in enumerate(bom_levels, start=2):
        if level is None:
            continue
        if (previous_level is None and level not in (0, 1)) or (
            previous_level is not None and level > previous_level + 1
        ):
            findings.append(finding(f"{hw / 'bom.csv'}:{index}", "level must start at 0 or 1 and cannot skip a parent depth"))
        previous_level = level

    assembly = documents.get("assembly.yaml")
    if isinstance(assembly, dict):
        subassemblies = assembly.get("subassemblies", [])
        assembly_parts = {pn for item in subassemblies if isinstance(item, dict) for pn in item.get("parts", [])}
        for joint in assembly.get("joints", []):
            if not isinstance(joint, dict):
                continue
            joint_id = joint.get("id", "joint")
            for endpoint in ("parent", "child"):
                pn = joint.get(endpoint)
                if pn not in part_records:
                    findings.append(finding(str(hw / "assembly.yaml"), f"{joint_id} {endpoint} part {pn!r} does not exist"))
                if pn not in assembly_parts:
                    findings.append(finding(str(hw / "assembly.yaml"), f"{joint_id} {endpoint} part {pn!r} is not included in any subassembly"))
            try:
                lower, nominal, upper = joint["min"], joint["nominal"], joint["max"]
                if lower > upper:
                    findings.append(finding(str(hw / "assembly.yaml"), f"{joint_id} minimum exceeds maximum"))
                if not lower <= nominal <= upper:
                    findings.append(finding(str(hw / "assembly.yaml"), f"{joint_id} nominal is outside its limits"))
            except (KeyError, TypeError):
                pass

    requirements = documents.get("requirements.yaml")
    verification = read_csv(hw / "verification.csv", CSV_COLUMNS["verification.csv"], findings)
    seen_requirement_ids: set[str] = set()
    for index, row in enumerate(verification, start=2):
        row_path = f"{hw / 'verification.csv'}:{index}"
        validate_document(row, "verification-row.schema.json", row_path, findings)
        req_id = row.get("requirement_id", "")
        if req_id in seen_requirement_ids:
            findings.append(finding(row_path, f"duplicate verification for {req_id}"))
        seen_requirement_ids.add(req_id)
    if isinstance(requirements, dict):
        known = {item.get("id") for item in requirements.get("requirements", []) if isinstance(item, dict)}
        for req_id in sorted(known - seen_requirement_ids):
            findings.append(finding(str(hw / "verification.csv"), f"requirement {req_id} has no verification row"))
        for req_id in sorted(seen_requirement_ids - known):
            findings.append(finding(str(hw / "verification.csv"), f"unknown requirement {req_id}"))

    manifest_dir = hw / "releases"
    manifests = sorted(manifest_dir.glob("*/manifest.json")) if manifest_dir.is_dir() else []
    if manifests:
        product = documents.get("product.yaml")
        for path in manifests:
            manifest = load_json(path, findings)
            valid_manifest = validate_document(manifest, "release-manifest.schema.json", str(path), findings)
            if not valid_manifest or not isinstance(manifest, dict):
                continue
            if isinstance(product, dict) and manifest.get("product_id") != product.get("id"):
                findings.append(finding(str(path), "manifest product_id does not match product.yaml id"))
            if path.parent.name != manifest.get("rev"):
                findings.append(finding(str(path), "release directory name does not match manifest rev"))
            project_root = hw.parent if hw == project_dir else project_dir
            root = project_root.resolve()
            for file_name in manifest.get("files", []):
                candidate = root / file_name
                try:
                    candidate.resolve().relative_to(root)
                    exists = candidate.is_file()
                except (OSError, ValueError):
                    exists = False
                if not exists:
                    findings.append(finding(str(path), f"release file does not exist within project: {file_name}"))
            verification_path = hw / "verification.csv"
            if not verification_path.is_file():
                findings.append(finding(str(path), "release requires a verification.csv"))
            else:
                for index, row in enumerate(verification, start=2):
                    if row.get("result") not in {"pass", "waived"}:
                        findings.append(finding(f"{verification_path}:{index}", "release verification result must be pass or waived"))
            for pn, (part, part_path) in part_records.items():
                if isinstance(part.get("rev"), str) and part["rev"].startswith("X"):
                    findings.append(finding(part_path, f"release cannot include prototype revision {part['rev']} for {pn}"))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path, help="project directory containing hw/ or the hw/ directory itself")
    args = parser.parse_args()
    if not args.project_dir.exists() or not args.project_dir.is_dir():
        print(json.dumps({"ok": False, "findings": [finding(str(args.project_dir), "project directory does not exist")]}))
        return 2
    findings = validate_project(args.project_dir)
    failures = [item for item in findings if item.get("severity") != "info"]
    print(json.dumps({"ok": not failures, "findings": findings}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "findings": [finding("validate.py", f"infrastructure error: {error}")]}))
        raise SystemExit(2)
