#!/usr/bin/env python3
"""cad-motion tests: pure kinematics and frame checks, then STEP runs through OCP and FreeCAD.

Run: python3 -m unittest discover -s cad/skills/cad-motion/tests -v
The STEP tests need `uv`; the FreeCAD test also needs freecadcmd and skips without it.
"""

from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
BUILDER = HERE / "fixtures" / "build_fixtures.py"
TEMPLATE_HW = HERE.parents[1] / "cad-record" / "assets" / "project-template" / "hw"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pose = load("cad_motion_pose", SCRIPTS / "pose.py")
freecad_assembly = load("cad_motion_freecad", SCRIPTS / "freecad_assembly.py")


def joint(jid: str, kind: str, parent: str, child: str, axis, origin, low: float, high: float, nominal: float = 0.0):
    return pose.make_joint({"id": jid, "type": kind, "parent": parent, "child": child, "axis": list(axis),
                            "origin": list(origin), "min": low, "max": high, "nominal": nominal})


def planar_chain(j2_max: float = 180.0):
    return pose.build_chain([
        joint("J-001", "revolute", "TST-0001", "TST-0002", (0, 0, 1), (100, 0, 0), -90, 90),
        joint("J-002", "revolute", "TST-0002", "TST-0003", (0, 0, 1), (200, 0, 0), 0, j2_max),
    ])


def assert_close(case: unittest.TestCase, actual, expected, places: int = 9) -> None:
    for a, e in zip(actual, expected):
        case.assertAlmostEqual(a, e, places=places)


class KinematicsTests(unittest.TestCase):
    """Chain transforms and limits against hand-computed poses; needs no OCP."""

    def test_revolute_rotates_about_its_axis_through_its_origin(self) -> None:
        moved = pose.Rigid.rotation((0.0, 0.0, 1.0), 90.0, (100.0, 0.0, 0.0)).apply((200.0, 0.0, 0.0))
        assert_close(self, moved, (100.0, 100.0, 0.0))

    def test_chain_composes_parent_then_child(self) -> None:
        transforms = planar_chain().transforms({"J-001": 90.0, "J-002": 90.0})
        # J-001 swings TST-0002 to +Y, putting the J-002 pivot at (100, 100); J-002 turns TST-0003 to -X.
        assert_close(self, transforms["TST-0003"].apply((200.0, 0.0, 0.0)), (100.0, 100.0, 0.0))
        assert_close(self, transforms["TST-0003"].apply((350.0, 0.0, 0.0)), (-50.0, 100.0, 0.0))

    def test_prismatic_translates_along_its_axis(self) -> None:
        chain = pose.build_chain([joint("J-001", "prismatic", "TST-0001", "TST-0002", (2, 0, 0), (0, 0, 0), 0, 50)])
        assert_close(self, chain.transforms({"J-001": 30.0})["TST-0002"].apply((1.0, 2.0, 3.0)), (31.0, 2.0, 3.0))

    def test_out_of_range_value_is_a_structured_finding(self) -> None:
        chain = planar_chain(j2_max=90.0)
        findings = chain.limit_findings(chain.complete({"J-002": 120.0}))
        self.assertEqual(len(findings), 1)
        self.assertEqual({k: findings[0][k] for k in ("check", "joint", "value", "min", "max", "unit")},
                         {"check": "joint_limit", "joint": "J-002", "value": 120.0, "min": 0.0, "max": 90.0, "unit": "deg"})

    def test_unknown_joint_value_is_a_usage_error(self) -> None:
        with self.assertRaises(pose.MotionError):
            planar_chain().complete({"J-009": 1.0})

    def test_unconnected_part_is_rejected(self) -> None:
        with self.assertRaisesRegex(pose.MotionError, "TST-0009"):
            pose.build_chain(planar_chain().joints, ["TST-0009"])

    def test_measure_recovers_the_joint_value(self) -> None:
        elbow = planar_chain().joint("J-002")
        value, residual_deg, residual_mm = elbow.measure(elbow.motion(137.5))
        self.assertAlmostEqual(value, 137.5, places=9)
        self.assertAlmostEqual(residual_deg, 0.0, places=5)
        self.assertAlmostEqual(residual_mm, 0.0, places=9)

    def test_quaternion_round_trip(self) -> None:
        rigid = pose.Rigid.rotation((0.6, 0.0, 0.8), -160.0, (5.0, -3.0, 2.0))
        back = pose.Rigid.from_quaternion(rigid.quaternion(), rigid.trans)
        for row, expected in zip(back.rows(9), rigid.rows(9)):
            assert_close(self, row, expected)


