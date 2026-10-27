#!/usr/bin/env python3
"""Part drawings: annotation-class layout rules, and the completeness gate on real lamp template parts.

Run: uv run --with pyyaml --with defusedxml --with jsonschema python -m unittest discover -s cad/skills/cad-drawings/tests
The gate tests build the lamp template through ``cad_model.py run`` (CadQuery runner, needs ``uv``;
a cold OCP import can take minutes) and draw the LMP-0005 pin and the catalogue parts in FreeCAD's freecadcmd.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import freecad_runtime  # noqa: E402
from layout_check import Box, SheetRegions, check_layout  # noqa: E402

SKILLS = SCRIPTS.parents[1]
TEMPLATE = SKILLS / "cad-record" / "assets" / "project-template" / "hw"
CAD_MODEL = SKILLS / "cad-model" / "scripts" / "cad_model.py"
DRAWING = SCRIPTS / "drawing.py"
FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file()
UV = shutil.which("uv")
ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "PAGER": "cat"}

REGIONS = SheetRegions(frame=Box(10, 10, 190, 140), title_block=Box(100, 110, 190, 140), symbol_cell=Box(170, 110, 190, 120))
SYMBOL = '<g id="projection-symbol"><circle cx="180" cy="115" r="3"/></g>'
VIEW = '<g id="view-front"><path d="M 40 40 L 80 40 L 80 70 L 40 70 Z"/></g>'


def sheet(*annotations: str) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150">{SYMBOL}{VIEW}'
            f'<g id="cad-annotations">{"".join(annotations)}</g></svg>')


class AnnotationClasses(unittest.TestCase):
    """layout_check: overlay classes may cross views; dimension lines, frames and text may not."""

    def test_extension_and_leader_lines_may_cross_a_view(self) -> None:
        dimension = ('<g id="dim-a" class="dimension"><line x1="40" y1="30" x2="80" y2="30"/>'
                     '<text x="60" y="29" font-size="2.5" text-anchor="middle">40</text>'
                     '<g class="extension"><line x1="40" y1="60" x2="40" y2="28"/></g></g>')
        leader = ('<g id="callout-b" class="leader"><text x="20" y="50" font-size="2.5" text-anchor="end">⌀5 H7</text>'
                  '<g class="leader-line"><line x1="21" y1="49" x2="60" y2="55"/></g></g>')
        self.assertEqual(check_layout(sheet(dimension, leader), REGIONS, []), [])

    def test_dimension_line_and_frame_over_a_view_fail(self) -> None:
        crossing = '<g id="dim-c" class="dimension"><line x1="30" y1="50" x2="90" y2="50"/></g>'
        frame = '<g id="callout-d" class="leader"><g class="fcf"><rect x="50" y="45" width="10" height="5"/></g></g>'
        problems = check_layout(sheet(crossing, frame), REGIONS, [])
        self.assertEqual(sum("crosses view-front geometry" in p for p in problems), 2, problems)

    def test_text_over_another_annotations_dimension_line_fails(self) -> None:
        dimension = '<g id="dim-e" class="dimension"><line x1="20" y1="20" x2="35" y2="20"/></g>'
        text = '<g id="callout-f" class="leader"><text x="22" y="21" font-size="2.5">R3</text></g>'
        problems = check_layout(sheet(dimension, text), REGIONS, [])
        self.assertIn("annotation text 'R3' overlaps the dimension line or frame of dim-e", problems)


def run(*args: str, timeout: float = 3600) -> subprocess.CompletedProcess[str]:
    return subprocess.run([*args], capture_output=True, text=True, env=ENV, timeout=timeout, check=False)


@unittest.skipUnless(FREECAD_PRESENT and UV, "the gate tests need uv and FreeCAD's freecadcmd")
class PinDrawingGate(unittest.TestCase):
    """LMP-0005 and the catalogue parts: measured values, fits from cad-fits, vendor limits and failing removals."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory(prefix="cad-part-drawing-")
        cls.hw = Path(cls.tmp.name) / "hw"
        shutil.copytree(TEMPLATE, cls.hw)
        build = run(UV, "run", "--script", str(CAD_MODEL), "run", str(cls.hw), "--label", "v1", "--kernel", "auto")
        if build.returncode != 0:
            raise AssertionError(f"lamp template build failed: {build.stdout[-2000:]} {build.stderr[-2000:]}")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def draw(self, label: str, out: str, pn: str = "LMP-0005") -> tuple[int, dict]:
        proc = run(UV, "run", "--script", str(DRAWING), str(self.hw), "--version", label, "--part", pn,
                   "--output-dir", str(Path(self.tmp.name) / out), timeout=900)
        return proc.returncode, json.loads(proc.stdout)["parts"][0]

    def test_pin_passes_with_measured_values_and_fit_limits(self) -> None:
        code, result = self.draw("v1", "pass")
        self.assertEqual((code, result["status"]), (0, "pass"), result.get("findings"))
        package = Path(result["output_dir"])
        coverage = json.loads((package / "coverage.json").read_text(encoding="utf-8"))
        values = {row["characteristic"]: row.get("value_mm") for row in coverage["rows"]}
        self.assertAlmostEqual(abs(values["tip_face.location"]), 30.0, places=6)
        self.assertAlmostEqual(abs(values["press_step.location"]), 20.3, places=6)
        self.assertAlmostEqual(values["press_band.diameter"], 5.016, places=6)  # the model's p6 mid-limit
        self.assertTrue(all(row["status"] == "pass" and row["annotation"] for row in coverage["rows"]), coverage["rows"])
        svg = (package / "sheet-1.svg").read_text(encoding="utf-8")
        texts = re.findall(r"<text[^>]*>([^<]*)</text>", svg)
        self.assertIn("⌀5 p6 (+0.020/+0.012)", texts)     # nominal, class and cad-fits limits
        self.assertFalse(any("5.016" in text for text in texts), texts)  # never the modelled midpoint
        package_json = json.loads((package / "package.json").read_text(encoding="utf-8"))
        self.assertFalse(package_json["release"]["ready"])  # X1 is a prototype revision

    def test_removed_dimension_intent_fails_the_gate(self) -> None:
        part = self.hw / "parts" / "LMP-0005" / "part.yaml"
        original = part.read_text(encoding="utf-8")
        try:
            part.write_text(original.replace("    press_step: {size: general}\n", "").replace(
                "    - {id: head_chamfer_size, operation: chamfer, features: [head_chamfer], "
                "tolerance: {deviation_mm: [-0.1, 0.1]}}\n", ""), encoding="utf-8")
            code, result = self.draw("v1", "fail")
        finally:
            part.write_text(original, encoding="utf-8")
        codes = [f["code"] for f in result["findings"]]
        self.assertEqual((code, result["status"]), (1, "fail"))
        self.assertIn("dimension_coverage_incomplete", codes)   # press_step and the band/journal ends it located
        self.assertIn("tolerance_missing", codes)               # a 0.4 chamfer is below ISO 2768-1's range
        self.assertFalse((Path(result["output_dir"]) / "package.json").exists())

    def test_changing_a_model_parameter_changes_the_dimension_without_yaml(self) -> None:
        model = self.hw / "parts" / "LMP-0005" / "model.py"
        original = model.read_text(encoding="utf-8")
        model.write_text(original.replace('"length": 30.0,', '"length": 31.0,'), encoding="utf-8")
        try:
            build = run(UV, "run", "--script", str(CAD_MODEL), "run", str(self.hw), "--label", "v2", "--kernel", "auto")
            self.assertEqual(build.returncode, 0, build.stdout[-2000:])
            code, result = self.draw("v2", "longer")
        finally:
            model.write_text(original, encoding="utf-8")
        self.assertEqual(code, 0, result.get("findings"))
        coverage = json.loads((Path(result["output_dir"]) / "coverage.json").read_text(encoding="utf-8"))
        tip = next(row for row in coverage["rows"] if row["characteristic"] == "tip_face.location")
        self.assertAlmostEqual(abs(tip["value_mm"]), 31.0, places=6)

    def test_vendor_sheet_controls_only_the_specification_limits(self) -> None:
        code, result = self.draw("v1", "vendor", "LMP-0009")
        self.assertEqual((code, result["status"], result["type"]), (0, "pass", "vendor_specification"),
                         result.get("findings"))
        package = Path(result["output_dir"])
        rows = {row["characteristic"]: row for row in json.loads((package / "coverage.json").read_text())["rows"]}
        self.assertEqual(set(rows), {"bore_diameter", "head_diameter", "body_length", "overall_length",
                                     "head_thickness", "knurl_diameter"})   # no general-tolerance envelope sizes
        self.assertEqual(rows["bore_diameter"]["tolerance"]["kind"], "vendor")
        self.assertTrue(rows["head_thickness"]["reference"] and rows["head_thickness"]["tolerance"] is None)
        texts = re.findall(r"<text[^>]*>([^<]*)</text>", (package / "sheet-1.svg").read_text(encoding="utf-8"))
        self.assertIn("⌀5.1 ±0.05", texts)
        self.assertIn("(⌀7.97)", texts)
        self.assertFalse(any("2768" in text for text in texts), texts)   # a bought item takes no general tolerance
        package_json = json.loads((package / "package.json").read_text(encoding="utf-8"))
        sourcing = package_json["provenance"]["sourcing_inputs"]
        self.assertEqual([s["url"].startswith("https://") for s in sourcing], [True])  # the PDF stays outside hw/

    def test_open_procurement_fields_block_release_and_undeclared_ones_fail(self) -> None:
        code, result = self.draw("v1", "insert", "LMP-0010")
        self.assertEqual((code, result["status"]), (0, "pass"), result.get("findings"))
        blockers = [b["message"] for b in result["release"]["blockers"]]
        self.assertTrue(any(m.startswith("manufacturer_part_number is open") for m in blockers), blockers)
        code, result = self.draw("v1", "ring", "LMP-0011")
        self.assertEqual((code, result["status"]), (0, "not_required"))   # a standard part needs no sheet
        part = self.hw / "parts" / "LMP-0011" / "part.yaml"
        original = part.read_text(encoding="utf-8")
        try:
            part.write_text(re.sub(r"  open:\n    manufacturer_part_number: .*\n", "", original), encoding="utf-8")
            code, result = self.draw("v1", "ring-undeclared", "LMP-0011")
        finally:
            part.write_text(original, encoding="utf-8")
        self.assertEqual((code, result["status"]), (1, "fail"))
        self.assertEqual([f["code"] for f in result["findings"]], ["procurement_incomplete"])


if __name__ == "__main__":
    unittest.main()
