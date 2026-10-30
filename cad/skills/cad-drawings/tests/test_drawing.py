#!/usr/bin/env python3
"""Focused layout, FreeCAD discovery and export-reading tests; part drawings are in test_part_drawings.py."""

from __future__ import annotations

import json
import os
import signal
import sys
import tempfile
import time
import unittest
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from defusedxml import ElementTree as SafeET

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/drawing.py"
sys.path.insert(0, str(SCRIPT.parent))
import freecad_runtime  # noqa: E402
import sheet_export  # noqa: E402
from layout_check import Box, SheetRegions, check_layout  # noqa: E402

FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file()
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
        found = freecad_runtime.find_freecadcmd({"HOME": str(self.root / "empty-home"), "PATH": str(self.root)})
        self.assertEqual(found, app if app.is_file() else None)

    def test_lookup_uses_authoritative_home_candidate_when_path_omits_it(self) -> None:
        command = self.executable(self.root / ".local" / "bin" / "freecadcmd")
        environ = {"HOME": str(self.root), "PATH": str(self.root / "empty")}
        found = freecad_runtime.find_freecadcmd(environ, platform_name="linux")
        self.assertEqual(found, command)

    def test_templates_follow_a_symlinked_bundle_command(self) -> None:
        command = self.executable(self.root / "squashfs-root" / "usr" / "bin" / "freecadcmd")
        link = self.root / "local" / "bin" / "freecadcmd"
        link.parent.mkdir(parents=True)
        link.symlink_to(command)
        self.assertEqual(freecad_runtime.templates_dir(link),
                         command.resolve().parents[1] / "share" / "Mod" / "TechDraw" / "Templates")