class FrameCheckTests(unittest.TestCase):
    """freecad_assembly's own limit check on synthetic placements; needs no FreeCAD."""

    @staticmethod
    def frame(chain, values):
        return {pn: [list(t.trans), list(t.quaternion())] for pn, t in chain.transforms(values).items()}

    def test_a_frame_beyond_the_limit_is_a_violation(self) -> None:
        chain = planar_chain(j2_max=90.0)
        frames = [self.frame(chain, {"J-001": 0.0, "J-002": 45.0}), self.frame(chain, {"J-001": 10.0, "J-002": 135.0})]
        checks = freecad_assembly.check_frames(chain, frames)
        self.assertEqual([(v["frame"], v["joint"]) for v in checks["violations"]], [(1, "J-002")])
        self.assertAlmostEqual(checks["violations"][0]["value"], 135.0, places=6)
        self.assertEqual(checks["residuals"], [])

    def test_a_frame_off_the_joint_freedom_is_a_residual(self) -> None:
        chain = planar_chain()
        frame = self.frame(chain, {"J-001": 0.0, "J-002": 0.0})
        frame["TST-0003"][0] = [0.0, 0.0, 2.0]  # child lifted 2 mm along the revolute axis
        checks = freecad_assembly.check_frames(chain, [frame])
        self.assertEqual([r["joint"] for r in checks["residuals"]], ["J-002"])

    def test_a_movable_joint_that_never_reaches_its_range_fails(self) -> None:
        chain = pose.build_chain([joint("J-001", "revolute", "TST-0001", "TST-0002", (0, 0, 1), (100, 0, 0), 0, 90)])
        checks = freecad_assembly.check_frames(chain, [self.frame(chain, {"J-001": 0.0})])
        self.assertEqual(checks["violations"], [])
        self.assertEqual(len(checks["range_findings"]), 1)
        self.assertEqual(checks["range_findings"][0]["reason"], "observed_range_incomplete")
        self.assertEqual(checks["range_findings"][0]["observed_min"], 0.0)
        self.assertEqual(checks["range_findings"][0]["observed_max"], 0.0)


PLANAR_YAML = """subassemblies:
  - {{id: planar, title: Planar test arm, parts: [TST-0001, TST-0002, TST-0003]}}
joints:
  - {{id: J-001, type: revolute, parent: TST-0001, child: TST-0002, axis: [0, 0, 1], origin: [100, 0, 0], min: -90, max: 90, nominal: 0}}
  - {{id: J-002, type: revolute, parent: TST-0002, child: TST-0003, axis: [0, 0, 1], origin: [200, 0, 0], min: 0, max: {j2_max}, nominal: 0}}
"""


