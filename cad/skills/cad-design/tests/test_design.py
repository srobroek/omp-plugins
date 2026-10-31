#!/usr/bin/env python3
"""cad-design tests: reference lamp-arm models in both kernels, the block-like detector, and the wall scan.

Run: python3 -m unittest discover -s cad/skills/cad-design/tests -v
Needs `uv`; the first run creates the CadQuery and build123d environments, and a cold
OCP import can take minutes, so the builds have no short timeout.
"""

from __future__ import annotations

import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
SCRIPTS = SKILL / "scripts"
EXAMPLE = SKILL.parent.parent / "examples" / "lamp-arm"
TEMPLATE_HW = EXAMPLE / "hw"
FIXTURES = SKILL.parent / "cad-motion" / "tests" / "fixtures" / "build_fixtures.py"
DEFECTS = HERE / "fixtures" / "defects"
KERNELS = ("cadquery", "build123d")
TEMPLATE_PARTS = sorted(p.name for p in (EXAMPLE / "hw" / "parts").iterdir() if (p / "part.yaml").is_file())
sys.path.insert(0, str(SKILL.parent / "cad-drawings" / "scripts"))
import freecad_runtime  # noqa: E402

FREECADCMD = freecad_runtime.find_freecadcmd()
FREECAD_PRESENT = FREECADCMD is not None and FREECADCMD.is_file() and os.access(FREECADCMD, os.X_OK)

_spec = importlib.util.spec_from_file_location("cad_design_form_check", SCRIPTS / "form_check.py")
assert _spec and _spec.loader
FORM_CHECK = importlib.util.module_from_spec(_spec)  # its OCP imports are deferred to the functions that need them
_spec.loader.exec_module(FORM_CHECK)

MADE_PARTS = ["LMP-0001", "LMP-0002", "LMP-0003", "LMP-0004"]


def run_json(command: list[str]) -> tuple[int, dict]:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        return result.returncode, json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(f"{command[:4]} printed no JSON (exit {result.returncode}):\n{result.stderr[-3000:]}") from error


def form_check(parts_dir: Path, fidelity: str, hw: Path = TEMPLATE_HW) -> tuple[int, dict]:
    return run_json(["uv", "run", "--script", str(SCRIPTS / "form_check.py"), "--hw", str(hw),
                     "--parts-dir", str(parts_dir), "--fidelity", fidelity])


FDM_MADE = "process: fdm\nmake_buy: make\n"


