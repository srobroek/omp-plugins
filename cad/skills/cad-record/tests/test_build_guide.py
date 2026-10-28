#!/usr/bin/env python3
"""Structured build-guide generation from lamp and minimal project records."""

from __future__ import annotations

import csv
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

SKILL = Path(__file__).resolve().parents[1]
SCRIPT = SKILL / "scripts" / "build_guide.py"
TEMPLATE = SKILL / "assets" / "project-template" / "hw"
COVERAGE = {"rows": [{
    "kind": "assembly_operation",
    "operation": "press_base_pin",
    "measured": {"gap": 0.29999999999999716},
}]}


class BuildGuide(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-build-guide-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.hw = self.root / "hw"
        self.hw.mkdir()
        self.out = self.root / "docs"

    def copy_lamp_template(self) -> Path:
        shutil.copytree(TEMPLATE, self.hw, dirs_exist_ok=True)
        return self.hw

    def make_version(self, hw: Path, version: str) -> None:
        version_parts = hw / "versions" / version / "parts"
        version_parts.mkdir(parents=True)
        bom = hw / "bom.csv"
        built_parts = {}
        if bom.is_file():
            with bom.open(newline="", encoding="utf-8") as stream:
                for row in csv.DictReader(stream):
                    if row.get("make_buy") == "make":
                        pn = row["PN"]
                        (version_parts / f"{pn}.step").write_text("fixture STEP", encoding="utf-8")
                        built_parts[pn] = {"step": f"parts/{pn}.step"}
        (version_parts.parent / "manifest.json").write_text(
            json.dumps({"label": version, "parts": built_parts}), encoding="utf-8"
        )

    def copy_coverage(self, hw: Path) -> None:
        target = hw / "versions" / "v1" / "assembly" / "coverage.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(COVERAGE), encoding="utf-8")

    def generate(self, hw: Path | None = None, version: str = "v1") -> str:
        project_hw = hw or self.hw
        result = subprocess.run(
            ["uv", "run", "--script", str(SCRIPT), str(project_hw), "--version", version, "--out", str(self.out)],
            capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return (self.out / "index.md").read_text(encoding="utf-8")

    def test_lamp_template_reuses_measured_notes_and_structured_tools(self) -> None:
        hw = self.copy_lamp_template()
        self.make_version(hw, "v1")
        self.copy_coverage(hw)
        guide = self.generate(hw)
        self.assertIn('<parts src="../hw/bom.csv" />', guide)
        for heading in ("Overview", "Parts to make", "Parts to buy", "Tools and consumables",
                        "Assembly steps", "Checks before use"):
            self.assertIn(f"## {heading}", guide)
        self.assertIn("| 11 | LMP-0011 |", guide)
        self.assertIn("OPEN — manufacturer_part_number:", guide)
        self.assertIn("Press item 5 into item 2 along -Z", guide)
        self.assertIn("0.3 mm off the hub top face, as modelled", guide)
        self.assertIn("Press item 6 into item 2 along -Y", guide)
        self.assertIn("by the modelled gap; gap not measured: run the assembly drawing for v1", guide)
        self.assertIn("Press item 7 into item 3 along -Y", guide)
        self.assertIn("fit 5 H7/p6 (IF-001)", guide)
        self.assertIn("## Assembly steps\n\n1. Heat-set item 8 into item 1", guide)
        self.assertIn("9. Fit ring item 11 onto item 7", guide)
        self.assertLess(guide.index("1. Heat-set item 8"), guide.index("2. Heat-set item 9"))
        self.assertLess(guide.index("2. Heat-set item 9"), guide.index("3. Heat-set item 10"))
        self.assertIn("| 4 | 5 into 2 | Arbor press or pin punch |", guide)
        self.assertIn("| 5 | 11 onto 5 | External circlip pliers |", guide)
        self.assertEqual(guide.count("Arbor press or pin punch"), 3)
        self.assertIn("REQ-001", guide)
        self.assertIn("planned", guide)

    def test_unmeasured_standoff_step_has_readable_gap_prompt(self) -> None:
        hw = self.copy_lamp_template()
        self.make_version(hw, "v1")
        guide = self.generate(hw)
        self.assertIn("stands off the hub top face by the modelled gap; gap not measured: run the assembly drawing for v1", guide)

    def test_minimal_record_lists_fields_and_item_numbers(self) -> None:
        hw = self.root / "minimal-hw"
        (hw / "parts" / "TST-0001").mkdir(parents=True)
        (hw / "versions" / "v1" / "parts").mkdir(parents=True)
        (hw / "product.yaml").write_text("id: minimal\n", encoding="utf-8")
        (hw / "parts" / "TST-0001" / "part.yaml").write_text(
            "PN: TST-0001\nrev: A\ntitle: Test part\nmaterial: steel\nprocess: cnc\nmake_buy: make\n",
            encoding="utf-8",
        )
        (hw / "bom.csv").write_text(
            "level,PN,rev,qty,title,material,process,make_buy\n"
            "1,TST-0001,A,1,Test part,steel,cnc,make\n", encoding="utf-8"
        )
        (hw / "assembly.yaml").write_text(
            "subassemblies:\n  - {id: main, title: Main, parts: [TST-0001]}\n"
            "joints: []\ndrawing:\n  number: TST-ASM\n  rev: A\n  title: Test assembly\n"
            "  views: [{id: front, kind: assembled, direction: front}]\n"
            "  items: [{item: 7, PN: TST-0001}]\n", encoding="utf-8"
        )
        (hw / "versions" / "v1" / "parts" / "TST-0001.step").write_text("fixture STEP", encoding="utf-8")
        (hw / "versions" / "v1" / "manifest.json").write_text(json.dumps({
            "label": "v1", "parts": {"TST-0001": {"step": "parts/TST-0001.step"}},
        }), encoding="utf-8")
        guide = self.generate(hw)
        self.assertIn("| Product | minimal |", guide)
        self.assertIn("| Version | v1 |", guide)
        self.assertIn("| 7 | TST-0001 | Test part | 1 | steel | cnc |", guide)
        self.assertIn("## Parts to buy\n\n| Item no.", guide)
        self.assertIn("## Assembly steps\n\nnot recorded", guide)
        self.assertIn("## Checks before use\n\n| Requirement", guide)
        self.assertEqual(guide.count("<parts "), 1)

    def test_generic_empty_record_outputs_not_recorded_values(self) -> None:
        hw = self.root / "empty-hw"
        hw.mkdir()
        (hw / "versions" / "v1").mkdir(parents=True)
        (hw / "versions" / "v1" / "manifest.json").write_text(
            json.dumps({"label": "v1", "parts": {}}), encoding="utf-8"
        )
        guide = self.generate(hw)
        self.assertIn("| Product | not recorded |", guide)
        self.assertIn("## Parts to make\n\n| Item no.", guide)
        self.assertIn("## Parts to buy\n\n| Item no.", guide)
        self.assertIn("## Tools and consumables\n\n| Step | Items |", guide)
        self.assertIn("## Assembly steps\n\nnot recorded", guide)
        self.assertIn("## Checks before use\n\n| Requirement", guide)

    def test_buy_identity_open_fields_remain_visible(self) -> None:
        hw = self.copy_lamp_template()
        self.make_version(hw, "v1")
        part_path = hw / "parts" / "LMP-0008" / "part.yaml"
        part = yaml.safe_load(part_path.read_text(encoding="utf-8"))
        part["procurement"].setdefault("open", {})["supplier_part_number"] = "Supplier has not assigned its order code"
        part_path.write_text(yaml.safe_dump(part, sort_keys=False), encoding="utf-8")
        guide = self.generate(hw)
        self.assertIn("OPEN — supplier_part_number: Supplier has not assigned its order code", guide)

    def test_missing_version_manifest_fails_without_output(self) -> None:
        hw = self.root / "missing-build"
        hw.mkdir()
        (hw / "versions" / "v1").mkdir(parents=True)
        result = subprocess.run(
            ["uv", "run", "--script", str(SCRIPT), str(hw), "--version", "v1", "--out", str(self.out)],
            capture_output=True, text=True, timeout=180,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("version manifest is missing", result.stderr)
        self.assertFalse((self.out / "index.md").exists())


if __name__ == "__main__":
    unittest.main()
