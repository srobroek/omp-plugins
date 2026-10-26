#!/usr/bin/env python3
"""Regression cases for the CAD design-record validator."""

from __future__ import annotations

import csv
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
TEMPLATE = SKILL / "assets" / "project-template"
VALIDATOR = SKILL / "scripts" / "validate.py"


class ValidateProject(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-record-test-")
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name) / "project"
        shutil.copytree(TEMPLATE, self.project)
        self.hw = self.project / "hw"

    def validate(self) -> tuple[subprocess.CompletedProcess[str], dict[str, object]]:
        result = subprocess.run(
            [sys.executable, str(VALIDATOR), str(self.project)],
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
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        start = lines.index("    min: -10")
        target = {"min": start, "max": start + 1, "nominal": start + 2}[field]
        lines[target] = f"    {field}: {value}"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_template_validates(self) -> None:
        result, report = self.validate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report, {"ok": True, "findings": []})

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
        text = path.read_text(encoding="utf-8").replace("method: T", "method: X", 1)
        path.write_text(text, encoding="utf-8")
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
        text = path.read_text(encoding="utf-8").replace("parent: LMP-0001", "parent: LMP-9999", 1)
        path.write_text(text, encoding="utf-8")
        result, report = self.validate()
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not exist", json.dumps(report["findings"]))

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


if __name__ == "__main__":
    unittest.main()