def build_parts(root: Path, parts: dict[str, tuple[str, str]]) -> tuple[Path, Path]:
    """Build one STEP per {PN: (part.yaml lines after PN, CadQuery expression)} with cad-design's product runner."""
    hw, models, parts_dir = root / "hw", root / "models", root / "parts"
    (hw / "parts").mkdir(parents=True)
    models.mkdir()
    (hw / "assembly.yaml").write_text("joints: []\n", encoding="utf-8")
    for pn, (record, expression) in parts.items():
        (hw / "parts" / pn).mkdir()
        (hw / "parts" / pn / "part.yaml").write_text(f"PN: {pn}\n{record}", encoding="utf-8")
        (models / f"{pn}.py").write_text('import cadquery as cq\nKERNEL = "cadquery"\nPARAMS = {}\n\n'
                                         f'def build(params):\n    return {expression}\n', encoding="utf-8")
    result = subprocess.run([sys.executable, str(SCRIPTS / "build_reference.py"), "--kernel", "cadquery",
                             "--models", str(models), "--hw", str(hw), "--out", str(parts_dir)],
                            capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise AssertionError(f"build_reference.py failed: {result.stderr[-2000:]}")
    return hw, parts_dir


def box_part(thickness: float, form_class: str | None = None) -> dict[str, tuple[str, str]]:
    record = FDM_MADE + (f"form_class: {form_class}\n" if form_class else "")
    return {"TST-0301": (record, f"cq.Workplane().box(10, 10, {thickness})")}


@unittest.skipUnless(FREECAD_PRESENT, "reference lamp tests need FreeCAD 1.1.4's bundled Osifont")
class ReferenceModelTests(unittest.TestCase):
    """Both kernels' reference parts: build, B-rep, contract parity, joints, and form."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.builds, cls.checks = {}, {}
        for kernel in KERNELS:
            out = root / kernel
            code, report = run_json([sys.executable, str(SCRIPTS / "build_reference.py"), "--kernel", kernel,
                                     "--out", str(out)])
            cls.builds[kernel] = (code, report)
            cls.checks[kernel] = form_check(out, "F3")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_every_template_part_builds_in_both_kernels(self) -> None:
        for kernel in KERNELS:
            code, report = self.builds[kernel]
            with self.subTest(kernel=kernel):
                self.assertEqual((code, report["errors"]), (0, []))
                self.assertEqual(sorted(report["parts"]), TEMPLATE_PARTS)

    def test_step_products_are_named_pn_then_title(self) -> None:
        for kernel in KERNELS:
            for pn, row in self.checks[kernel][1]["parts"].items():
                with self.subTest(kernel=kernel, part=pn):
                    self.assertRegex(row["name"], rf"^{pn} \S")

    def test_brep_is_one_valid_solid_per_part(self) -> None:
        for kernel in KERNELS:
            for pn, row in self.checks[kernel][1]["parts"].items():
                with self.subTest(kernel=kernel, part=pn):
                    self.assertTrue(row["valid"])
                    self.assertTrue(row["kernel_valid"])
                    self.assertLessEqual(row["readback_rel_error"], 1e-6)
                    self.assertEqual(row["solids"], 1)

    def test_params_key_sets_are_equal_across_kernels(self) -> None:
        cq, bd = (self.builds[k][1]["parts"] for k in KERNELS)
        for pn in TEMPLATE_PARTS:
            with self.subTest(part=pn):
                self.assertEqual(cq[pn]["params_keys"], bd[pn]["params_keys"])

    def test_volumes_agree_within_half_a_percent(self) -> None:
        cq, bd = (self.checks[k][1]["parts"] for k in KERNELS)
        for pn in TEMPLATE_PARTS:
            with self.subTest(part=pn):
                a, b = cq[pn]["volume_mm3"], bd[pn]["volume_mm3"]
                self.assertGreater(a, 0.0)
                self.assertLessEqual(abs(a - b) / a, 0.005, f"cadquery {a} mm3 vs build123d {b} mm3")

    def test_joint_bores_sit_on_template_origins(self) -> None:
        for kernel in KERNELS:
            joints = self.checks[kernel][1]["joints"]
            self.assertEqual(sorted(joints), [f"J-{n:03d}" for n in range(1, 13)])
            for jid, row in joints.items():
                for pn, found in row["parts"].items():
                    with self.subTest(kernel=kernel, joint=jid, part=pn):
                        self.assertIsNotNone(found)
                        self.assertLessEqual(found["offset_mm"], 0.05)

    def test_no_reference_part_is_block_like_or_breaks_a_process_rule(self) -> None:
        for kernel in KERNELS:
            code, report = self.checks[kernel]
            with self.subTest(kernel=kernel):
                self.assertEqual((code, report["findings"]), (0, []))


@unittest.skipUnless(shutil.which("uv"), "uv is required to build the CAD shape fixtures")
class BlockShapeTests(unittest.TestCase):
    """Block-like detection distinguishes a solid placeholder from a planar skeleton."""

    def test_box_fails_and_open_frame_passes_without_blends(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            models = Path(tmp) / "models"
            models.mkdir()
            (models / "TST-0301.py").write_text(
                'import cadquery as cq\nKERNEL = "cadquery"\nPARAMS = {}\n\n'
                'def build(params):\n    return cq.Workplane().box(100, 100, 20)\n', encoding="utf-8")
            (models / "TST-0302.py").write_text(
                'import cadquery as cq\nKERNEL = "cadquery"\nPARAMS = {}\n\n'
                'def build(params):\n'
                '    outer = cq.Workplane().box(100, 100, 20)\n'
                '    inner = cq.Workplane().box(90, 90, 22)\n'
                '    return outer.cut(inner)\n', encoding="utf-8")
            (models / "TST-0303.py").write_text(
                'import cadquery as cq\nKERNEL = "cadquery"\nPARAMS = {}\n\n'
                'def build(params):\n    return cq.Workplane().cylinder(100, 10)\n', encoding="utf-8")
            out = Path(tmp) / "out"
            code, built = run_json([sys.executable, str(SCRIPTS / "build_reference.py"), "--kernel", "cadquery",
                                    "--models", str(models), "--out", str(out)])
            self.assertEqual((code, built["errors"]), (0, []))
            code, report = form_check(out, "F2")

        self.assertEqual(code, 1)
        by_part = {row["part"]: row for row in report["findings"] if row["check"] == "block_like"}
        self.assertEqual(sorted(by_part), ["TST-0301", "TST-0303"])
        box = report["parts"]["TST-0301"]
        frame = report["parts"]["TST-0302"]
        pin = report["parts"]["TST-0303"]
        self.assertGreaterEqual(box["axis_planar_fraction"], 0.80)
        self.assertGreaterEqual(box["obb_fill_fraction"], 0.20)
        self.assertEqual(box["blend_faces"] + box["freeform_faces"], 0)
        self.assertEqual(frame["axis_planar_fraction"], 1.0)
        self.assertLess(frame["obb_fill_fraction"], 0.20)
        self.assertGreaterEqual(frame["obb_thickness_fraction"], 0.10)
        self.assertEqual(frame["blend_faces"] + frame["freeform_faces"], 0)
        self.assertLess(pin["axis_planar_fraction"], 0.80)
        self.assertEqual(pin["blend_faces"] + pin["freeform_faces"], 0)
        self.assertIn("TST-0303", by_part)

    def test_non_solid_block_is_exempt_and_wall_override_applies(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw, parts_dir = build_parts(Path(tmp), box_part(1.1, "frame"))
            (hw / "product.yaml").write_text("id: fixture\nmanufacturing:\n  min_wall_mm: {fdm: 1.0}\n", encoding="utf-8")
            code, report = form_check(parts_dir, "F2", hw)
            self.assertEqual(code, 0, report["findings"])
            self.assertEqual(report["parts"]["TST-0301"]["form_class"], "frame")
            self.assertEqual(report["parts"]["TST-0301"]["min_wall"]["thickness_mm"], 1.1)
            (hw / "product.yaml").write_text("id: fixture\nmanufacturing:\n  min_wall_mm: {fdm: 1.15}\n", encoding="utf-8")
            code, report = form_check(parts_dir, "F2", hw)
            wall = next(f for f in report["findings"] if f["check"] == "min_wall")
            self.assertEqual((code, wall["part"], wall["min_mm"], wall["thickness_mm"]), (1, "TST-0301", 1.15, 1.1))
            self.assertEqual(len(wall["location_mm"]), 3)

    def test_solid_box_defaults_to_block_like_and_fdm_wall_minimum(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw, parts_dir = build_parts(Path(tmp), box_part(1.1))
            code, report = form_check(parts_dir, "F2", hw)
            block = next(f for f in report["findings"] if f["check"] == "block_like")
            wall = next(f for f in report["findings"] if f["check"] == "min_wall")
            self.assertEqual((code, block["part"], wall["min_mm"]), (1, "TST-0301", 1.2))
            self.assertLess(wall["thickness_mm"], wall["min_mm"])
            self.assertEqual(len(wall["location_mm"]), 3)


PLATE_08 = "cq.Workplane().box(10, 10, 0.8)"
BORED_BLOCK = "cq.Workplane().box(20, 20, 10).faces('>Z').workplane().center({}, {}).hole(10)"
FILLETED_SHELL = "cq.Workplane().box(30, 20, 15).edges('|Z or <Z').fillet(4).faces('>Z').shell(-{})"
# A Ø10 bore `web` mm from one side of a 20 mm block, toward +X (the bore's seam), -X, +Y and -Y. The web is
# thinnest at one spot and thickens away from it, by about s²/2r: 1.15 mm is under 1.2 mm only within ±0.64 mm.
WEBS = {f"TST-04{base + i:02d}": (web, direction) for web, base in ((0.8, 1), (1.1, 31), (1.15, 35))
        for i, direction in enumerate(((1, 0), (-1, 0), (0, 1), (0, -1)))}
WALL_PARTS = {
    **{pn: (FDM_MADE, BORED_BLOCK.format(round(dx * (5 - web), 6), round(dy * (5 - web), 6)))
       for pn, (web, (dx, dy)) in WEBS.items()},
    # A 0.8 mm rib 2.5 mm tall on a 3 mm plate.
    "TST-0405": (FDM_MADE, "cq.Workplane().box(20, 20, 3).faces('>Z').workplane().rect(15, 0.8).extrude(2.5)"),
    # A lug whose Ø6.4 bore leaves a 0.8 mm ring in its R4 end.
    "TST-0406": (FDM_MADE, "cq.Workplane().box(20, 8, 3).translate((10, 0, 0)).union(cq.Workplane().cylinder(3, 4))"
                           ".cut(cq.Workplane().cylinder(3, 3.2))"),
    # A 2 mm slot 4.2 mm deep in a 5 mm block: a 0.8 mm floor.
    "TST-0407": (FDM_MADE, "cq.Workplane().box(20, 10, 5).faces('>Z').workplane().rect(16, 2).cutBlind(-4.2)"),
    "TST-0408": (FDM_MADE + "form_class: shell\n", FILLETED_SHELL.format(0.8)),
    "TST-0409": (FDM_MADE + "form_class: shell\n", FILLETED_SHELL.format(1.6)),
    "TST-0410": (FDM_MADE + "form_class: plate\n", "cq.Workplane().box(10, 10, 1.2)"),
    # A 90-degree cone: every exit is 45 degrees off antiparallel, so no sample measures a wall.
    "TST-0411": (FDM_MADE, "cq.Workplane().add(cq.Solid.makeCone(5, 0, 5))"),
    "TST-0412": ("process: purchased\nmake_buy: buy\nform_class: plate\n", PLATE_08),
    "TST-0413": ("process: fdm\nmake_buy: buy\nform_class: plate\n", PLATE_08),
    "TST-0414": ("process: cnc\nmake_buy: make\nform_class: plate\n", PLATE_08),
    "TST-0415": (FDM_MADE + "form_class: plate\n",
                 "cq.Workplane().box(110, 110, 3).faces('>Z').workplane().rarray(10, 10, 10, 10).hole(4)"),
    # A prism with a 30-degree edge: its tip is a wedge, not a wall; the end caps are 10 mm apart.
    "TST-0416": (FDM_MADE, "cq.Workplane().polyline([(0, 0), (20, 0), (20, 11.547005)]).close().extrude(10)"),
    # Two 0.6 mm grooves leave a 1.0 mm land: relief on a 4 mm plate, not a wall.
    "TST-0417": (FDM_MADE, "cq.Workplane().box(20, 20, 4).faces('>Z').workplane()"
                           ".pushPoints([(-1.5, 0), (1.5, 0)]).rect(2, 12).cutBlind(-0.6)"),
    # A Ø4 screw boss with a Ø2 hole: a 1.0 mm wall curved tighter than the persistence step.
    "TST-0418": (FDM_MADE, "cq.Workplane().box(20, 20, 3).faces('>Z').workplane().circle(2).extrude(6)"
                           ".faces('>Z').workplane().hole(2, 6)"),
}
HUNDRED_HOLES_SECONDS = 15.0  # about 1 s on an M2; the per-ray reload it replaces took minutes at this density


@unittest.skipUnless(shutil.which("uv"), "uv is required to build the CAD shape fixtures")
class WallScanTests(unittest.TestCase):
    """The F2 minimum-wall scan finds thin features without flagging walls that are not thin."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        hw, parts_dir = build_parts(Path(cls.tmp.name), WALL_PARTS)
        cls.code, cls.report = form_check(parts_dir, "F2", hw)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def wall(self, pn: str) -> dict:
        return self.report["parts"][pn]["min_wall"]

    def wall_findings(self, pn: str) -> list[dict]:
        return [f for f in self.report["findings"] if f["part"] == pn and f["check"].startswith("min_wall")]

    def assert_thin(self, pn: str, thickness: float) -> list[float]:
        """One min_wall finding, at most 0.02 mm above the true thickness; returns its location."""
        findings = self.wall_findings(pn)
        self.assertEqual([f["check"] for f in findings], ["min_wall"], pn)
        self.assertGreaterEqual(findings[0]["thickness_mm"], thickness - 1e-6, pn)
        self.assertLess(findings[0]["thickness_mm"], thickness + 0.02, pn)
        self.assertEqual(findings[0]["min_mm"], 1.2)
        return findings[0]["location_mm"]

    def assert_passes(self, pn: str, thickness: float) -> None:
        self.assertEqual(self.wall_findings(pn), [], pn)
        self.assertAlmostEqual(self.wall(pn)["thickness_mm"], thickness, places=6, msg=pn)

    def test_bore_webs_are_found_whichever_way_the_seam_faces(self) -> None:
        for pn, (web, (dx, dy)) in WEBS.items():
            with self.subTest(part=pn, web=web):
                location = self.assert_thin(pn, web)
                self.assertLess(math.dist(location[:2], (dx * (10 - web / 2), dy * (10 - web / 2))), 1.0)

    def test_narrow_faces_of_rib_lug_ring_floor_and_boss_are_sampled(self) -> None:
        x, y, z = self.assert_thin("TST-0405", 0.8)
        self.assertTrue(abs(y) <= 0.4 + 1e-6 and 1.5 - 1e-6 <= z <= 4.0 + 1e-6, (x, y, z))
        x, y, _ = self.assert_thin("TST-0406", 0.8)
        self.assertTrue(3.2 - 1e-6 <= math.hypot(x, y) <= 4.0 + 1e-6, (x, y))
        x, y, _ = self.assert_thin("TST-0407", 0.8)
        self.assertTrue(abs(x) <= 8.0 and abs(y) <= 1.0, (x, y))
        x, y, _ = self.assert_thin("TST-0418", 1.0)
        self.assertTrue(1.0 - 1e-6 <= math.hypot(x, y) <= 2.0 + 1e-6, (x, y))

    def test_filleted_shell_flags_at_0_8_and_passes_at_1_6(self) -> None:
        self.assert_thin("TST-0408", 0.8)
        self.assert_passes("TST-0409", 1.6)

    def test_wall_at_exactly_the_minimum_passes(self) -> None:
        self.assert_passes("TST-0410", 1.2)
        self.assertEqual([f for f in self.report["findings"] if f["part"] == "TST-0410"], [])

    def test_acute_edge_wedge_and_relief_are_not_walls(self) -> None:
        wedge, relief = self.wall("TST-0416"), self.wall("TST-0417")
        self.assert_passes("TST-0416", 10.0)  # every tip chord is rejected, so the end caps set the minimum
        self.assertGreater(wedge["tapered"], 0)
        self.assert_passes("TST-0417", 3.4)  # the 1.0 mm land is 0.6 mm tall
        self.assertGreater(relief["shallow"], 0)
        self.assertAlmostEqual(relief["shallow_thickness_mm"], 1.0, places=6)
        self.assertTrue(1.4 - 1e-6 <= relief["shallow_location_mm"][2] <= 2.0 + 1e-6, relief["shallow_location_mm"])

    def test_part_without_a_measured_wall_is_a_finding(self) -> None:
        wall = self.wall("TST-0411")
        self.assertEqual((wall["thickness_mm"], wall["measured"], wall["faces_sampled"]), (None, 0, 2))
        self.assertGreater(wall["samples"], 0)
        self.assertEqual(wall["tapered"], wall["samples"])  # the coverage shows why: every exit is a taper
        self.assertEqual(self.wall_findings("TST-0411"), [{"check": "min_wall_unmeasured", "part": "TST-0411",
                                                            "min_mm": 1.2, "faces": 2, "faces_sampled": 2,
                                                            "samples": wall["samples"]}])

    def test_bought_parts_and_processes_without_a_minimum_are_not_scanned(self) -> None:
        for pn in ("TST-0412", "TST-0413", "TST-0414"):
            with self.subTest(part=pn):
                self.assertEqual(self.wall(pn), {"required_mm": None})
                self.assertEqual([f for f in self.report["findings"] if f["part"] == pn], [])

    def test_plate_with_100_holes_passes_within_its_time_budget(self) -> None:
        wall = self.wall("TST-0415")
        self.assert_passes("TST-0415", 3.0)
        self.assertEqual((wall["faces"], wall["faces_sampled"]), (106, 106))
        self.assertLess(wall["seconds"], HUNDRED_HOLES_SECONDS)

    def test_every_scan_reports_its_coverage(self) -> None:
        for pn, row in self.report["parts"].items():
            wall = row["min_wall"]
            if wall["required_mm"] is None:
                continue
            with self.subTest(part=pn):
                self.assertEqual(wall["spacing_mm"], 0.6)
                self.assertTrue(0 < wall["faces_sampled"] <= wall["faces"], wall)
                self.assertTrue(0 <= wall["measured"] + wall["shallow"] + wall["tapered"] <= wall["samples"], wall)
                self.assertEqual(wall["shallow_thickness_mm"] is None, wall["shallow"] == 0, wall)
                self.assertEqual(wall["shallow_location_mm"] is None, wall["shallow"] == 0, wall)
                self.assertGreaterEqual(wall["seconds"], 0.0)


@unittest.skipUnless(shutil.which("uv"), "uv is required to build the CAD shape fixtures")
class WallOverrideTests(unittest.TestCase):
    """product.yaml manufacturing.min_wall_mm gives a process a minimum, and an invalid one stops the check."""

    def test_cnc_override_sets_a_minimum_and_an_invalid_override_is_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            hw, parts_dir = build_parts(Path(tmp), {"TST-0421": ("process: cnc\nmake_buy: make\nform_class: plate\n",
                                                                 PLATE_08)})
            product = hw / "product.yaml"
            product.write_text("id: fixture\nmanufacturing:\n  min_wall_mm: {cnc: 1.0}\n", encoding="utf-8")
            code, report = form_check(parts_dir, "F2", hw)
            self.assertEqual((code, [(f["check"], f["thickness_mm"], f["min_mm"]) for f in report["findings"]]),
                             (1, [("min_wall", 0.8, 1.0)]))
            product.write_text("id: fixture\nmanufacturing:\n  min_wall_mm: {cnc: 0.5}\n", encoding="utf-8")
            code, report = form_check(parts_dir, "F2", hw)
            wall = report["parts"]["TST-0421"]["min_wall"]
            self.assertEqual((code, report["findings"], wall["required_mm"], wall["thickness_mm"]), (0, [], 0.5, 0.8))
            product.write_text("id: fixture\nmanufacturing:\n  min_wall_mm: {cnc: 0}\n", encoding="utf-8")
            code, report = form_check(parts_dir, "F2", hw)
            self.assertEqual((code, report["status"]), (2, "error"))
            self.assertIn("manufacturing.min_wall_mm.cnc", report["error"])


@unittest.skipUnless(importlib.util.find_spec("yaml"), "pyyaml is required to read product.yaml")
class WallThresholdTests(unittest.TestCase):
    """Valid min_wall_mm overrides apply; anything else the product schema rejects is a RecordError."""

    def thresholds(self, product: str) -> dict[str, float]:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "product.yaml").write_text(product, encoding="utf-8")
            return FORM_CHECK.minimum_wall_thresholds(Path(tmp))

    def test_defaults_and_valid_overrides(self) -> None:
        self.assertEqual(self.thresholds("id: fixture\n"), {"fdm": 1.2})
        self.assertEqual(self.thresholds("id: fixture\nmanufacturing:\n  processes: [fdm]\n"), {"fdm": 1.2})
        self.assertEqual(self.thresholds("id: fixture\nmanufacturing:\n  min_wall_mm: {fdm: 1, cnc: 0.8}\n"),
                         {"fdm": 1.0, "cnc": 0.8})

    def test_invalid_overrides_are_rejected(self) -> None:
        for value in ("{fdm: 0}", "{fdm: -1.2}", "{fdm: '1.2'}", "{fdm: true}", "{fdm: .nan}", "{cnc: .inf}",
                      "{cnc: null}", "{purchased: 1.0}", "{FDM: 1.2}", "{}", "1.2", "[1.2]", "null"):
            with self.subTest(min_wall_mm=value), self.assertRaisesRegex(FORM_CHECK.RecordError, "min_wall_mm"):
                self.thresholds(f"id: fixture\nmanufacturing:\n  min_wall_mm: {value}\n")

    def test_overridable_processes_are_the_product_schema_keys(self) -> None:
        schema = json.loads((SKILL.parent / "cad-record" / "schemas" / "product.schema.json").read_text(encoding="utf-8"))
        keys = schema["properties"]["manufacturing"]["properties"]["min_wall_mm"]["properties"]
        self.assertEqual(sorted(FORM_CHECK.MIN_WALL_PROCESSES), sorted(keys))


