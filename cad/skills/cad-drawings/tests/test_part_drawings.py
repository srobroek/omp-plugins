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
from decimal import Decimal
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import completeness  # noqa: E402
import freecad_runtime  # noqa: E402
from drawing_intent import Characteristic, Measured, Tolerance  # noqa: E402
from feature_geometry import Binding  # noqa: E402
from layout_check import Box, SheetRegions, check_layout  # noqa: E402
from sheet import Linear, Presentation, TextureSymbol, edge_lines, edge_note, edge_size  # noqa: E402

SKILLS = SCRIPTS.parents[1]
TEMPLATE = SKILLS.parent / "examples" / "lamp-arm" / "hw"
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


class RepeatedDimensions(unittest.TestCase):
    """The gate fails a sheet that dimensions one coordinate twice; features sharing that dimension pass."""

    def test_two_dimension_lines_for_one_coordinate_fail(self) -> None:
        tolerance = Tolerance("general", Decimal("-0.2"), Decimal("0.2"))
        chars = [Characteristic(id=f"{name}.axis_location.y", feature=name, operation="axis_location", value=-3.5,
                                faces=(index,), quantity=1, axis="y", tolerance=tolerance, presentation="auto",
                                details={}) for index, name in enumerate(("neck", "cable_run"))]

        def line(number: int, ids: list[str]) -> Linear:
            return Linear(id=f"dim-{number}", view="plan", origin=(0.0, 0.0), target=(0.0, 3.5), horizontal=False,
                          text="3.5", boxed=False, reference=False, characteristics=ids)

        repeated = Presentation(linears=[line(0, [chars[0].id]), line(1, [chars[1].id])])
        shared = Presentation(linears=[line(0, [c.id for c in chars])])
        for presentation, expected in ((repeated, 1), (shared, 0)):
            measured = Measured(frame=None)
            measured.characteristics.extend(chars)
            report = completeness.evaluate("TST-0001", {"drawing": {}}, [], Binding({}, {}, ()), measured,
                                           presentation, "0" * 64)
            self.assertEqual(sum(f["code"] == "dimension_conflict" for f in report.findings), expected, report.findings)


