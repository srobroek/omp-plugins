#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["jsonschema>=4.23", "pyyaml>=6.0"]
# ///
"""Validate a CAD hardware design record and print a JSON findings report."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator, FormatChecker

SCHEMAS = Path(__file__).resolve().parent.parent / "schemas"
CSV_COLUMNS = {
    "bom.csv": ["level", "PN", "rev", "qty", "title", "material", "process", "make_buy", "supplier", "mass"],
    "verification.csv": ["requirement_id", "method", "criteria", "result", "evidence"],
}


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


def validate_document(
    data: Any, schema_name: str, path: str, findings: list[dict[str, str]]
) -> bool:
    schema_path = SCHEMAS / schema_name
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        findings.append(finding(str(schema_path), f"cannot load schema: {error}"))
        return False
    errors = sorted(
        Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(data),
        key=lambda error: list(error.absolute_path),
    )
    for error in errors:
        location = "/".join(str(part) for part in error.absolute_path)
        findings.append(finding(path, f"{location + ': ' if location else ''}{error.message}"))
    return not errors


def read_csv(path: Path, expected: list[str], findings: list[dict[str, str]]) -> list[dict[str, str]]:
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            if reader.fieldnames != expected:
                findings.append(finding(str(path), f"expected CSV columns in order: {','.join(expected)}"))
                return []
            return list(reader)
    except OSError as error:
        findings.append(finding(str(path), f"cannot read CSV: {error}"))
        return []


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
    for filename, schema in required_yaml.items():
        path = hw / filename
        if not path.is_file():
            findings.append(finding(str(path), "required record file is missing"))
            continue
        data = load_yaml(path, findings)
        documents[filename] = data
        validate_document(data, schema, str(path), findings)
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
            part_records[pn] = (part, str(part_path))
        if not part_records:
            findings.append(finding(str(parts_dir), "no part records found"))

    bom = read_csv(hw / "bom.csv", CSV_COLUMNS["bom.csv"], findings)
    for index, row in enumerate(bom, start=2):
        row_path = f"{hw / 'bom.csv'}:{index}"
        normalized: dict[str, Any] = dict(row)
        for number in ("level", "qty"):
            try:
                normalized[number] = int(row[number])
            except (TypeError, ValueError):
                findings.append(finding(row_path, f"{number} must be an integer"))
        for number in ("mass",):
            if row.get(number, "") == "":
                normalized[number] = None
            else:
                try:
                    normalized[number] = float(row[number])
                except (TypeError, ValueError):
                    findings.append(finding(row_path, f"{number} must be a positive number or blank"))
        normalized["supplier"] = row.get("supplier") or None
        validate_document(normalized, "bom-row.schema.json", row_path, findings)
        pn = row.get("PN", "")
        if pn not in part_records:
            findings.append(finding(row_path, f"BOM PN {pn!r} has no matching parts/<PN>/part.yaml"))
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

    levels: list[int] = []
    for index, row in enumerate(bom, start=2):
        try:
            level = int(row["level"])
        except (KeyError, TypeError, ValueError):
            continue
        if (not levels and level != 1) or (levels and level > levels[-1] + 1):
            findings.append(finding(f"{hw / 'bom.csv'}:{index}", "level must start at 1 and cannot skip a parent depth"))
        levels.append(level)

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
            if validate_document(manifest, "release-manifest.schema.json", str(path), findings):
                if isinstance(product, dict) and isinstance(manifest, dict) and manifest.get("product_id") != product.get("id"):
                    findings.append(finding(str(path), "manifest product_id does not match product.yaml id"))
                if not (hw / "verification.csv").is_file():
                    findings.append(finding(str(path), "release requires a verification.csv"))
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