@unittest.skipUnless(shutil.which("uv"), "uv is required to build the cad-motion block fixtures")
class BlockDetectorTests(unittest.TestCase):
    """The cad-motion stand-in lamp is boxes and cylinders: every made part must be flagged."""

    @classmethod
    def setUpClass(cls) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            built = subprocess.run(["uv", "run", "--script", str(FIXTURES), tmp], capture_output=True, text=True)
            if built.returncode != 0:
                raise AssertionError(f"build_fixtures.py exited {built.returncode}:\n{built.stderr[-2000:]}")
            cls.f2 = form_check(Path(tmp) / "lamp", "F2")
            cls.f1 = form_check(Path(tmp) / "lamp", "F1")

    def test_fixture_blocks_are_flagged_and_their_joints_still_pass(self) -> None:
        code, report = self.f2
        self.assertEqual(code, 1)
        flagged = sorted(f["part"] for f in report["findings"] if f["check"] == "block_like")
        self.assertEqual(flagged, MADE_PARTS)
        self.assertEqual([f for f in report["findings"] if f["check"] != "block_like"], [])

    def test_f1_does_not_judge_form(self) -> None:
        self.assertEqual((self.f1[0], self.f1[1]["findings"]), (0, []))


@unittest.skipUnless(shutil.which("uv"), "uv is required to build the kernel environments")
class KernelDefectTests(unittest.TestCase):
    """Defects only the in-memory shape shows: the STEP read-back alone passes both parts."""

    def test_kernel_invalid_face_and_loose_fillets_are_findings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            code, report = run_json([sys.executable, str(SCRIPTS / "build_reference.py"), "--kernel", "cadquery",
                                     "--models", str(DEFECTS / "cadquery"), "--out", str(out)])
            self.assertEqual((code, report["errors"]), (0, []))
            code, report = form_check(out, "F0")
        self.assertEqual(code, 1)
        self.assertTrue(all(row["valid"] for row in report["parts"].values()), report["parts"])
        found = sorted((f["check"], f["part"], f.get("source")) for f in report["findings"])
        self.assertEqual(found, [("brep_invalid", "TST-0101", "kernel"), ("step_readback", "TST-0101", None),
                                 ("step_readback", "TST-0102", None)])


