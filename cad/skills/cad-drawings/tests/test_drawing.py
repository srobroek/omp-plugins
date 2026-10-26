#!/usr/bin/env python3
"""Focused projection, rendered output, marker, and XML-security tests."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/drawing.py"
FREECADCMD = Path("/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd")
AUTHORITATIVE_STEP = Path("/tmp/cad-authoritative-source/project/hw/versions/v1/parts/LMP-0003.step")
AUTHORITATIVE_METRICS = Path("/tmp/cad-authoritative-source/project/hw/versions/v1/metrics.json")


class DrawingContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-drawing-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.part = self.root / "part.yaml"
        self.product = self.root / "product.yaml"
        self.part.write_text("PN: TEST-001\nrev: A\ntitle: Test Part\nmaterial: PLA\n", encoding="utf-8")
        self.product.write_text("regime: iso\ngeneral_tolerance: ISO 2768-m\n", encoding="utf-8")
        self.metrics = self.root / "metrics.json"
        self.metrics.write_text(json.dumps({"parts": {"TEST-001": {"holes": []}}}), encoding="utf-8")

    def command(self, step: Path, output: Path, part: Path | None = None, product: Path | None = None,
                metrics: Path | None = None):
        metrics = metrics or self.metrics
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(step), "--part", str(part or self.part), "--product", str(product or self.product),
             "--metrics", str(metrics), "--output-dir", str(output), "--timeout", "60"],
            capture_output=True, text=True, timeout=90,
        )

    def test_missing_freecad_is_structured_exit_two(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "unused.step", "--part", str(self.part), "--product", str(self.product), "--metrics", str(self.metrics),
             "--output-dir", str(self.root / "out")], env={**__import__("os").environ, "FREECADCMD": str(self.root / "missing-freecadcmd")},
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "freecad_unavailable")

    def test_missing_step_fails_structured_without_stale_exports(self) -> None:
        out = self.root / "out"
        out.mkdir()
        (out / "drawing.pdf").write_bytes(b"stale pdf")
        (out / "drawing.svg").write_text("<svg/>", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.root / "missing.step"), "--part", str(self.part),
             "--product", str(self.product), "--metrics", str(self.metrics), "--output-dir", str(out)], capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "invalid_input")

    def test_metrics_bore_data_overrides_step_cylinder_guess(self) -> None:
        sys.path.insert(0, str(SCRIPT.parent))
        try:
            import drawing
            args = type("Args", (), {
                "step": self.root / "part.step", "part": self.part, "product": self.product,
                "metrics": self.metrics, "scale": 1.0,
            })()
            args.step.write_bytes(b"step stub")
            self.metrics.write_text(json.dumps({"parts": {"TEST-001": {"holes": [
                {"id":"H1", "diameter_mm":5.009, "axis":[0,-1,0], "position":[1,2,3], "depth_mm":9, "through":True}
            ]}}}), encoding="utf-8")
            part, product, step, holes = drawing.read_inputs(args)
            self.assertEqual(holes[0]["diameter_mm"], 5.009)
            projection = {"projections": {key:"<path d=\"M 0 0 L 10 10\"/>" for key in ("front","top","right")}}
            template = drawing.TEMPLATES / "ISO/A4_Landscape_ISO5457_minimal.svg"
            original = template.read_text(encoding="utf-8")
            temporary_template = self.root / "template.svg"
            temporary_template.write_text(original, encoding="utf-8")
            svg, _ = drawing.make_sheet({**projection, "holes":holes}, part, product, 1.0, temporary_template)
            self.assertIn('id="hole-diameter-H1"', svg)
            self.assertIn("⌀ 5.01", svg)
            self.assertNotIn("⌀ 5.20", svg)
        finally:
            sys.path.remove(str(SCRIPT.parent))
    @unittest.skipUnless(FREECADCMD.is_file(), "FreeCAD 1.1.4 freecadcmd is not installed")
    def test_lamp_upper_link_renders_views_hole_and_title_block(self) -> None:
        step = AUTHORITATIVE_STEP
        self.assertTrue(step.is_file(), "the authoritative cad-model v1 STEP must be present")
        self.assertTrue(AUTHORITATIVE_METRICS.is_file(), "the authoritative cad-model v1 metrics must be present")
        part = self.root / "part.yaml"
        part.write_text("PN: LMP-0003\nrev: X1\ntitle: Upper link\nmaterial: Aluminum 6061-T6\n", encoding="utf-8")
        result = self.command(step, self.root / "output", part=part, metrics=AUTHORITATIVE_METRICS)
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, report)
        self.assertEqual(report["status"], "pass")
        self.assertTrue(report["templates_found"]["iso"])
        self.assertTrue(report["templates_found"]["asme"])
        self.assertEqual(report["projection_method"], "first-angle")
        self.assertGreaterEqual(report["visible_paths"], 12)
        self.assertGreaterEqual(report["face_count"], 10)
        self.assertEqual(report["hole_diameters_mm"], [5.009, 5.009])
        for key in ("svg", "pdf", "rendered_svg_png", "rendered_pdf_png"):
            path = Path(report[key])
            self.assertTrue(path.is_file())
            self.assertGreater(path.stat().st_size, 0)
        svg = Path(report["svg"]).read_text(encoding="utf-8")
        for required in ("LMP-0003", "Upper link", "Aluminum 6061-T6", "ISO 2768-m", "⌀ 5.01"):
            self.assertIn(required,svg)
        self.assertIn('freecad:editable="drawing_number"',svg)
        self.assertIn('<tspan>LMP-0003</tspan>',svg)
        self.assertIn('<tspan>X1</tspan>',svg)
        self.assertIn('id="view-front"', svg)
        self.assertIn('id="view-top"', svg)
        self.assertEqual(svg.count('id="hole-diameter-H'), 2)
        self.assertIn('id="hole-diameter-H1"',svg)
        self.assertIn('id="hole-diameter-H2"',svg)
        self.assertIn('id="overall-front-width"', svg)
        self.assertIn('id="overall-front-height"', svg)
        self.assertNotIn("Company Name", svg)
        self.assertNotIn(">A</tspan>", svg)
        front = svg.split('id="view-front" transform="', 1)[1].split('"', 1)[0]
        top = svg.split('id="view-top" transform="', 1)[1].split('"', 1)[0]
        right = svg.split('id="view-right" transform="', 1)[1].split('"', 1)[0]
        import re
        fc = tuple(map(float, re.search(r"translate\(([-.0-9]+) ([-.0-9]+)\)", front).groups()))
        tc = tuple(map(float, re.search(r"translate\(([-.0-9]+) ([-.0-9]+)\)", top).groups()))
        rc = tuple(map(float, re.search(r"translate\(([-.0-9]+) ([-.0-9]+)\)", right).groups()))
        self.assertGreater(tc[1], fc[1])
        self.assertLess(rc[0], fc[0])
    def test_asme_uses_third_angle_view_positions_and_symbol(self) -> None:
        step = AUTHORITATIVE_STEP
        self.assertTrue(step.is_file(), "the authoritative cad-model v1 STEP must be present")
        self.assertTrue(AUTHORITATIVE_METRICS.is_file(), "the authoritative cad-model v1 metrics must be present")
        part = self.root / "part.yaml"
        part.write_text("PN: LMP-0003\nrev: X1\ntitle: Upper link\nmaterial: Aluminum 6061-T6\n", encoding="utf-8")
        product = self.root / "product.yaml"
        product.write_text("regime: asme\ngeneral_tolerance: ASME Y14.5\n", encoding="utf-8")
        result = self.command(step, self.root / "asme", part=part, product=product, metrics=AUTHORITATIVE_METRICS)
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, report)
        self.assertEqual(report["hole_diameters_mm"], [5.009, 5.009])
        svg = Path(report["svg"]).read_text(encoding="utf-8")
        self.assertIn('id="third_angle_projection_symbol"', svg)
        self.assertIn("Title: Upper link", svg)
        self.assertIn("PN / Rev: LMP-0003 / X1", svg)
        self.assertIn("Material: Aluminum 6061-T6", svg)
        self.assertIn("Tolerance: ASME Y14.5", svg)
        self.assertIn("Scale: 1 : 1", svg)
        self.assertNotIn("Company Name", svg)
        self.assertNotIn("Drawing Title 1", svg)
        self.assertNotIn("Drawn By", svg)
        self.assertNotIn("BlockJ Size", svg)
        self.assertNotIn(">A</tspan>", svg)
        self.assertIn("⌀ 5.01", svg)
        front=svg.split('id="view-front" transform="',1)[1].split('"',1)[0]
        top=svg.split('id="view-top" transform="',1)[1].split('"',1)[0]
        right=svg.split('id="view-right" transform="',1)[1].split('"',1)[0]
        import re
        fc=tuple(map(float,re.search(r"translate\(([-.0-9]+) ([-.0-9]+)\)",front).groups()))
        tc=tuple(map(float,re.search(r"translate\(([-.0-9]+) ([-.0-9]+)\)",top).groups()))
        rc=tuple(map(float,re.search(r"translate\(([-.0-9]+) ([-.0-9]+)\)",right).groups()))
        self.assertLess(tc[1],fc[1])
        self.assertGreater(rc[0],fc[0])

    def test_safe_svg_validation_blocks_entity_expansion(self) -> None:
        sys.path.insert(0, str(SCRIPT.parent))
        try:
            import drawing
            svg = self.root / "hostile.svg"
            svg.write_text('<!DOCTYPE x [<!ENTITY boom "abc">]><svg xmlns="http://www.w3.org/2000/svg"><text>&boom;</text></svg>', encoding="utf-8")
            ok, message, count = drawing.verify_svg_content(svg, self.root / "missing.png", {"PN":"x","rev":"A","title":"t","material":"m"})
            self.assertFalse(ok)
            self.assertEqual(count, 0)
            self.assertIn("unsafe SVG", message)
        finally:
            sys.path.remove(str(SCRIPT.parent))


if __name__ == "__main__":
    unittest.main()
