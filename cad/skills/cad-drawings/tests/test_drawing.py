#!/usr/bin/env python3
"""Focused projection, layout, export, marker, FreeCAD discovery and XML-security tests."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
import zlib
from pathlib import Path

from defusedxml import ElementTree as SafeET

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/drawing.py"
sys.path.insert(0, str(SCRIPT.parent))
import drawing  # noqa: E402
import freecad_runtime  # noqa: E402
import layout_check  # noqa: E402
import sheet  # noqa: E402
import sheet_export  # noqa: E402
from layout_check import Box, SheetRegions, check_layout  # noqa: E402

FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file()
AUTHORITATIVE_STEP = Path("/tmp/cad-authoritative-source/project/hw/versions/v1/parts/LMP-0003.step")
AUTHORITATIVE_METRICS = Path("/tmp/cad-authoritative-source/project/hw/versions/v1/metrics.json")
TEMPLATES_PRESENT = all(spec.template.is_file() for spec in sheet.SPECS.values())
# Qt writes the PDF page size in whole points: ISO A4 landscape and ANSI A landscape.
PAGE_POINTS = {"iso": (842.0, 595.0), "asme": (792.0, 612.0)}

REGIONS = SheetRegions(frame=Box(10, 10, 190, 140), title_block=Box(100, 110, 190, 140), symbol_cell=Box(170, 110, 190, 120))
SYMBOL = '<g id="projection-symbol"><circle cx="180" cy="115" r="3"/></g>'


def svg_document(*parts: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150">{"".join(parts)}</svg>'


def view(name: str, x0: float, y0: float, x1: float, y1: float) -> str:
    return f'<g id="view-{name}"><path d="M {x0} {y0} L {x1} {y0} L {x1} {y1} L {x0} {y1} Z"/></g>'


def annotations(*parts: str) -> str:
    return f'<g id="cad-annotations">{"".join(parts)}</g>'


def label(content: str, x: float, y: float, size: float = 3.5, **extra: str) -> str:
    attributes = "".join(f' {key.replace("_", "-")}="{value}"' for key, value in extra.items())
    return f'<text x="{x}" y="{y}" font-size="{size}"{attributes}>{content}</text>'


class LayoutCheck(unittest.TestCase):
    """check_layout over hand-built SVG: one passing sheet, then one violation per rule."""

    def good_sheet(self, *extra: str, symbol: str = SYMBOL) -> str:
        return svg_document(view("front", 30, 40, 90, 60), view("top", 30, 75, 90, 85), symbol,
                            annotations('<g class="dimension"><line x1="30" y1="34" x2="90" y2="34"/>'
                                        + label("60.00", 60, 33, text_anchor="middle") + "</g>"), *extra)

    def test_clean_layout_passes(self) -> None:
        self.assertEqual(check_layout(self.good_sheet(), REGIONS, ["DN"]), [])

    def test_overlapping_views_fail(self) -> None:
        problems = check_layout(self.good_sheet(view("right", 85, 45, 100, 55)), REGIONS, [])
        self.assertTrue(any("view-front and view-right" in p for p in problems), problems)

    def test_views_closer_than_minimum_gap_fail(self) -> None:
        problems = check_layout(self.good_sheet(view("right", 95, 40, 105, 60)), REGIONS, [])
        self.assertTrue(any("5.00 mm apart" in p for p in problems), problems)

    def test_view_outside_frame_or_on_title_block_fails(self) -> None:
        problems = check_layout(self.good_sheet(view("right", 150, 100, 170, 125)), REGIONS, [])
        self.assertIn("view-right overlaps the title block", problems)
        problems = check_layout(self.good_sheet(view("right", 2, 40, 20, 60)), REGIONS, [])
        self.assertIn("view-right lies outside the drawing frame", problems)

    def test_annotation_text_over_geometry_fails(self) -> None:
        problems = check_layout(self.good_sheet(annotations(label("21.00", 85, 50))), REGIONS, [])
        self.assertTrue(any("'21.00' overlaps view-front geometry" in p for p in problems), problems)

    def test_rotated_annotation_text_uses_its_rotated_extent(self) -> None:
        clear = annotations(label("21.00", 97, 50, text_anchor="middle", transform="rotate(-90 97 50)"))
        self.assertEqual(check_layout(self.good_sheet(clear), REGIONS, []), [])
        crossing = annotations(label("21.00", 92, 50, text_anchor="middle", transform="rotate(-90 92 50)"))
        self.assertTrue(any("overlaps view-front" in p for p in check_layout(self.good_sheet(crossing), REGIONS, [])))

    def test_annotation_text_overlapping_text_or_frame_fails(self) -> None:
        problems = check_layout(self.good_sheet(annotations(label("⌀5.01", 55, 33))), REGIONS, [])
        self.assertTrue(any("'⌀5.01'" in p and "'60.00'" in p and "overlaps" in p for p in problems), problems)
        problems = check_layout(self.good_sheet(annotations(label("⌀5.01", 8, 30))), REGIONS, [])
        self.assertTrue(any("crosses the drawing frame" in p for p in problems), problems)

    def test_dimension_line_through_geometry_fails(self) -> None:
        crossing = annotations('<g class="dimension"><line x1="95" y1="40" x2="85" y2="60"/></g>')
        problems = check_layout(self.good_sheet(crossing), REGIONS, [])
        self.assertTrue(any("dimension line" in p and "view-front" in p for p in problems), problems)
        leader = annotations('<g class="leader"><line x1="95" y1="30" x2="60" y2="50"/></g>')
        self.assertEqual(check_layout(self.good_sheet(leader), REGIONS, []), [])

    def test_projection_symbol_outside_its_cell_or_duplicated_fails(self) -> None:
        outside = '<g id="projection-symbol"><circle cx="195" cy="115" r="3"/></g>'
        self.assertIn("projection symbol lies outside its title-block cell",
                      check_layout(self.good_sheet(symbol=outside), REGIONS, []))
        problems = check_layout(self.good_sheet(SYMBOL), REGIONS, [])
        self.assertIn("expected exactly one projection symbol, found 2", problems)

    def test_template_placeholder_fails(self) -> None:
        problems = check_layout(self.good_sheet(label("A. Nemesis", 120, 130)), REGIONS, ["A. Nemesis"])
        self.assertIn("template placeholder remains: 'A. Nemesis'", problems)


def synthetic_projection(matched: bool = True) -> dict:
    """A TechDraw job result shaped like techdraw_job.py output, for composition without FreeCAD."""
    def box_view(center, half_w, half_h, extra=""):
        svg = (f'<g stroke="#000000" stroke-width="0.7"><path d="M {-half_w} {-half_h} L {half_w} {-half_h} '
               f'L {half_w} {half_h} L {-half_w} {half_h} Z"/>{extra}</g>')
        return {"center": center, "box": [-half_w, -half_h, half_w, half_h], "svg": svg}
    bores = '<circle cx="-50" cy="0" r="2.5045"/><circle cx="50" cy="0" r="2.5045"/>'
    bore = {"id": "H1", "diameter_mm": 5.009, "view": "front", "matched": matched, "circle": [-50, 0, 2.5045]}
    return {"scale": 1.0, "face_count": 6, "extent_mm": {"width": 120.0, "height": 20.0},
            "views": {"front": box_view([150, 70], 60, 10, bores), "top": box_view([150, 102], 60, 8),
                      "right": box_view([60, 70], 8, 10)},
            "bores": [bore, {**bore, "id": "H2", "circle": [50, 0, 2.5045]},
                      {"id": "H3", "diameter_mm": 3.0, "view": "top", "matched": True, "circle": [0, 0, 1.5]}]}


@unittest.skipUnless(TEMPLATES_PRESENT, "FreeCAD 1.1.4 TechDraw templates are not installed")
class SheetComposition(unittest.TestCase):
    PART = {"PN": "TEST-001", "rev": "B", "title": "Test Part", "material": "PLA"}

    def compose(self, regime: str, **projection_options) -> sheet.Sheet:
        product = {"regime": regime, "general_tolerance": "ISO 2768-m"}
        return sheet.compose(synthetic_projection(**projection_options), self.PART, product, sheet.SPECS[regime])

    def test_metrics_bores_get_callouts_and_the_sheet_passes_layout(self) -> None:
        for regime in ("iso", "asme"):
            with self.subTest(regime=regime):
                drawn = self.compose(regime)
                self.assertEqual(drawn.svg.count('id="hole-diameter-H'), 2)
                self.assertEqual(drawn.svg.count("⌀5.01"), 2)
                self.assertNotIn("⌀3.00", drawn.svg)
                self.assertIn("bore H3", drawn.warnings[0])
                self.assertEqual(check_layout(drawn.svg, sheet.SPECS[regime].regions, drawn.placeholders), [])

    def test_unmatched_metrics_bore_is_a_metrics_mismatch(self) -> None:
        with self.assertRaisesRegex(ValueError, "metrics_mismatch: bore H1"):
            self.compose("iso", matched=False)

    def test_every_template_field_is_filled_from_the_record_or_blank(self) -> None:
        iso = self.compose("iso")
        for placeholder in ("A. Nemesis", "B. Hecate", "YYYY-MM-DD", "X / Y", "DN", "AAA", "ISO 5457 template"):
            self.assertIn(placeholder, iso.placeholders)
            self.assertNotIn(f">{placeholder}<", iso.svg)
        for value in ("TEST-001", "Test Part", "PLA", "ISO 2768-m", "1 / 1", "1 : 1"):
            self.assertIn(f">{value}<", iso.svg)
        asme = self.compose("asme")
        for placeholder in ("Company Name", "Drawing Title 1", "Drawn By", "Approved 1", "Sheet n of m"):
            self.assertNotIn(f">{placeholder}<", asme.svg)
        for value in ("TEST-001", "Test Part", "PLA", "ISO 2768-m", "Scale 1:1", "Sheet 1 of 1"):
            self.assertIn(f">{value}<", asme.svg)

    def test_asme_labels_appear_once_each(self) -> None:
        texts = re.findall(r">([^<>]+:)<", self.compose("asme").svg)
        self.assertEqual(texts.count("Approved:"), 1)
        self.assertEqual(texts.count("Released:"), 1)
        self.assertEqual(len(texts), len(set(texts)), texts)

    def test_projection_arrangement_and_free_sides(self) -> None:
        iso, asme = self.compose("iso").svg, self.compose("asme").svg
        self.assertIn('id="extras_outlines"', iso.split('id="projection-symbol"', 1)[1])
        self.assertIn('id="polygon5123"', asme.split('id="projection-symbol"', 1)[1])
        width_y = lambda svg: float(re.search(r'id="overall-front-width".*?y1="([-.0-9]+)"', svg, re.S).group(1))
        self.assertLess(width_y(iso), 70)   # first angle: top view below, dimension above the front view
        self.assertGreater(width_y(asme), 70)  # third angle: top view above, dimension below


def view_centers(svg: str) -> dict[str, tuple[float, float]]:
    centers = {}
    for name in ("front", "top", "right"):
        transform = svg.split(f'id="view-{name}" transform="', 1)[1].split('"', 1)[0]
        centers[name] = tuple(map(float, re.search(r"translate\(([-.0-9]+) ([-.0-9]+)\)", transform).groups()))
    return centers


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
                metrics: Path | None = None, timeout: float = 60):
        metrics = metrics or self.metrics
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(step), "--part", str(part or self.part), "--product", str(product or self.product),
             "--metrics", str(metrics), "--output-dir", str(output), "--timeout", str(timeout)],
            capture_output=True, text=True, timeout=timeout+30,
        )

    def test_timed_out_projection_kills_process_group(self) -> None:
        if not hasattr(os,"killpg"):
            self.skipTest("process groups are unavailable")
        fake=self.root/"fake-freecad"
        child_pid=self.root/"child.pid"
        fake.write_text(f'#!/bin/sh\nsleep 30 &\necho $! > "{child_pid}"\nwait\n',encoding="utf-8")
        fake.chmod(0o755)
        # 5 s: on a loaded host the fake took up to 1.6 s to start its child; the child sleeps 30 s.
        result,message=freecad_runtime.run_job(fake,drawing.TECHDRAW_JOB,{"step":str(self.root/"part.step")},self.root,5.0)
        self.assertIsNone(result)
        self.assertIn("exceeded",message)
        self.assertEqual(list(self.root.glob("techdraw_job_*")), [])
        pid=int(child_pid.read_text(encoding="utf-8"))
        deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            try:
                os.kill(pid,0)
            except ProcessLookupError:
                break
            except PermissionError:
                self.fail(f"child process {pid} survived projection timeout")
            time.sleep(0.05)
        else:
            self.fail(f"child process {pid} survived projection timeout")

    def test_failed_job_result_is_reported_and_its_files_removed(self) -> None:
        fake = self.root / "fake-freecad"
        fake.write_text('#!/bin/sh\nprintf \'{"status": "error", "error": "boom"}\' > "${CAD_DRAWING_JOB%.job.json}.result.json"\n',
                        encoding="utf-8")
        fake.chmod(0o755)
        result, message = freecad_runtime.run_job(fake, sheet_export.EXPORT_JOB, {}, self.root, 20.0)
        self.assertIsNone(result)
        self.assertEqual(message, "boom")
        self.assertEqual(list(self.root.glob("export_job_*")), [])

    def test_missing_freecad_is_structured_exit_two(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "unused.step", "--part", str(self.part), "--product", str(self.product), "--metrics", str(self.metrics),
             "--output-dir", str(self.root / "out")], env={**os.environ, "FREECADCMD": str(self.root / "missing-freecadcmd")},
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "freecad_unavailable")

    def test_missing_step_fails_structured_without_stale_exports(self) -> None:
        out = self.root / "out"
        out.mkdir()
        (out / "drawing.pdf").write_bytes(b"stale pdf")
        (out / "drawing.svg").write_text("<svg/>", encoding="utf-8")
        freecadcmd = self.root / "freecadcmd"  # passes the install check; the missing STEP stops the run before it
        freecadcmd.write_text("#!/bin/sh\nexit 3\n", encoding="utf-8")
        freecadcmd.chmod(0o755)
        result = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.root / "missing.step"), "--part", str(self.part),
             "--product", str(self.product), "--metrics", str(self.metrics), "--output-dir", str(out)],
            env={**os.environ, "FREECADCMD": str(freecadcmd)}, capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["error"]["code"], "invalid_input")

    def test_metrics_bore_data_is_validated(self) -> None:
        args = type("Args", (), {"step": self.root / "part.step", "part": self.part, "product": self.product,
                                 "metrics": self.metrics, "scale": 1.0})()
        args.step.write_bytes(b"step stub")
        self.metrics.write_text(json.dumps({"parts": {"TEST-001": {"holes": [
            {"id":"H1", "diameter_mm":5.009, "axis":[0,-1,0], "position":[1,2,3], "depth_mm":9, "through":True}
        ]}}}), encoding="utf-8")
        _, _, _, holes = drawing.read_inputs(args)
        self.assertEqual(holes[0]["diameter_mm"], 5.009)
        self.metrics.write_text(json.dumps({"parts": {"TEST-001": {"holes": [
            {"id":"H1", "diameter_mm":5.009, "axis":[0,0,0], "position":[1,2,3]}
        ]}}}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "axis must be non-zero"):
            drawing.read_inputs(args)

    def real_drawing(self, regime: str) -> tuple[dict, str]:
        self.assertTrue(AUTHORITATIVE_STEP.is_file(), "the authoritative cad-model v1 STEP must be present")
        self.assertTrue(AUTHORITATIVE_METRICS.is_file(), "the authoritative cad-model v1 metrics must be present")
        part = self.root / "part.yaml"
        part.write_text("PN: LMP-0003\nrev: X1\ntitle: Upper link\nmaterial: Aluminum 6061-T6\n", encoding="utf-8")
        product = self.root / "product.yaml"
        product.write_text(f"regime: {regime}\ngeneral_tolerance: ISO 2768-m\n", encoding="utf-8")
        result = self.command(AUTHORITATIVE_STEP, self.root / regime, part=part, product=product, metrics=AUTHORITATIVE_METRICS)
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, report)
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["layout_check"], "pass")
        self.assertEqual(report["hole_diameters_mm"], [5.009, 5.009])
        for key in ("svg", "pdf", "rendered_png"):
            path = Path(report[key])
            self.assertTrue(path.is_file())
            self.assertGreater(path.stat().st_size, 0)
        self.assertGreater(report["export"]["png"]["dark_pixels"], sheet_export.MIN_DARK_PIXELS)
        pdf = sheet_export.read_pdf(Path(report["pdf"]))
        self.assertEqual(pdf.page_sizes_pt, [PAGE_POINTS[regime]])
        self.assertEqual(pdf.fonts, ["osifont"])
        for required in ("LMP-0003", "X1", "Upper link", "Aluminum 6061-T6", "ISO 2768-m", "221.00", "21.00", "⌀5.01"):
            self.assertIn(required, pdf.text)
        svg = Path(report["svg"]).read_text(encoding="utf-8")
        spec = sheet.SPECS[regime]
        self.assertEqual(check_layout(svg, spec.regions, sheet.STOCK_PLACEHOLDERS), [])
        for required in ("LMP-0003", "X1", "Upper link", "Aluminum 6061-T6", "ISO 2768-m", ">221.00<", ">21.00<"):
            self.assertIn(required, svg)
        self.assertEqual(svg.count('id="hole-diameter-H'), 2)
        self.assertEqual(svg.count(">⌀5.01<"), 2)
        self.assertEqual(svg.count('id="projection-symbol"'), 1)
        return report, svg

    @unittest.skipUnless(FREECAD_PRESENT, "FreeCAD 1.1.4 freecadcmd is not installed")
    def test_iso_lamp_upper_link_is_first_angle_with_complete_title_block(self) -> None:
        report, svg = self.real_drawing("iso")
        self.assertTrue(report["templates_found"]["iso"])
        self.assertEqual(report["projection_method"], "first-angle")
        self.assertGreaterEqual(report["visible_paths"], 12)
        self.assertGreaterEqual(report["face_count"], 10)
        self.assertIn("<tspan>LMP-0003</tspan>", svg)
        self.assertIn("<tspan>1 / 1</tspan>", svg)
        centers = view_centers(svg)
        self.assertGreater(centers["top"][1], centers["front"][1])  # top view below the front view
        self.assertLess(centers["right"][0], centers["front"][0])  # right view left of the front view

    @unittest.skipUnless(FREECAD_PRESENT, "FreeCAD 1.1.4 freecadcmd is not installed")
    def test_asme_lamp_upper_link_is_third_angle_with_unique_labels(self) -> None:
        report, svg = self.real_drawing("asme")
        self.assertEqual(report["projection_method"], "third-angle")
        self.assertIn("Scale 1:2", svg)
        self.assertEqual(svg.count(">Approved:<"), 1)
        self.assertIn(">Released:<", svg)
        centers = view_centers(svg)
        self.assertLess(centers["top"][1], centers["front"][1])  # top view above the front view
        self.assertGreater(centers["right"][0], centers["front"][0])  # right view right of the front view

    def test_safe_svg_validation_blocks_entity_expansion(self) -> None:
        svg = self.root / "hostile.svg"
        svg.write_text('<!DOCTYPE x [<!ENTITY boom "abc">]><svg xmlns="http://www.w3.org/2000/svg"><text>&boom;</text></svg>', encoding="utf-8")
        ok, message, count = drawing.verify_svg_content(svg, {"PN":"x","rev":"A","title":"t","material":"m"})
        self.assertFalse(ok)
        self.assertEqual(count, 0)
        self.assertIn("unsafe SVG", message)
        with self.assertRaises(Exception):
            layout_check.check_layout(svg.read_text(encoding="utf-8"), REGIONS, [])


class FreeCADDiscovery(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-freecad-lookup-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def executable(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\n", encoding="utf-8")
        path.chmod(0o755)
        return path

    def test_set_freecadcmd_is_used_as_given(self) -> None:
        on_path = self.executable(self.root / "bin" / "freecadcmd")
        environ = {"FREECADCMD": str(self.root / "missing"), "PATH": str(on_path.parent)}
        self.assertEqual(freecad_runtime.find_freecadcmd(environ), self.root / "missing")

    def test_path_lookup_accepts_both_command_names(self) -> None:
        for name in ("freecadcmd", "FreeCADCmd"):
            with self.subTest(name=name):
                command = self.executable(self.root / name / name)
                found = freecad_runtime.find_freecadcmd({"PATH": str(command.parent)})
                self.assertTrue(found is not None and found.samefile(command), found)

    def test_without_path_command_only_the_macos_app_remains(self) -> None:
        app = freecad_runtime.MACOS_FREECADCMD
        found = freecad_runtime.find_freecadcmd({"PATH": str(self.root)})
        self.assertEqual(found, app if app.is_file() else None)

    def test_templates_follow_a_symlinked_bundle_command(self) -> None:
        command = self.executable(self.root / "squashfs-root" / "usr" / "bin" / "freecadcmd")
        link = self.root / "local" / "bin" / "freecadcmd"
        link.parent.mkdir(parents=True)
        link.symlink_to(command)
        self.assertEqual(freecad_runtime.templates_dir(link),
                         command.resolve().parents[1] / "share" / "Mod" / "TechDraw" / "Templates")


class SheetExportParts(unittest.TestCase):
    """Text splitting and PDF reading without FreeCAD; the lamp drawings exercise the Qt export itself."""

    SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="150mm" viewBox="0 0 200 150">'
           '<g style="font-size:3.5px;font-family:osifont;fill:#000000" transform="translate(10 20)">'
           '<text x="5" y="6" text-anchor="middle"><tspan>  Centred\n   label </tspan></text>'
           '<text x="1" y="2"><tspan x="7" y="8" font-weight="bold" font-family="sans-serif, Arial">Moved</tspan></text>'
           '</g><text x="0" y="0" font-size="2" fill="none">hidden</text>'
           '<text x="3" y="4" transform="rotate(-90 3 4)" font-size="2.5" fill="#111">22.00</text>'
           '<path d="M 0 0 L 1 1"/></svg>')

    def test_text_runs_leave_a_text_free_svg(self) -> None:
        root = SafeET.fromstring(self.SVG)
        runs = sheet_export.split_text(root)
        self.assertEqual(root.findall(f".//{sheet_export.TEXT}"), [])
        self.assertEqual(len(root.findall(".//{http://www.w3.org/2000/svg}path")), 1)
        self.assertEqual([run["text"] for run in runs], ["Centred label", "Moved", "22.00"])
        centred, moved, rotated = runs
        self.assertEqual((centred["x"], centred["y"], centred["anchor"], centred["size"], centred["family"], centred["bold"]),
                         (5.0, 6.0, "middle", 3.5, "osifont", False))
        self.assertEqual(centred["matrix"], [1.0, 0.0, 0.0, 1.0, 10.0, 20.0])
        self.assertEqual((moved["x"], moved["y"], moved["family"], moved["bold"], moved["anchor"]), (7.0, 8.0, "sans-serif", True, "start"))
        a, b, c, d, e, f = rotated["matrix"]
        apply = lambda x, y: (round(a * x + c * y + e, 9), round(b * x + d * y + f, 9))
        self.assertEqual((apply(3, 4), apply(4, 4)), ((3.0, 4.0), (3.0, 3.0)))  # rotated -90 degrees about (3, 4)
        self.assertEqual((rotated["size"], rotated["fill"]), (2.5, "#111"))

    def test_sheet_size_and_unsized_text_are_checked(self) -> None:
        self.assertEqual(sheet_export.sheet_size_mm(SafeET.fromstring(self.SVG)), (200.0, 150.0))
        letter = SafeET.fromstring('<svg xmlns="http://www.w3.org/2000/svg" width="11in" height="8.5in"/>')
        self.assertAlmostEqual(sheet_export.sheet_size_mm(letter)[1], 215.9)
        with self.assertRaisesRegex(sheet_export.ExportError, "not a length"):
            sheet_export.sheet_size_mm(SafeET.fromstring('<svg xmlns="http://www.w3.org/2000/svg" width="100%"/>'))
        with self.assertRaisesRegex(sheet_export.ExportError, "no font size"):
            sheet_export.split_text(SafeET.fromstring('<svg xmlns="http://www.w3.org/2000/svg"><text>bare</text></svg>'))

    def test_qt_style_pdf_text_and_page_size(self) -> None:
        cmap = (b"begincmap\n1 beginbfchar\n<0001> <0041>\nendbfchar\n2 beginbfrange\n<0002> <0003> [<0042> <0009>]\n"
                b"<0004> <0005> <0043>\nendbfrange\nendcmap\n")
        content = zlib.compress(b"BT\n/F5 100 Tf 1 0 0 -1 0 0 Tm\n0 0 Td <0001> Tj\n1 0 Td <0003> Tj\n1 0 Td <0002> Tj\n"
                                b"/Span << /ActualText <> >> BDC\n1 0 Td <0004> Tj\nEMC\nET\nBT\n/F5 100 Tf\n0 0 Td <0005> Tj\nET\n")
        objects = [b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                   b"<< /Type /Page /Parent 2 0 R /Contents 7 0 R /Resources 4 0 R /MediaBox [0 0 842.000000 595.000000] >>",
                   b"<< /Font << /F5 5 0 R >> >>",
                   b"<< /Type /Font /Subtype /Type0 /BaseFont /osifont /ToUnicode 6 0 R>>",
                   b"<< /Length %d >>\nstream\n%sendstream" % (len(cmap), cmap),
                   b"<< /Length %d /Filter /FlateDecode >>\nstream\n%s\nendstream" % (len(content), content)]
        directory = tempfile.TemporaryDirectory(prefix="cad-pdf-read-")
        self.addCleanup(directory.cleanup)
        pdf = Path(directory.name) / "sheet.pdf"
        pdf.write_bytes(b"%PDF-1.4\n" + b"".join(b"%d 0 obj\n%s\nendobj\n" % (number, body)
                                                 for number, body in enumerate(objects, start=2)))
        read = sheet_export.read_pdf(pdf)
        self.assertEqual(read.page_sizes_pt, [(842.0, 595.0)])
        self.assertEqual(read.fonts, ["osifont"])
        self.assertEqual(read.text, "A B\nD")  # tab read as a space; the synthetic-bold repeat skipped


if __name__ == "__main__":
    unittest.main()