class FreeCADConcurrency(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cad-freecad-parallel-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_jobs_default_is_bounded_by_cpu_available_memory_and_items(self) -> None:
        with patch.object(freecad_runtime.os, "cpu_count", return_value=8), \
                patch.object(freecad_runtime, "available_memory_bytes", return_value=4_000):
            self.assertEqual(freecad_runtime.jobs_for(None, 10, 1_000), 4)
            self.assertEqual(freecad_runtime.jobs_for(None, 2, 1_000), 2)
            self.assertEqual(freecad_runtime.jobs_for(5, 2, 1_000), 2)

    def test_auto_jobs_ignore_unknown_memory_bound(self) -> None:
        with patch.object(freecad_runtime.os, "cpu_count", return_value=8), \
                patch.object(freecad_runtime, "available_memory_bytes", return_value=0):
            self.assertEqual(freecad_runtime.jobs_for(None, 5, 1_000), 5)

    def test_shared_pool_results_stay_in_input_order(self) -> None:
        with ThreadPoolExecutor(max_workers=3) as executor:
            result = freecad_runtime.map_jobs((0.06, 0.0, 0.03), 3,
                                              lambda delay: (time.sleep(delay), delay)[1], executor)
        self.assertEqual(result, [0.06, 0.0, 0.03])

    def test_freecad_job_environment_is_isolated_and_stdout_is_not_the_summary(self) -> None:
        command = self.root / "fake-freecad"
        command.write_text("#!/bin/sh\nexec python3 \"$1\"\n", encoding="utf-8")
        command.chmod(0o755)
        script = self.root / "job.py"
        script.write_text("import json, os\n"
                          "job = json.load(open(os.environ['CAD_DRAWING_JOB']))\n"
                          "keys = ('HOME', 'FREECAD_USER_HOME', 'FREECAD_USER_DATA', 'FREECAD_USER_TEMP', "
                          "'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR')\n"
                          "json.dump({'status': 'pass', 'environment': {k: os.environ[k] for k in keys}, "
                          "'directories_exist': all(os.path.isdir(os.environ[k]) for k in keys)}, "
                          "open(job['result'], 'w'))\n"
                          "print('diagnostic output')\n", encoding="utf-8")
        with ThreadPoolExecutor(max_workers=2) as executor:
            values = freecad_runtime.map_jobs((1, 2), 2,
                                              lambda _: freecad_runtime.run_job(command, script, {}, self.root, 10)[0],
                                              executor)
        self.assertTrue(all(value and value["directories_exist"] for value in values))
        first, second = (value["environment"] for value in values if value)
        self.assertTrue(all(first[key] != second[key] for key in first))
    def test_sigterm_terminates_and_reaps_every_process_group(self) -> None:
        command = self.root / "fake-freecad"
        command.write_text("#!/bin/sh\nexec python3 \"$1\"\n", encoding="utf-8")
        command.chmod(0o755)
        script = self.root / "job.py"
        script.write_text("import json, os, signal, time\n"
                          "job = json.load(open(os.environ['CAD_DRAWING_JOB']))\n"
                          "open(job['result'] + '.pid', 'w').write(str(os.getpid()))\n"
                          "signal.signal(signal.SIGTERM, lambda *_: time.sleep(60))\n"
                          "time.sleep(60)\n", encoding="utf-8")
        with self.assertRaises(freecad_runtime.JobInterrupted):
            with freecad_runtime.terminate_jobs_on_signal():
                with ThreadPoolExecutor(max_workers=2) as executor:
                    [executor.submit(freecad_runtime.run_job, command, script, {}, self.root, 120) for _ in range(2)]
                    deadline = time.monotonic() + 10
                    while len(list(self.root.glob("*.result.json.pid"))) < 2 and time.monotonic() < deadline:
                        time.sleep(0.05)
                    self.assertEqual(len(list(self.root.glob("*.result.json.pid"))), 2)
                    os.kill(os.getpid(), signal.SIGTERM)

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
        self.assertEqual([run["segments"][0]["text"] for run in runs], ["Centred label", "Moved", "22.00"])
        centred, moved, rotated = runs
        self.assertEqual((centred["x"], centred["y"], centred["anchor"], centred["size"], centred["family"], centred["bold"]),
                         (5.0, 6.0, "middle", 3.5, "osifont", False))
        self.assertEqual(centred["matrix"], [1.0, 0.0, 0.0, 1.0, 10.0, 20.0])
        self.assertEqual((moved["x"], moved["y"], moved["family"], moved["bold"], moved["anchor"]),
                         (7.0, 8.0, "osifont", True, "start"))
        a, b, c, d, e, f = rotated["matrix"]
        apply = lambda x, y: (round(a * x + c * y + e, 9), round(b * x + d * y + f, 9))
        self.assertEqual((apply(3, 4), apply(4, 4)), ((3.0, 4.0), (3.0, 3.0)))
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
    @unittest.skipUnless(FREECAD_PRESENT, "bundled Osifont test needs FreeCAD 1.1.4 freecadcmd")
    def test_svg_generic_families_are_painted_with_osifont(self) -> None:
        command = freecad_runtime.find_freecadcmd()
        with tempfile.TemporaryDirectory(prefix="cad-font-parity-") as tmp:
            root = Path(tmp)
            svg = root / "input.svg"
            pdf = root / "output.pdf"
            png = root / "output.png"
            svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="150mm" viewBox="0 0 200 150">'
                           '<text x="10" y="20" font-family="sans-serif" font-size="10">Aa 0123</text>'
                           '<text x="10" y="40" font-size="10">⟂∥×−·</text></svg>', encoding="utf-8")
            sheet_export.export_sheet(command, svg, pdf, png, ["Aa 0123"], 300)
            content = sheet_export.read_pdf(pdf)
            runs = sheet_export.split_text(SafeET.fromstring(svg.read_text(encoding="utf-8")))
            self.assertEqual(runs[1]["segments"], [{"vector": character} for character in "⟂∥×−·"])
            self.assertIn('d="M -3 3 H 3 M 0 3 V -3"', runs[1]["vector_markup"]["⟂"])
            self.assertIn('d="M -3 3 H 3 M 0 3 V -3"', runs[1]["vector_markup"]["⊥"])
            self.assertTrue(all(set(run) == {"segments", "vector_advance", "vector_markup", "x", "y", "anchor", "size",
                                              "family", "bold", "fill", "matrix"} for run in runs))
        self.assertEqual(content.text, "Aa 0123")
        self.assertEqual(content.fonts, ["osifont"])
    def test_svg_unknown_glyph_is_rejected(self) -> None:
        root = SafeET.fromstring('<svg xmlns="http://www.w3.org/2000/svg"><text font-family="serif" font-size="10">☃</text></svg>')
        with self.assertRaisesRegex(sheet_export.ExportError, "unsupported glyph.*U\\+2603"):
            sheet_export.split_text(root)


if __name__ == "__main__":
    unittest.main()
