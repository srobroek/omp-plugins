#!/usr/bin/env python3
"""Regression cases for CAD record validation and template model provenance."""

from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import yaml
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
CONCEPT = SKILL.parent / "cad-concept"
TEMPLATE = SKILL / "assets" / "project-template"
REFERENCE_MODELS = SKILL.parent / "cad-design" / "assets" / "reference" / "lamp-arm" / "cadquery"
VALIDATOR = SKILL / "scripts" / "validate.py"


class ValidateProject(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-record-test-")
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name) / "project"
        shutil.copytree(TEMPLATE, self.project)
        self.hw = self.project / "hw"

    def validate(self, validator: Path = VALIDATOR) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
        result = subprocess.run(
            [sys.executable, str(validator), str(self.project)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        return result, json.loads(result.stdout)

    def set_part(self, pn: str = "LMP-0001", rev: str = "X1") -> None:
        path = self.hw / "parts" / "LMP-0001" / "part.yaml"
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        lines = [f"PN: {pn}" if line.startswith("PN:") else line for line in lines]
        lines = [f"rev: {rev}" if line.startswith("rev:") else line for line in lines]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def set_joint(self, field: str, value: int) -> None:
        path = self.hw / "assembly.yaml"
        lines = path.read_text(encoding="utf-8").splitlines()
        start = lines.index("    min: -10")
        target = {"min": start, "max": start + 1, "nominal": start + 2}[field]
        lines[target] = f"    {field}: {value}"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_template_validates(self) -> None:
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report, {"ok": True, "findings": []})

    def test_template_models_match_cad_design_references_byte_for_byte(self) -> None:
        for part_dir in sorted((TEMPLATE / "hw" / "parts").iterdir()):
            model = part_dir / "model.py"
            reference = REFERENCE_MODELS / f"{part_dir.name}.py"
            with self.subTest(part=part_dir.name):
                self.assertEqual(model.read_bytes(), reference.read_bytes())

    def test_template_validates_fixed_pin_joints(self) -> None:
        assembly = yaml.safe_load((self.hw / "assembly.yaml").read_text(encoding="utf-8"))
        fixed = [joint for joint in assembly["joints"] if joint["type"] == "fixed"]
        self.assertEqual(len(fixed), 9)  # three pressed pins, two bushings, the insert, three rings
        self.assertTrue(all(joint["min"] == joint["max"] == joint["nominal"] == 0 for joint in fixed))
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["findings"], [])

    def test_rejects_bad_part_number(self) -> None:
        self.set_part(pn="LMP-one")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("PN", json.dumps(report["findings"]))

    def test_rejects_each_reserved_revision_letter(self) -> None:
        for revision in "IOQSXZ":
            with self.subTest(revision=revision):
                self.set_part(rev=revision)
                result, report = self.validate()
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn("rev", json.dumps(report["findings"]))

    def test_rejects_joint_minimum_greater_than_maximum(self) -> None:
        self.set_joint("min", 90)
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("minimum exceeds maximum", json.dumps(report["findings"]))

    def test_rejects_joint_nominal_outside_limits(self) -> None:
        self.set_joint("nominal", 81)
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("nominal is outside its limits", json.dumps(report["findings"]))

    def test_rejects_requirement_without_verification_method(self) -> None:
        path = self.hw / "requirements.yaml"
        path.write_text(path.read_text(encoding="utf-8").replace("method: T", "method: X", 1), encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("verification/method", json.dumps(report["findings"]))

    def test_rejects_bom_part_number_absent_from_parts(self) -> None:
        path = self.hw / "bom.csv"
        with path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
            columns = rows[0].keys()
        rows[0]["PN"] = "LMP-9999"
        with path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("has no matching", json.dumps(report["findings"]))

    def test_rejects_joint_parent_outside_assembly_parts(self) -> None:
        path = self.hw / "assembly.yaml"
        path.write_text(path.read_text(encoding="utf-8").replace("parent: LMP-0001", "parent: LMP-9999", 1), encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not exist", json.dumps(report["findings"]))

    def test_rejects_joint_type_not_supported_by_pose(self) -> None:
        path = self.hw / "assembly.yaml"
        path.write_text(path.read_text(encoding="utf-8").replace("type: revolute", "type: cylindrical", 1), encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("cylindrical", json.dumps(report["findings"]))

    def test_requires_verification_row_for_each_requirement_at_release(self) -> None:
        path = self.hw / "verification.csv"
        with path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
            columns = rows[0].keys()
        rows.pop()
        with path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("REQ-007 has no verification row", json.dumps(report["findings"]))

    def make_release_ready(self) -> None:
        for part_file in (self.hw / "parts").glob("*/part.yaml"):
            part_file.write_text(
                part_file.read_text(encoding="utf-8").replace("rev: X1", "rev: A"),
                encoding="utf-8",
            )
        bom_path = self.hw / "bom.csv"
        with bom_path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
            columns = rows[0].keys()
        for row in rows:
            row["rev"] = "A"
        with bom_path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        verification_path = self.hw / "verification.csv"
        with verification_path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
            columns = rows[0].keys()
        for row in rows:
            row["result"] = "pass"
        with verification_path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)

    def write_release(self, directory: str, rev: str, files: list[str]) -> None:
        release_dir = self.hw / "releases" / directory
        release_dir.mkdir(parents=True, exist_ok=True)
        (release_dir / "manifest.json").write_text(json.dumps({
            "product_id": "lamp-arm",
            "rev": rev,
            "released_at": "2026-10-26T00:00:00Z",
            "files": files,
            "checks": {"record-validation": "pass"},
        }), encoding="utf-8")

    def test_accepts_release_with_existing_files_and_verified_released_parts(self) -> None:
        self.make_release_ready()
        self.write_release("A", "A", ["hw/product.yaml", "hw/bom.csv"])
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["findings"], [])

    def test_rejects_release_with_mismatched_directory_missing_file_planned_checks_and_prototype(self) -> None:
        self.write_release("B", "A", ["hw/product.yaml", "hw/not-present.step"])
        result, report = self.validate()
        findings = json.dumps(report["findings"])
        self.assertEqual(result.returncode, 1)
        self.assertIn("directory name does not match manifest rev", findings)
        self.assertIn("release file does not exist within project: hw/not-present.step", findings)
        self.assertIn("verification result must be pass or waived", findings)
        self.assertIn("release cannot include prototype revision X1", findings)

    def test_rejects_part_with_missing_decision_reference(self) -> None:
        path = self.hw / "parts" / "LMP-0001" / "part.yaml"
        text = path.read_text(encoding="utf-8").replace("decisions: [DR-002, DR-004]", "decisions: [DR-999]")
        path.write_text(text, encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("decision DR-999 does not exist", json.dumps(report["findings"]))

    def test_validates_optional_concept_handoff(self) -> None:
        source = CONCEPT / "assets" / "examples" / "lamp-arm.scene.json"
        scene = json.loads(source.read_text(encoding="utf-8"))
        scene["chosen"] = scene["variants"][0]["id"]
        scene_path = self.hw / "concept" / "lamp-arm.scene.json"
        scene_path.parent.mkdir(parents=True)
        self.addCleanup(shutil.rmtree, scene_path.parent, ignore_errors=True)
        scene_path.write_text(json.dumps(scene), encoding="utf-8")
        handoff_path = scene_path.parent / "handoff.json"
        handoff = subprocess.run(
            [sys.executable, str(CONCEPT / "scripts" / "concept.py"), "handoff", str(scene_path), "--out", str(handoff_path)],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(handoff.returncode, 0, handoff.stdout + handoff.stderr)
        self.assertTrue(json.loads(handoff.stdout)["ok"])
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["findings"], [])

    def test_reports_info_when_concept_handoff_schema_is_missing(self) -> None:
        handoff_path = self.hw / "concept" / "handoff.json"
        handoff_path.parent.mkdir(parents=True)
        handoff_path.write_text("{}", encoding="utf-8")
        validator_copy = self.project / "skill" / "scripts" / "validate.py"
        validator_copy.parent.mkdir(parents=True)
        shutil.copy2(VALIDATOR, validator_copy)
        shutil.copytree(SKILL / "schemas", self.project / "skill" / "schemas")
        result, report = self.validate(validator_copy)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(any(item["severity"] == "info" and "skipped handoff schema validation" in item["message"] for item in report["findings"]))


if __name__ == "__main__":
    unittest.main()
