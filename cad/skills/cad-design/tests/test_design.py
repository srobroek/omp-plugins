#!/usr/bin/env python3
"""cad-design tests: reference lamp-arm models in both kernels, and the block-like detector.

Run: python3 -m unittest discover -s cad/skills/cad-design/tests -v
Needs `uv`; the first run creates the CadQuery and build123d environments, and a cold
OCP import can take minutes, so the builds have no short timeout.
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import os
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

MADE_PARTS = ["LMP-0001", "LMP-0002", "LMP-0003", "LMP-0004"]


def run_json(command: list[str]) -> tuple[int, dict]:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        return result.returncode, json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(f"{command[:4]} printed no JSON (exit {result.returncode}):\n{result.stderr[-3000:]}") from error


def form_check(parts_dir: Path, fidelity: str) -> tuple[int, dict]:
    return run_json(["uv", "run", "--script", str(SCRIPTS / "form_check.py"), "--hw", str(TEMPLATE_HW),
                     "--parts-dir", str(parts_dir), "--fidelity", fidelity])


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