@unittest.skipUnless(shutil.which("uv"), "uv is required to build and read STEP through OCP")
class StepTests(unittest.TestCase):
    """Builds fixture STEPs with OCP, then runs the scripts as the skill does."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(BUILDER), str(cls.root / "fx")],
                              capture_output=True, text=True, check=False, timeout=900)
        if proc.returncode != 0:
            raise RuntimeError(f"fixture build failed: {proc.stderr[-2000:]}")
        cls.planar = cls.root / "fx" / "planar"
        cls.lamp = cls.root / "fx" / "lamp"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def hw(self, j2_max: float) -> Path:
        folder = Path(tempfile.mkdtemp(dir=self.root))
        (folder / "assembly.yaml").write_text(PLANAR_YAML.format(j2_max=j2_max), encoding="utf-8")
        return folder

    def run_script(self, script: str, *args: str) -> tuple[subprocess.CompletedProcess[str], dict]:
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(SCRIPTS / script), *args],
                              capture_output=True, text=True, check=False, timeout=900)
        return proc, json.loads(proc.stdout) if proc.stdout.strip() else {}

    def test_out_of_range_value_exits_1_without_a_step(self) -> None:
        out = self.root / "rejected.step"
        proc, result = self.run_script("pose.py", "--hw", str(self.hw(90)), "--parts-dir", str(self.planar),
                                       "--set", "J-002=120", "--out", str(out))
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual(result["status"], "fail")
        self.assertEqual([(f["check"], f["joint"]) for f in result["findings"]], [("joint_limit", "J-002")])
        self.assertFalse(out.exists())

    def test_posed_step_is_ap242_with_names_and_the_pose(self) -> None:
        out = self.root / "posed.step"
        proc, result = self.run_script("pose.py", "--hw", str(self.hw(180)), "--parts-dir", str(self.planar),
                                       "--set", "J-002=90", "--out", str(out))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        text = out.read_text(encoding="utf-8")
        self.assertIn("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING", text[:2000])
        for name in ("TST-0001 Ground link", "TST-0002 Middle link", "TST-0003 Tip link"):
            self.assertIn(f"PRODUCT('{name}'", text)
        # 90 degrees about Z through (200, 0, 0): x' = 200 - y, y' = x - 200.
        self.assertEqual(result["placements"]["TST-0003"], [[0.0, -1.0, 0.0, 200.0], [1.0, 0.0, 0.0, -200.0], [0.0, 0.0, 1.0, 0.0]])

    def test_overlapping_links_are_a_collision(self) -> None:
        proc, result = self.run_script("sweep.py", "--hw", str(self.hw(180)), "--parts-dir", str(self.planar),
                                       "--steps", "5", "--grid", "0", "--worst-step", str(self.root / "w1.step"))
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual(result["status"], "fail")
        folded = [c for c in result["collisions"] if c["pose"] == {"J-001": 0.0, "J-002": 180.0}]
        self.assertEqual(len(folded), 1, result["collisions"])
        hit = folded[0]["pairs"][0]
        self.assertEqual(hit["pair"], ["TST-0001", "TST-0003"])
        self.assertAlmostEqual(hit["volume_mm3"], 5000.0, places=1)  # x 50..100 x 10 x 10 overlap
        self.assertEqual(result["pairs"]["checked"], [["TST-0001", "TST-0003"]])

    def test_clear_range_has_positive_clearance_and_no_collision(self) -> None:
        worst = self.root / "w2.step"
        proc, result = self.run_script("sweep.py", "--hw", str(self.hw(90)), "--parts-dir", str(self.planar),
                                       "--steps", "5", "--grid", "3", "--worst-step", str(worst))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual((result["status"], result["collisions"]), ("pass", []))
        self.assertTrue(all(item["clearance_mm"] > 0 for item in result["min_clearance"]), result["min_clearance"])
        self.assertEqual(result["reach_envelope"]["part"], "TST-0003")
        self.assertEqual(result["worst_case"]["criterion"], "max_horizontal_reach")
        self.assertIn("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING", worst.read_text(encoding="utf-8")[:2000])

    def test_assembly_step_input_poses_the_lamp_arm(self) -> None:
        out = self.root / "lamp-posed.step"
        proc, result = self.run_script("pose.py", "--hw", str(TEMPLATE_HW), "--step", str(self.lamp / "lamp-arm.step"),
                                       "--set", "J-002=-90", "--out", str(out))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(sorted(result["placements"]), [f"LMP-000{n}" for n in range(1, 8)])
        self.assertIn("PRODUCT('LMP-0003 Upper link'", out.read_text(encoding="utf-8"))

    @unittest.skipUnless(freecad_assembly.find_freecad(None), "freecadcmd not found")
    def test_freecad_simulation_moves_within_limits(self) -> None:
        proc, result = self.run_script("freecad_assembly.py", "--hw", str(self.hw(90)), "--parts-dir", str(self.planar))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertGreater(result["frames"], 1)
        self.assertTrue(result["placements_change"])
        tip = result["placements"]["TST-0003"]
        self.assertNotEqual(tip["start"], tip["end"])
        self.assertEqual(result["violations"], [])
        self.assertTrue(math.isclose(result["limit_check"]["J-002"]["observed_max"], 90.0, abs_tol=1e-3))


if __name__ == "__main__":
    unittest.main()