PARITY_MODELS = {
    "cadquery": {
        "TST-0201": 'import cadquery as cq\nKERNEL = "cadquery"\nPARAMS = {"size": float("nan")}\n\n\n'
                    'def build(params):\n    return cq.Workplane().box(10, 10, 10)\n',
        "TST-0202": 'import cadquery as cq\nKERNEL = "cadquery"\nPARAMS = {"size": 10.0}\n\n\n'
                    'def build(params):\n    s = params["size"]\n'
                    '    return cq.Workplane().pushPoints([(0, 0), (2 * s, 0)]).box(s, s, s, combine=False)\n',
    },
    "build123d": {
        "TST-0203": 'import bd_warehouse  # noqa: F401 - in the build123d runner environment\n'
                    'from build123d import Box\nKERNEL = "build123d"\nPARAMS = {"size": 10.0}\n\n\n'
                    'def build(params):\n    return Box(params["size"], params["size"], params["size"])\n',
    },
}


@unittest.skipUnless(shutil.which("uv"), "uv is required to build the kernel environments")
class RunnerParityTests(unittest.TestCase):
    """build_reference builds through cad-model's runners: same environment, same model.py contract."""

    def build(self, kernel: str, tmp: str) -> tuple[int, dict]:
        models = Path(tmp) / "models"
        models.mkdir()
        for pn, source in PARITY_MODELS[kernel].items():
            (models / f"{pn}.py").write_text(source, encoding="utf-8")
        return run_json([sys.executable, str(SCRIPTS / "build_reference.py"), "--kernel", kernel,
                         "--models", str(models), "--out", str(Path(tmp) / "out")])

    def test_cadquery_rejects_nan_params_and_keeps_every_workplane_object(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code, report = self.build("cadquery", tmp)
        self.assertEqual(code, 1)
        self.assertEqual([e.split(":")[:2] for e in report["errors"]], [["TST-0201", " ContractError"]])
        self.assertAlmostEqual(report["parts"]["TST-0202"]["kernel_volume_mm3"], 2000.0, places=6)

    def test_build123d_models_can_use_bd_warehouse(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code, report = self.build("build123d", tmp)
        self.assertEqual((code, report["errors"], sorted(report["parts"])), (0, [], ["TST-0203"]))


if __name__ == "__main__":
    unittest.main()