class EdgeAndTextureIndications(unittest.TestCase):
    """ISO 13715 edge sizes and their ASME notes, ISO 21920-1 symbols, and the gate's edge and texture rows."""

    def test_edge_sizes_follow_the_iso_13715_signs(self) -> None:
        sizes = [edge_size(v) for v in ([-0.3, 0.0], [0.0, 0.3], [-0.3, -0.1], [-0.05, 0.05], [-0.1, 0.2])]
        self.assertEqual(sizes, ["−0.3", "+0.3", "−0.1/−0.3", "±0.05", "+0.2/−0.1"])

    def test_general_edge_note_per_regime(self) -> None:
        edges = {"external": [-0.3, 0.0], "internal": [0.0, 0.3]}
        self.assertEqual(edge_note(edges, "iso", True),
                         "Edges of undefined shape ISO 13715: external −0.3, internal +0.3; exceptions as indicated.")
        self.assertEqual(edge_note(edges, "asme", False), "UNDEFINED EDGES: REMOVE ALL BURRS, EDGE BREAK 0.3 MAX; "
                                                          "INTERNAL CORNERS R0.3 MAX, NO UNDERCUT.")
        groove = {"external": [-0.02, 0.0], "internal": [0.0, 0.06]}
        self.assertEqual(edge_lines(groove, "iso"), ["external edges −0.02", "internal edges +0.06"])
        self.assertEqual(edge_lines({"external": [-0.3, -0.1], "internal": [0.0, 0.06]}, "asme"),
                         ["BREAK EDGES 0.1-0.3", "CORNERS R0.06 MAX"])

    def test_texture_symbol_shows_the_process_and_the_requirement(self) -> None:
        markups = {process: TextureSymbol("Ra 0.8", process).markup(0.0, 0.0, 2.5)
                   for process in ("any", "removal_required", "removal_prohibited")}
        self.assertEqual(markups["removal_required"].count("<line"), markups["any"].count("<line") + 1)
        self.assertIn("<circle", markups["removal_prohibited"])
        self.assertTrue(all(">Ra 0.8<" in m for m in markups.values()))
        self.assertEqual(TextureSymbol("Ra 0.8", "any").size(2.5)[1], 7.5)   # the long leg: three lettering heights
        plain, others = TextureSymbol("Ra 1.6", "any"), TextureSymbol("Ra 1.6", "any", others=True)
        self.assertGreater(others.size(2.5)[0], plain.size(2.5)[0])
        self.assertEqual(others.markup(0.0, 0.0, 2.5).count("<path"), 2)     # the parentheses round the basic symbol

    def test_a_texture_symbol_over_a_view_fails_layout_check(self) -> None:
        mark = (f'<g id="callout-t" class="leader"><g class="texture">'
                f'{TextureSymbol("Ra 1.6", "any").markup(45.0, 45.0, 2.5)}</g></g>')
        problems = check_layout(sheet(mark), REGIONS, [])
        self.assertTrue(any("crosses view-front geometry" in p for p in problems), problems)

    def test_detail_drawing_needs_edges_and_texture_and_an_open_texture_blocks_release(self) -> None:
        part = {"rev": "X1", "make_buy": "make", "drawing": {"type": "detail",
                                                             "notes": [{"kind": "finish", "text": "As machined."}]}}

        def missing() -> list[str]:
            report = completeness.evaluate("TST-0001", part, [], Binding({}, {}, ()), Measured(frame=None), None, "0" * 64)
            return [f["message"] for f in report.findings if f["code"] == "drawing_intent_missing"]

        self.assertEqual(len(missing()), 2, missing())
        part["drawing"].update(edges={"external": [-0.3, 0.0], "internal": [0.0, 0.3]},
                               surface_texture={"open": "no basis for a value yet"})
        self.assertEqual(missing(), [])
        self.assertIn("surface_texture_open", [b["code"] for b in completeness.release_blockers(part)])


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

    def draw(self, label: str, out: str, pn: str = "LMP-0005", *, output: bool = True) -> tuple[int, dict]:
        command = [UV, "run", "--script", str(DRAWING), str(self.hw), "--version", label, "--part", pn]
        if output:
            command += ["--output-dir", str(Path(self.tmp.name) / ".cad-work" / out)]
        proc = run(*command, timeout=900)
        try:
            result = json.loads(proc.stdout)["parts"][0]
        except json.JSONDecodeError as exc:
            raise AssertionError(f"drawing CLI returned no JSON (exit {proc.returncode}): {proc.stderr[-3000:]}") from exc
        return proc.returncode, result

    def test_default_output_publishes_and_reuses_the_bundle(self) -> None:
        code, result = self.draw("v1", "unused", output=False)
        self.assertEqual((code, result["status"]), (0, "pass"), result.get("findings"))
        package = Path(result["output_dir"])
        self.assertEqual(package, (self.hw / "drawings" / "v1" / "LMP-0005").resolve())
        manifest = (package / "manifest.json").read_bytes()
        self.assertEqual(json.loads(manifest)["status"], "pass")  # release.py accepts only a passing bundle
        package_json = json.loads((package / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package_json["output_dir"], "hw/drawings/v1/LMP-0005")
        self.assertTrue(all((self.hw.parent / path).is_file() for sheet in package_json["sheets"]
                            for path in sheet["files"].values()))
        code, reused = self.draw("v1", "unused", output=False)
        self.assertEqual((code, reused.get("cache"), reused["output_dir"]), (0, "hit", str(package)))
        self.assertEqual((package / "manifest.json").read_bytes(), manifest)

    def test_explicit_output_outside_cad_work_is_refused(self) -> None:
        outside = Path(self.tmp.name) / "outside"
        proc = run(UV, "run", "--script", str(DRAWING), str(self.hw), "--version", "v1", "--part", "LMP-0005",
                   "--output-dir", str(outside))
        self.assertEqual(proc.returncode, 2)
        self.assertFalse(outside.exists())
        self.assertIn("--output-dir must be under", proc.stdout)

    def test_existing_explicit_output_is_never_overwritten(self) -> None:
        output = Path(self.tmp.name) / ".cad-work" / "preserved"
        output.mkdir(parents=True)
        marker = output / "keep.txt"
        marker.write_text("untouched\n", encoding="utf-8")
        proc = run(UV, "run", "--script", str(DRAWING), str(self.hw), "--version", "v1", "--part", "LMP-0005",
                   "--output-dir", str(output))
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(marker.read_text(encoding="utf-8"), "untouched\n")

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

    def test_one_part_failure_does_not_prevent_other_requested_parts(self) -> None:
        part = self.hw / "parts" / "LMP-0005" / "part.yaml"
        original = part.read_text(encoding="utf-8")
        try:
            part.write_text(original.replace("    press_step: {size: general}\n", "").replace(
                "    - {id: head_chamfer_size, operation: chamfer, features: [head_chamfer], "
                "tolerance: {deviation_mm: [-0.1, 0.1]}}\n", ""), encoding="utf-8")
            self.assertNotEqual(part.read_text(encoding="utf-8"), original)
            proc = run(UV, "run", "--script", str(DRAWING), str(self.hw), "--version", "v1",
                       "--part", "LMP-0005", "--part", "LMP-0002", "--output-dir",
                       str(Path(self.tmp.name) / ".cad-work" / "isolate-failure"), "--timeout", "900", "--jobs", "2")
        finally:
            part.write_text(original, encoding="utf-8")
        self.assertEqual(proc.returncode, 1)
        results = json.loads(proc.stdout)["parts"]
        self.assertEqual([result["pn"] for result in results], ["LMP-0005", "LMP-0002"])
        self.assertEqual([result["status"] for result in results], ["fail", "pass"])
        retained = Path(self.tmp.name) / ".cad-work" / "rejected-drawings"
        self.assertTrue(any(path.is_dir() for path in retained.iterdir()))
        passed = Path(results[1]["output_dir"])
        self.assertTrue((passed / "sheet-1.pdf").is_file())

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

    def test_open_procurement_fields_block_release_and_a_standard_designation_orders(self) -> None:
        code, result = self.draw("v1", "insert", "LMP-0010")
        self.assertEqual((code, result["status"]), (0, "pass"), result.get("findings"))
        blockers = [b["message"] for b in result["release"]["blockers"]]
        self.assertTrue(any(m.startswith("manufacturer_part_number is open") for m in blockers), blockers)
        code, result = self.draw("v1", "ring", "LMP-0011")
        self.assertEqual((code, result["status"]), (0, "not_required"))   # a standard part needs no sheet
        blockers = [b["message"] for b in result["release"]["blockers"]]
        self.assertFalse(any(" is open: " in m for m in blockers), blockers)   # DIN 471 - 5x0.6 identifies it
        part = self.hw / "parts" / "LMP-0011" / "part.yaml"
        original = part.read_text(encoding="utf-8")
        try:
            part.write_text(original.replace("  standard: DIN 471\n", ""), encoding="utf-8")
            code, result = self.draw("v1", "ring-unstandard", "LMP-0011")
        finally:
            part.write_text(original, encoding="utf-8")
        self.assertEqual(result["status"], "fail")
        self.assertIn("procurement_incomplete", [f["code"] for f in result["findings"]])

if __name__ == "__main__":
    unittest.main()
