#!/usr/bin/env python3
"""Shared drawing contracts: drawing_contract.load_context, drawing_document sheets/pages/packages, freecad_views.

The FreeCAD cases run tests/freecad_views_job.py through the real freecadcmd (FREECADCMD, PATH or the
macOS app) and export through it; they are skipped only when no FreeCAD is installed.
Run: uv run --with pyyaml --with defusedxml --with jsonschema python -m unittest discover -s cad/skills/cad-drawings/tests
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import re
import sys
import tempfile
import unittest
from pathlib import Path

import yaml
from defusedxml import ElementTree as SafeET

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
VIEWS_JOB = HERE / "freecad_views_job.py"
sys.path.insert(0, str(SCRIPTS))
import drawing_contract  # noqa: E402
import drawing_document  # noqa: E402
import freecad_runtime  # noqa: E402
import sheet_export  # noqa: E402
from drawing_document import (CompositionError, CoverageReport, SheetMetadata, SvgAnnotation, SvgNote,  # noqa: E402
                              SvgTable, compose_page, page_layout, publish_package, sheet_specs)
from freecad_views import Circle, ViewGeometry  # noqa: E402
from layout_check import SVG_NS, Box, check_layout, path_points  # noqa: E402
from sheet import TextureSymbol  # noqa: E402

FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file()
PN = "TST-0001"

PRODUCT = {
    "id": "frame-fixture", "rigor": "pro", "units": "mm", "regime": "iso", "general_tolerance": "ISO 2768-m",
    "flow": {"stage": "detail", "recheck_from": "detail"},
    "drawing": {"definition": "model_and_drawing", "projection": "first_angle",
                "standards": {"dimensioning": "ISO 129-1:2018", "gps_fundamentals": "ISO 8015:2011"},
                "default_sheet": {"sizes": ["A3"], "orientation": "landscape", "scale": "auto"},
                "tolerance_policies": {"machining": {"kind": "standard", "standard": "ISO 2768-1:1989", "class": "m",
                                                     "applies_to": ["cnc"]}},
                "general_tolerance_policy": "machining"},
}
PART = {"PN": PN, "rev": "X1", "title": "Fixture plate", "material": "Aluminum 6061-T6", "process": "cnc",
        "finish": "anodised", "mass_target": 70, "make_buy": "make", "supplier": None,
        "procurement": {"mode": "made_to_drawing"},
        "drawing": {"type": "detail", "datum_features": {"A": {"feature": "bed_face", "role": "plane"}},
                    "views": [{"id": "plan", "kind": "orthographic", "normal_to": "A"}]}}
LOCATORS = {"bed_face": {"kind": "plane_face", "frame": "assembly_zero",
                         "patches": [{"support_type": "plane", "point_mm": [30.0, 20.0, 0.0], "normal": [0.0, 0.0, -1.0]}]}}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_project(root: Path, *, features: bool = True) -> tuple[Path, Path]:
    """A valid record with one part and a version folder whose manifest hashes every file, as `run` writes it."""
    hw = root / "project" / "hw"
    (hw / "parts" / PN).mkdir(parents=True)
    documents = {
        "product.yaml": PRODUCT,
        "requirements.yaml": {"requirements": [{"id": "REQ-001", "text": "Plate", "rationale": "Fixture", "source": "Test",
                                                "priority": "must", "verification": {"method": "I", "criteria": "Made"}}]},
        "interfaces.yaml": {"interfaces": []},
        "assembly.yaml": {"subassemblies": [{"id": "main", "title": "Main", "parts": [PN]}], "joints": []},
    }
    for name, document in documents.items():
        (hw / name).write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")
    (hw / "parts" / PN / "part.yaml").write_text(yaml.safe_dump(PART, sort_keys=False), encoding="utf-8")
    model = b'KERNEL = "cadquery"\nPARAMS = {}\n'
    (hw / "parts" / PN / "model.py").write_bytes(model)
    with (hw / "bom.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(["level", "PN", "rev", "qty", "title", "material", "process", "make_buy", "supplier", "mass"])
        writer.writerow(["1", PN, "X1", "1", PART["title"], PART["material"], "cnc", "make", "", "70"])
    (hw / "verification.csv").write_text("requirement_id,method,criteria,result,evidence\nREQ-001,I,Made,planned,\n",
                                         encoding="utf-8")
    version = hw / "versions" / "v1"
    (version / "parts").mkdir(parents=True)
    files = {"parts/TST-0001.step": b"ISO-10303-21; part stand-in\n", "assembly.step": b"ISO-10303-21; assembly stand-in\n",
             "metrics.json": json.dumps({"parts": {PN: {"volume_mm3": 1.0, "holes": []}}}).encode()}
    if features:
        files["drawing-features.json"] = json.dumps({"label": "v1", "frame": "assembly_zero",
                                                     "parts": {PN: LOCATORS}}).encode()
    for name, data in files.items():
        (version / name).write_bytes(data)
    snapshot = version / "record"
    (snapshot / "parts" / PN).mkdir(parents=True)
    record_files = {"product.yaml": (hw / "product.yaml").read_bytes(),
                    "interfaces.yaml": (hw / "interfaces.yaml").read_bytes(),
                    "assembly.yaml": (hw / "assembly.yaml").read_bytes(),
                    f"parts/{PN}/part.yaml": (hw / "parts" / PN / "part.yaml").read_bytes()}
    for name, data in record_files.items():
        target = snapshot / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    assembly_sha = sha((hw / "assembly.yaml").read_bytes())
    manifest = {"schema_version": 2, "label": "v1", "product_id": PRODUCT["id"], "assembly_yaml_sha256": assembly_sha,
                "parts": {PN: {"model": f"parts/{PN}/model.py", "source_sha256": sha(model), "step": f"parts/{PN}.step"}},
                "record": {f"record/{name}": sha(data) for name, data in record_files.items()},
                "manufacturing": {},
                "files": {**{name: sha(data) for name, data in files.items()},
                          **{f"record/{name}": sha(data) for name, data in record_files.items()}}}
    if features:
        manifest["drawing_features"] = "drawing-features.json"
    (version / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return hw, version


class LoadContext(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def assert_contract_error(self, code: str, text: str, hw: Path, version: Path) -> drawing_contract.ContractError:
        with self.assertRaises(drawing_contract.ContractError) as raised:
            drawing_contract.load_context(hw, version)
        self.assertEqual(raised.exception.code, code)
        self.assertIn(text, str(raised.exception))
        return raised.exception

    def test_context_binds_record_and_version_evidence(self) -> None:
        hw, version = write_project(self.root)
        context = drawing_contract.load_context(hw, version)
        part = context.part(PN)
        self.assertEqual((context.label, part.record["title"], part.features), ("v1", "Fixture plate", LOCATORS))
        self.assertEqual(part.step, version.resolve() / "parts" / f"{PN}.step")
        self.assertEqual(part.step_sha256, sha(part.step.read_bytes()))
        self.assertEqual(context.bom[0]["PN"], PN)
        provenance = context.provenance(PN)
        self.assertEqual(provenance["step"], f"versions/v1/parts/{PN}.step")
        self.assertEqual(provenance["drawing_features_sha256"], sha((version / "drawing-features.json").read_bytes()))
        interfaces_hash = sha((version / "record" / "interfaces.yaml").read_bytes())
        self.assertEqual(provenance["interfaces_sha256"], interfaces_hash)
        self.assertEqual(context.provenance("TST-ASM")["interfaces_sha256"], interfaces_hash)
        with self.assertRaises(drawing_contract.ContractError):
            context.part("TST-0009")

    def test_version_without_hooks_has_no_features(self) -> None:
        context = drawing_contract.load_context(*write_project(self.root, features=False))
        self.assertIsNone(context.part(PN).features)
        self.assertIsNone(context.provenance(PN)["drawing_features_sha256"])

    def test_changed_version_file_is_a_source_mismatch(self) -> None:
        hw, version = write_project(self.root)
        with (version / "parts" / f"{PN}.step").open("ab") as stream:
            stream.write(b"tampered\n")
        self.assert_contract_error("source_mismatch", "changed after the build", hw, version)

    def test_stale_model_or_assembly_is_a_source_mismatch(self) -> None:
        hw, version = write_project(self.root)
        model = hw / "parts" / PN / "model.py"
        model.write_text(model.read_text(encoding="utf-8") + "# edited\n", encoding="utf-8")
        self.assert_contract_error("source_mismatch", "model.py changed after v1 was built", hw, version)
        hw, version = write_project(self.root / "second")
        with (hw / "assembly.yaml").open("a", encoding="utf-8") as stream:
            stream.write("# edited\n")
        self.assert_contract_error("source_mismatch", "assembly.yaml changed after v1", hw, version)

    def test_invalid_record_is_invalid_drawing_intent(self) -> None:
        hw, version = write_project(self.root)
        path = hw / "parts" / PN / "part.yaml"
        path.write_text(path.read_text(encoding="utf-8").replace("type: detail", "type: sketch"), encoding="utf-8")
        error = self.assert_contract_error("invalid_drawing_intent", "validation findings", hw, version)
        self.assertTrue(any("drawing/type" in finding["message"] for finding in error.findings), error.findings)

    def test_folder_outside_versions_is_refused(self) -> None:
        hw, version = write_project(self.root)
        self.assert_contract_error("source_mismatch", "is not a version folder", hw, hw)


def rectangle_view(view_id: str, centre: tuple[float, float], half: tuple[float, float], role: str = "plan") -> ViewGeometry:
    w, h = half
    return ViewGeometry(view_id=view_id, role=role, kind="part", centre_mm=centre, scale=1.0, rotation_deg=0.0,
                        direction=(0.0, 0.0, 1.0), x_direction=(1.0, 0.0, 0.0),
                        visible=(f"M {-w} {-h} L {w} {-h} L {w} {h} L {-w} {h} Z", "M -4 0 A 4 4 0 1 1 4 0 A 4 4 0 1 1 -4 0 Z"),
                        hidden=(f"M {-w} 0 L {w} 0",), circles=(Circle((0.0, 0.0), 4.0, "visible"),),
                        bounds=(-w, -h, w, h))


def metadata(**changes: object) -> SheetMetadata:
    values = {"drawing_number": PN, "revision": "X1", "title": "Fixture plate", "document_type": "Part drawing",
              "sheet_number": 1, "sheet_count": 1, "scale": 2.0, "material": "Aluminum 6061-T6",
              "general_tolerance": "ISO 2768-m", "standards": ("ISO 129-1:2018", "ISO 8015:2011")}
    values.update(changes)
    return SheetMetadata(**values)


def leader(annotation_id: str, tip: tuple[float, float], text_at: tuple[float, float], text: str) -> SvgAnnotation:
    (tx, ty), (lx, ly) = tip, text_at
    return SvgAnnotation(annotation_id, "leader",
                         f'<line x1="{lx}" y1="{ly}" x2="{tx}" y2="{ty}" stroke="#000" stroke-width="0.25"/>'
                         f'<text x="{lx + 1}" y="{ly}" font-size="3.5" font-family="osifont">{text}</text>',
                         {"measurement": "m1", "requirement": "r1"})


class SheetSpecs(unittest.TestCase):
    def test_iso_sizes_are_framed_by_iso_5457_smallest_first(self) -> None:
        specs = sheet_specs(PRODUCT, ["A2", "A4", "A3"])
        self.assertEqual([s.size for s in specs], ["A4", "A3", "A2"])
        a3 = specs[1]
        self.assertEqual((a3.width_mm, a3.height_mm, a3.projection, a3.projection_type),
                         (420.0, 297.0, "first_angle", "First angle"))
        self.assertEqual(a3.regions.frame, Box(20.0, 10.0, 410.0, 287.0))
        self.assertEqual(a3.regions.title_block, Box(230.0, 242.0, 410.0, 287.0))
        self.assertTrue(a3.regions.title_block.contains(a3.regions.symbol_cell))
        self.assertIn('width="420mm" height="297mm"', a3.page_template_svg())

    def test_projection_and_orientation_come_from_the_product_policy(self) -> None:
        product = {**PRODUCT, "drawing": {**PRODUCT["drawing"], "projection": "third_angle",
                                          "default_sheet": {"sizes": ["A4"], "orientation": "portrait"}}}
        (a4,) = sheet_specs(product, ["A4"])
        self.assertEqual((a4.projection, a4.width_mm, a4.height_mm), ("third_angle", 210.0, 297.0))
        self.assertEqual(a4.regions.title_block.x1 - a4.regions.title_block.x0, 180.0)
        self.assertTrue(a4.regions.frame.contains(a4.regions.title_block))
        (ansi,) = sheet_specs({"regime": "asme"}, ["ANSI B"])
        self.assertEqual((ansi.projection, ansi.width_mm, ansi.height_mm), ("third_angle", 431.8, 279.4))

    def test_unusable_requests_are_refused(self) -> None:
        for product, sizes in ((PRODUCT, ["ANSI A"]), (PRODUCT, []), ({"regime": "din"}, ["A4"]), (PRODUCT, ["B5"])):
            with self.subTest(sizes=sizes, regime=product.get("regime")), self.assertRaises(ValueError):
                sheet_specs(product, sizes)

    def test_scales(self) -> None:
        self.assertEqual(drawing_document.candidate_scales(2.0)[:3], [2.0, 1.0, 0.5])
        self.assertEqual((drawing_document.scale_text("iso", 5.0), drawing_document.scale_text("asme", 0.5)), ("5 : 1", "1:2"))


class ComposePage(unittest.TestCase):
    """compose_page output against layout_check, without FreeCAD."""

    def setUp(self) -> None:
        self.spec = sheet_specs(PRODUCT, ["A3"])[0]

    def compose(self, views=None, annotations=(), tables=(), notes=(), spec=None, **meta):
        return compose_page(spec or self.spec, metadata(**meta), views or [rectangle_view("plan", (120.0, 100.0), (60.0, 40.0))],
                            annotations, tables, notes)

    def test_clean_page_passes_layout_check_and_names_its_identity(self) -> None:
        table = SvgTable("parts", ("Item", "PN", "Qty"), (("1", PN, "1"), ("2", "TST-0002", "4")))
        note = SvgNote("edges", "Break sharp edges 0.2 to 0.5 x 45 degrees unless otherwise shown, per ISO 13715.",
                       {"requirement": "edge_break"})
        sheet = self.compose(annotations=[leader("bore-callout", (120.0, 100.0), (190.0, 50.0), "⌀8 H7")],
                             tables=[table], notes=[note])
        self.assertEqual(check_layout(sheet.svg, sheet.regions, sheet.placeholders), [])
        self.assertEqual(sheet.required_text, (PN, "X1", "Fixture plate", "1 / 1", "Aluminum 6061-T6", "ISO 2768-m"))
        self.assertEqual(sheet.annotations, {"bore-callout": {"measurement": "m1", "requirement": "r1"},
                                             "edges": {"requirement": "edge_break"}})
        for text in ("Identification number", "2 : 1", "A3", "ISO 129-1:2018 · ISO 8015:2011", "Notes", "TST-0002"):
            self.assertIn(f">{text}<", sheet.svg)
        layout = page_layout(self.spec, [table], [note])
        self.assertEqual(sheet.regions.title_block, layout.title_region)
        self.assertEqual((layout.tables["parts"].x1, layout.tables["parts"].y1), (410.0, 242.0))
        self.assertTrue(layout.notes.x0 < self.spec.regions.title_block.x0 and layout.notes.y1 == 286.0)
        self.assertIn('stroke-dasharray="3 0.75"', sheet.svg, "hidden lines keep their own line type")

    def test_view_over_a_table_or_notes_fails_layout_check(self) -> None:
        table = SvgTable("parts", ("Item", "PN"), (("1", PN),))
        on_table = self.compose(views=[rectangle_view("plan", (390.0, 228.0), (8.0, 4.0))], tables=[table])
        self.assertIn("view-plan overlaps the title block", check_layout(on_table.svg, on_table.regions, on_table.placeholders))
        on_notes = self.compose(views=[rectangle_view("plan", (40.0, 280.0), (10.0, 4.0))],
                                notes=[SvgNote("n1", "Deburr all edges.")])
        problems = check_layout(on_notes.svg, on_notes.regions, on_notes.placeholders)
        self.assertTrue(any("overlaps view-plan geometry" in p for p in problems), problems)

    def test_a_note_symbol_takes_its_own_row_and_passes_layout_check(self) -> None:
        symbol = TextureSymbol("Ra 1.6", "removal_required", others=True)
        plain = SvgNote("surface-texture", "Surface texture ISO 21920-1, unless otherwise indicated:")
        marked = SvgNote(plain.id, plain.text, symbol=symbol)
        grown, base = page_layout(self.spec, [], [marked]).notes, page_layout(self.spec, [], [plain]).notes
        self.assertAlmostEqual((grown.y1 - grown.y0) - (base.y1 - base.y0), symbol.size(2.5)[1] + 1.0)
        sheet = self.compose(notes=[marked])
        self.assertEqual(check_layout(sheet.svg, sheet.regions, sheet.placeholders), [])
        notes = re.search(r'<g id="general-notes".*', sheet.svg, re.S).group(0)
        self.assertIn('class="texture"', notes)
        self.assertIn(">Ra 1.6<", notes)

    def test_projection_symbol_follows_the_projection_method(self) -> None:
        def symbol_order(projection: str) -> tuple[float, float]:
            product = {**PRODUCT, "drawing": {**PRODUCT["drawing"], "projection": projection}}
            sheet = self.compose(spec=sheet_specs(product, ["A3"])[0])
            group = re.search(r'<g id="projection-symbol".*?</g>', sheet.svg, re.S).group(0)
            cone_x = [float(v) for v in re.findall(r"([\d.]+),[\d.]+", re.search(r'points="([^"]+)"', group).group(1))]
            return sum(cone_x) / len(cone_x), float(re.search(r'cx="([\d.]+)"', group).group(1))
        cone, circles = symbol_order("first_angle")
        self.assertLess(cone, circles, "first angle: end view right of the cone")
        cone, circles = symbol_order("third_angle")
        self.assertGreater(cone, circles, "third angle: end view left of the cone")

    def test_furniture_that_cannot_fit_is_a_composition_error(self) -> None:
        wide = SvgTable("wide", tuple(f"column {i} with a long heading" for i in range(12)), ())
        with self.assertRaises(CompositionError) as raised:
            self.compose(tables=[wide])
        self.assertEqual(raised.exception.code, "sheet_no_fit")
        with self.assertRaises(CompositionError) as raised:
            self.compose(title="A title far too long for the title block cell even at the smallest lettering height " * 2)
        self.assertEqual(raised.exception.code, "layout_check_failed")

    def test_a_long_general_tolerance_wraps_into_its_cell_at_the_minimum_lettering(self) -> None:
        value = "Explicit tolerances only; no default tolerance is approved."   # 63.7 mm at 1.8 mm; the cell 57.6
        cell = drawing_document._title_cells(self.spec.regions.title_block)["general_tolerance"]
        self.assertGreater(drawing_document.text_width(value, 1.8), cell.x1 - cell.x0 - 2 * drawing_document.CELL_PAD)
        sheet = self.compose(general_tolerance=value)
        self.assertEqual(check_layout(sheet.svg, sheet.regions, sheet.placeholders), [])
        root = SafeET.fromstring(sheet.svg)
        block = next(g for g in root.iter(f"{{{SVG_NS}}}g") if g.get("id") == "cad-title-block")
        rows = [(t.text, float(t.get("x")), float(t.get("y")), float(t.get("font-size")))
                for t in block.iter(f"{{{SVG_NS}}}text") if cell.x0 <= float(t.get("x")) < cell.x1
                and cell.y0 < float(t.get("y")) < cell.y1]
        label, *lines = sorted(rows, key=lambda row: row[2])
        self.assertEqual(label[0], "General tolerances")
        self.assertEqual(" ".join(text for text, *_ in lines), value)
        self.assertEqual([size for *_, size in lines], [1.8, 1.8])
        for text, x, y, size in lines:   # inside the cell, under the label, apart from each other
            self.assertLessEqual(x + drawing_document.text_width(text, size), cell.x1 - drawing_document.CELL_PAD)
        self.assertGreater(lines[0][2] - 0.8 * 1.8, label[2] + 0.25 * 1.8)
        self.assertGreater(lines[1][2] - 0.8 * 1.8, lines[0][2] + 0.25 * 1.8)
        self.assertLess(lines[1][2] + 0.25 * 1.8, cell.y1)
        self.assertEqual(sheet.required_text[-2:], tuple(text for text, *_ in lines))   # the PDF text layer check
        with self.assertRaises(CompositionError) as raised:
            self.compose(general_tolerance=value * 2)
        self.assertEqual(raised.exception.code, "layout_check_failed")

    def test_invalid_content_is_refused(self) -> None:
        view = rectangle_view("plan", (120.0, 100.0), (60.0, 40.0))
        for name, call in {
            "duplicate annotation": lambda: self.compose(annotations=[leader("a", (1, 1), (2, 2), "x")] * 2),
            "note id clashing with an annotation": lambda: self.compose(annotations=[leader("a", (1, 1), (2, 2), "x")],
                                                                        notes=[SvgNote("a", "text")]),
            "duplicate view": lambda: self.compose(views=[view, view]),
            "sheet out of range": lambda: self.compose(sheet_number=2, sheet_count=1),
            "no views": lambda: compose_page(self.spec, metadata(), [], (), (), ()),
            "malformed markup": lambda: self.compose(annotations=[SvgAnnotation("m", "label", "<text>open")]),
            "ragged table": lambda: self.compose(tables=[SvgTable("t", ("a", "b"), (("1",),))]),
        }.items():
            with self.subTest(name), self.assertRaises(ValueError):
                call()

    def test_view_geometry_round_trips_through_json(self) -> None:
        view = rectangle_view("plan", (120.0, 100.0), (60.0, 40.0))
        self.assertEqual(ViewGeometry.from_dict(json.loads(json.dumps(view.to_dict()))), view)
        broken = view.to_dict()
        broken["visible"] = []
        with self.assertRaises(ValueError):
            ViewGeometry.from_dict(broken)
        self.assertEqual(view.sheet_bounds(), (60.0, 60.0, 180.0, 140.0))

    def test_coverage_report_passes_exactly_without_findings(self) -> None:
        with self.assertRaises(ValueError):
            CoverageReport("pass", findings=({"code": "geometry_unaccounted", "message": "x"},))
        with self.assertRaises(ValueError):
            CoverageReport("fail")


def segment_distance(point: tuple[float, float], path: str, centre: tuple[float, float]) -> float:
    """Distance from a sheet point to a straight-segment path drawn at ``centre``."""
    points = [(centre[0] + x, centre[1] + y) for x, y in path_points(path)]
    best = math.inf
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        dx, dy = x1 - x0, y1 - y0
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((point[0] - x0) * dx + (point[1] - y0) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(point[0] - (x0 + t * dx), point[1] - (y0 + t * dy)))
    return best


@unittest.skipUnless(FREECAD_PRESENT, "FreeCAD's freecadcmd is required (set FREECADCMD or install FreeCAD 1.1)")
class FreeCadViewsAndPackage(unittest.TestCase):
    """serialize_view and project_anchor in real freecadcmd, then compose_page and publish_package with a real export."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.spec = sheet_specs(PRODUCT, ["A3"])[0]
        template = cls.root / "page.svg"
        template.write_text(cls.spec.page_template_svg(), encoding="utf-8")
        result, message = freecad_runtime.run_job(FREECADCMD, VIEWS_JOB, {"scripts": str(SCRIPTS), "template": str(template)},
                                                  cls.root, 300)
        if result is None:
            raise RuntimeError(f"FreeCAD views job failed: {message}")
        cls.views = {name: ViewGeometry.from_dict(data) for name, data in result["views"].items()}
        cls.anchors = {name: {key: tuple(point) for key, point in points.items()} for name, points in result["anchors"].items()}

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def radii_at(self, view: str, anchor: str) -> list[float]:
        """Radii of the visible circles centred on a projected anchor."""
        geometry, point = self.views[view], self.anchors[view][anchor]
        return [round(circle.radius, 6) for circle in geometry.circles if circle.layer == "visible" and math.dist(
            (geometry.centre_mm[0] + circle.centre[0], geometry.centre_mm[1] + circle.centre[1]), point) < 1e-6]

    def test_projected_bore_centres_land_on_their_circles(self) -> None:
        for view, anchor, radius in (("front", "big_bore_top", 8.0), ("front", "small_bore_top", 3.0),
                                     ("rotated", "big_bore_top", 4.0), ("rotated", "small_bore_top", 1.5),
                                     ("group_top", "big_bore_top", 4.0), ("detail", "small_bore_top", 7.5)):
            with self.subTest(view=view, anchor=anchor):
                self.assertIn(radius, self.radii_at(view, anchor), self.views[view].circles)

    def test_section_witness_points_lie_on_the_cut_bore_wall(self) -> None:
        section = self.views["section"]
        for anchor in ("big_bore_wall_top", "big_bore_wall_bottom"):
            point = self.anchors["section"][anchor]
            distance = min(segment_distance(point, path, section.centre_mm) for path in section.visible)
            self.assertLess(distance, 1e-6, f"{anchor} {point}")
        top, bottom = (self.anchors["section"][k] for k in ("big_bore_wall_top", "big_bore_wall_bottom"))
        self.assertAlmostEqual(bottom[1] - top[1], 24.0, places=6, msg="12 mm of wall at 2 : 1, Y down")

    def test_views_carry_placement_scale_direction_and_layers(self) -> None:
        front, top = self.views["front"], self.views["group_top"]
        self.assertEqual((front.kind, front.scale, front.centre_mm), ("part", 2.0, (100.0, 77.0)))
        self.assertEqual(front.bounds, (-60.0, -40.0, 60.0, 40.0))
        self.assertTrue(front.hidden, "the front view enables hidden lines")
        self.assertEqual(top.hidden, ())
        self.assertEqual((self.views["section"].kind, self.views["detail"].kind), ("section", "detail"))
        self.assertEqual(self.views["rotated"].rotation_deg, 30.0)
        self.assertEqual(self.views["front"].direction, (0.0, 0.0, 1.0))
        for view in self.views.values():
            self.assertEqual(ViewGeometry.from_dict(json.loads(json.dumps(view.to_dict()))), view)

    def compose(self, annotations: list[SvgAnnotation], **meta) -> drawing_document.ComposedSheet:
        tip = self.anchors["front"]["big_bore_top"]
        callout = leader("big-bore", (tip[0] - 8.0, tip[1]), (40.0, 25.0), "⌀8")
        return compose_page(self.spec, metadata(**meta), list(self.views.values()), [callout, *annotations],
                            [SvgTable("parts", ("Item", "PN", "Qty"), (("1", PN, "1"),))],
                            [SvgNote("edges", "Break sharp edges.")])

    def test_composed_freecad_views_publish_and_a_failed_rerun_leaves_no_package(self) -> None:
        context = drawing_contract.load_context(*write_project(self.root / "record"))
        sheet = self.compose([])
        self.assertEqual(check_layout(sheet.svg, sheet.regions, sheet.placeholders), [])
        output = self.root / "package"
        report = publish_package(context, [sheet], CoverageReport("pass", rows=({"feature": "bed_face"},)), output,
                                 FREECADCMD, 300, bundle_path=context.hw / "drawings" / "v1" / PN)
        self.assertEqual((report.status, report.exit_code, report.findings), ("pass", 0, ()), report.findings)
        self.assertEqual(sorted(p.name for p in output.iterdir()),
                         ["coverage.json", "package.json", "sheet-1.pdf", "sheet-1.png", "sheet-1.svg"])
        package = json.loads((output / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["output_dir"], f"hw/drawings/v1/{PN}")
        self.assertEqual(package["sheets"][0]["files"]["svg"], f"hw/drawings/v1/{PN}/sheet-1.svg")
        self.assertEqual(package["sheets"][0]["files"]["pdf"], f"hw/drawings/v1/{PN}/sheet-1.pdf")
        self.assertEqual(package["sheets"][0]["sha256"]["pdf"], sha((output / "sheet-1.pdf").read_bytes()))

        crossing = SvgAnnotation("over-view", "label", '<text x="100" y="77" font-size="3.5" font-family="osifont">ON THE PART</text>')
        rejected_draft = self.root / "rejected-draft"
        failed = publish_package(context, [self.compose([crossing])], CoverageReport("pass"),
                                 rejected_draft, FREECADCMD, 300)
        self.assertEqual((failed.status, failed.exit_code, [f["code"] for f in failed.findings]),
                         ("fail", 1, ["layout_check_failed"]))
        retained = self.root / "record" / "project" / ".cad-work" / "rejected-drawings"
        self.assertEqual(len(list(retained.iterdir())), 1)
        incomplete_output = self.root / "incomplete"
        incomplete = CoverageReport("fail", findings=({"code": "dimension_coverage_incomplete", "message": "bore depth"},))
        refused = publish_package(context, [sheet], incomplete, incomplete_output, FREECADCMD, 300)
        self.assertEqual([f["code"] for f in refused.findings], ["dimension_coverage_incomplete"])
        self.assertTrue(retained.is_dir())

        stranger = self.root / "not-a-package"
        stranger.mkdir()
        (stranger / "notes.txt").write_text("keep me\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            publish_package(context, [sheet], CoverageReport("pass"), stranger, FREECADCMD, 300)
        self.assertEqual([p.name for p in stranger.iterdir()], ["notes.txt"])
        with self.assertRaises(ValueError):
            publish_package(context, [sheet, sheet], CoverageReport("pass"), output, FREECADCMD, 300)

    def test_a_wrapped_general_tolerance_publishes_with_both_lines_in_the_pdf_text(self) -> None:
        context = drawing_contract.load_context(*write_project(self.root / "wrapped-record"))
        sheet = self.compose([], general_tolerance="Explicit tolerances only; no default tolerance is approved.")
        output = self.root / "wrapped-package"
        report = publish_package(context, [sheet], CoverageReport("pass", rows=({"feature": "bed_face"},)), output,
                                 FREECADCMD, 300, bundle_path=context.hw / "drawings" / "v1" / PN)
        self.assertEqual((report.status, report.findings), ("pass", ()), report.findings)
        lines = sheet_export.read_pdf(output / "sheet-1.pdf").text.split("\n")
        self.assertIn("Explicit tolerances only; no default tolerance is", lines)
        self.assertIn("approved.", lines)


class DrawingPublication(unittest.TestCase):
    def test_publish_reuse_conflict_replace_and_version_immutability(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cad-drawing-bundle-") as temporary:
            hw, version = write_project(Path(temporary))
            api = drawing_contract.layout_api()
            params = {"V": "v1", "S": PN}
            recipe = {"part": PN, "input_sha256": "a" * 64}
            target = api.bundle_dir(hw, "drawings", "v1", PN)
            old_version_manifest = (version / "manifest.json").read_bytes()

            def staged_bundle(value: bytes) -> Path:
                staged = api.staging(hw, "bundle.drawings")
                (staged / "coverage.json").write_text("{}\n", encoding="utf-8")
                package = {"output_dir": api.relative(hw, target),
                           "sheets": [{"files": {"svg": api.relative(hw, target / "sheet-1.svg")}}]}
                (staged / "package.json").write_text(json.dumps(package), encoding="utf-8")
                for extension in ("svg", "pdf", "png"):
                    (staged / f"sheet-1.{extension}").write_bytes(value)
                return staged
            api.publish(hw, "bundle.drawings", params, staged_bundle(b"old"), recipe=recipe,
                        producer="test drawing")
            published = json.loads((target / "package.json").read_text(encoding="utf-8"))
            self.assertEqual(published["output_dir"], api.relative(hw, target))
            self.assertEqual(published["sheets"][0]["files"], {"svg": api.relative(hw, target / "sheet-1.svg")})
            self.assertEqual(api.reusable(hw, "bundle.drawings", params, recipe), target)
            original_manifest = (target / "manifest.json").read_bytes()
            changed_recipe = {"part": PN, "input_sha256": "b" * 64}
            with self.assertRaises(api.PublishConflict):
                api.reusable(hw, "bundle.drawings", params, changed_recipe)
            replacement = staged_bundle(b"new")
            with self.assertRaises(api.PublishConflict):
                api.publish(hw, "bundle.drawings", params, replacement, recipe=changed_recipe,
                            producer="test drawing")
            self.assertEqual((target / "manifest.json").read_bytes(), original_manifest)
            replaced = api.publish(hw, "bundle.drawings", params, staged_bundle(b"new"),
                                   recipe=changed_recipe, producer="test drawing", replace=True)
            self.assertTrue(replaced.replaced.is_dir())
            self.assertEqual((replaced.replaced / "sheet-1.svg").read_bytes(), b"old")
            self.assertEqual((target / "sheet-1.svg").read_bytes(), b"new")
            self.assertEqual(api.verify(replaced.path), [])
            self.assertEqual((version / "manifest.json").read_bytes(), old_version_manifest)


if __name__ == "__main__":
    unittest.main()
