#!/usr/bin/env python3
"""cad-motion tests: pure kinematics and frame checks, then STEP runs through OCP and FreeCAD.

Run: python3 -m unittest discover -s cad/skills/cad-motion/tests -v
The STEP tests need `uv`; the FreeCAD test also needs freecadcmd and skips without it.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
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
sys.path.insert(0, str(HERE / "fixtures"))
import v6_record  # noqa: E402 - the kernel-free V6-like record


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pose = load("cad_motion_pose", SCRIPTS / "pose.py")
freecad_assembly = load("cad_motion_freecad", SCRIPTS / "freecad_assembly.py")
sweep = load("cad_motion_sweep", SCRIPTS / "sweep.py")


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


def rigid(rows: list[list[float]]):
    """A pose.Rigid from 3x4 [rot | trans] rows."""
    return pose.Rigid(tuple(tuple(row[:3]) for row in rows), tuple(row[3] for row in rows))


def misphased_depth(q: float) -> float:
    """How far v6_record.record(misphased=3) dips valve 3's head into piston 3's crown at crank angle q, mm
    (> 0 overlaps). Worked from the geometry, not from coupling.py: the wrist sits on the bore where
    |wrist - crankpin| = L; the lift is the LIFT table, interpolated by hand, at cam angle q / 2 plus the
    TDC-peaking phase 65 - 240 / 2 = -55."""
    r, rod = v6_record.R, v6_record.L
    theta = math.radians(q + 120.0)
    wrist = r * math.cos(theta) + math.sqrt(rod * rod - (r * math.sin(theta)) ** 2)
    x = (q / 2.0 - 55.0) % 360.0
    lift = next(y0 + (y1 - y0) * (x - x0) / (x1 - x0)
                for (x0, y0), (x1, y1) in zip(v6_record.LIFT, v6_record.LIFT[1:]) if x0 <= x <= x1)
    return lift + (wrist - (rod + r)) - v6_record.VALVE_GAP


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


class ClearanceTests(unittest.TestCase):
    """sweep's clearance verdict on given distances; needs no OCP."""

    def test_a_clearance_just_below_the_requirement_fails_though_it_rounds_up(self) -> None:
        measured = {("TST-0001", "TST-0003"): {"pair": ["TST-0001", "TST-0003"], "clearance_mm": 0.49996,
                                               "pose": {"J-001": 0.0}}}
        rows, findings = sweep.clearance_report(measured, 0.5)
        self.assertEqual(rows[0]["clearance_mm"], 0.5)
        self.assertEqual([f["pair"] for f in findings], [["TST-0001", "TST-0003"]])


class ConsoleRedirectTests(unittest.TestCase):
    """stdout_to_stderr keeps console output written through C stdio, as OCCT writes it, off the JSON stdout."""

    @unittest.skipUnless(os.name == "posix", "the probe reaches C stdio through the POSIX libc")
    def test_c_stdio_output_inside_the_redirect_reaches_stderr_not_a_piped_stdout(self) -> None:
        # A pipe makes C stdout fully buffered: left in the buffer, the noise reaches stdout at exit, after the JSON.
        probe = ("import ctypes, importlib.util, json, sys\n"
                 f"spec = importlib.util.spec_from_file_location('pose', {str(SCRIPTS / 'pose.py')!r})\n"
                 "pose = sys.modules['pose'] = importlib.util.module_from_spec(spec)\n"
                 "spec.loader.exec_module(pose)\n"
                 "with pose.stdout_to_stderr():\n"
                 "    ctypes.CDLL(None).puts(b'****** Statistics on Transfer (Write) ******')\n"
                 "print(json.dumps({'status': 'pass'}))\n")
        proc = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout, '{"status": "pass"}\n')
        self.assertIn("Statistics on Transfer (Write)", proc.stderr)


PLANAR_YAML = """subassemblies:
  - {{id: planar, title: Planar test arm, parts: [TST-0001, TST-0002, TST-0003]}}
joints:
  - {{id: J-001, type: revolute, parent: TST-0001, child: TST-0002, axis: [0, 0, 1], origin: [100, 0, 0], min: -90, max: 90, nominal: 0}}
  - {{id: J-002, type: revolute, parent: TST-0002, child: TST-0003, axis: [0, 0, 1], origin: [200, 0, 0], min: 0, max: {j2_max}, nominal: 0}}
"""
# Two occurrences of the part-local arm TST-0202 on the ground plate, each on its own revolute joint.
TWINS_YAML = """occurrences:
  - {id: arm-a, PN: TST-0202}
  - {id: arm-b, PN: TST-0202, placement: {translation_mm: [0, 30, 0]}}
subassemblies:
  - {id: twins, title: Twin arms, parts: [TST-0201], occurrences: ["@arm-a", "@arm-b"]}
joints:
  - {id: J-001, type: revolute, parent: TST-0201, child: "@arm-a", axis: [0, 0, 1], origin: [0, 0, 0], min: 0, max: 90, nominal: 0}
  - {id: J-002, type: revolute, parent: TST-0201, child: "@arm-b", axis: [0, 0, 1], origin: [0, 30, 0], min: -10, max: 10, nominal: 0}
"""
# One asymmetric arm placed by a rotation and a translation, fixed to the plate.
PLACED_YAML = """occurrences:
  - {id: arm-p, PN: TST-0202, placement: {translation_mm: [40, 10, 0], rotation: {axis: [0, 0, 2], angle_deg: 90}}}
subassemblies:
  - {id: placed, title: Placed arm, parts: [TST-0201], occurrences: ["@arm-p"]}
joints:
  - {id: J-001, type: fixed, parent: TST-0201, child: "@arm-p", axis: [0, 0, 1], origin: [0, 0, 0], min: 0, max: 0, nominal: 0}
"""


class OccurrenceKinematicsTests(unittest.TestCase):
    """T_i = D_i P_i on occurrences; needs no OCP. Expected values are hand-computed."""

    def chain(self, settings: dict[str, float] | None = None):
        data = pose.assembly_data
        inventory = data.normalize(__import__("yaml").safe_load(TWINS_YAML), {"TST-0202": "part_local"})
        assembly = pose.Assembly(inventory, (), {})
        joints = [pose.make_joint(raw, assembly.attachable) for raw in __import__("yaml").safe_load(TWINS_YAML)["joints"]]
        chain = pose.build_chain(joints, inventory.occurrences)
        return chain, chain.transforms(chain.complete(settings or {}))

    def test_moving_one_sibling_does_not_move_the_other(self) -> None:
        chain, transforms = self.chain({"J-001": 90.0})
        assert_close(self, transforms["arm-a"].apply((50.0, 0.0, 0.0)), (0.0, 50.0, 0.0))
        assert_close(self, transforms["arm-b"].apply((50.0, 0.0, 0.0)), (50.0, 30.0, 0.0))
        self.assertEqual(chain.ids, ("TST-0201", "arm-a", "arm-b"))

    def test_the_rest_placement_is_applied_once_after_the_motion(self) -> None:
        """J-002 turns arm-b about its own origin (0, 30): D P, not P D and not P D P."""
        _, transforms = self.chain({"J-002": 10.0})
        expected = (30.0 * 0.0 + 50.0 * math.cos(math.radians(10)), 30.0 + 50.0 * math.sin(math.radians(10)), 0.0)
        assert_close(self, transforms["arm-b"].apply((50.0, 0.0, 0.0)), expected)

    def test_a_bare_pn_placed_twice_is_ambiguous_and_at_id_resolves(self) -> None:
        chain, _ = self.chain()
        with self.assertRaisesRegex(pose.MotionError, "ambiguous.*@arm-a, @arm-b"):
            chain.resolve("TST-0202")
        self.assertEqual((chain.resolve("@arm-b"), chain.resolve("TST-0201")), ("arm-b", "TST-0201"))

    def test_a_repeated_assembly_zero_part_is_refused(self) -> None:
        with self.assertRaisesRegex(pose.assembly_data.InventoryError, "placed 2 times.*assembly_zero"):
            pose.assembly_data.normalize(__import__("yaml").safe_load(TWINS_YAML), {})

    def test_freecad_connector_frames_strip_the_rest_placement(self) -> None:
        chain, _ = self.chain()
        frames = [{oid: [list(t.trans), list(t.quaternion())] for oid, t in chain.transforms({"J-001": v, "J-002": 0.0}).items()}
                  for v in (0.0, 45.0, 90.0)]
        checks = freecad_assembly.check_frames(chain, frames)
        self.assertEqual(checks["residuals"], [])
        self.assertAlmostEqual(checks["joints"]["J-001"]["observed_max"], 90.0, places=6)
        self.assertAlmostEqual(checks["joints"]["J-002"]["observed_max"], 0.0, places=6)



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
        cls.v6 = cls.root / "fx" / "v6"

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
        self.assertEqual(sorted(result["placements"]),
                         [f"LMP-{n:04d}" for n in range(1, 11)] + ["ring-base", "ring-elbow", "ring-head"])
        self.assertEqual({oid: pn for oid, pn in result["occurrences"].items() if pn == "LMP-0011"},
                         {"ring-base": "LMP-0011", "ring-elbow": "LMP-0011", "ring-head": "LMP-0011"})
        text = out.read_text(encoding="utf-8")
        self.assertIn("PRODUCT('LMP-0003 Upper link'", text)
        self.assertEqual(text.count("PRODUCT('LMP-0011 Retaining ring DIN 471 - 5x0.6'"), 1)  # one definition
        probe = self.probe(out)
        rings = sorted(c["occurrence"] for c in probe["components"] if c["pn"] == "LMP-0011")
        self.assertEqual(rings, ["ring-base", "ring-elbow", "ring-head"])
        boxes = {c["occurrence"]: c["bbox"] for c in probe["components"] if c["occurrence"]}
        # The elbow ring stays on the lower link's pin, outside the -Y cheek: y -11.605..-11.005.
        assert_close(self, boxes["ring-elbow"][0], (156.8, -11.605, 36.8), places=3)
        assert_close(self, boxes["ring-elbow"][1], (163.2, -11.005, 43.2), places=3)
        # The head ring rides the upper link, turned -90 deg about Y through (160, 0, 40): its rest
        # centre (360, -8.805, 40) moves to (160, -8.805, 240).
        assert_close(self, boxes["ring-head"][0], (156.8, -9.105, 236.8), places=3)
        assert_close(self, boxes["ring-head"][1], (163.2, -8.505, 243.2), places=3)

    def probe(self, step: Path) -> dict:
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(HERE / "fixtures" / "probe_step.py"), str(step)],
                              capture_output=True, text=True, check=False, timeout=900)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        return json.loads(proc.stdout)

    def twins(self, assembly: str) -> Path:
        """A record over the twins fixture: TST-0201 assembly_zero, TST-0202 part_local."""
        hw = Path(tempfile.mkdtemp(dir=self.root))
        (hw / "assembly.yaml").write_text(assembly, encoding="utf-8")
        for pn, title, frame in (("TST-0201", "Ground plate", None), ("TST-0202", "Arm", "part_local")):
            (hw / "parts" / pn).mkdir(parents=True)
            (hw / "parts" / pn / "part.yaml").write_text(
                f"PN: {pn}\ntitle: {title}\n" + (f"model_frame: {frame}\n" if frame else ""), encoding="utf-8")
        return hw

    def test_an_asymmetric_part_local_occurrence_is_placed_once_rotation_first(self) -> None:
        hw = self.twins(PLACED_YAML)
        out = self.root / "placed.step"
        proc, result = self.run_script("pose.py", "--hw", str(hw), "--parts-dir", str(self.root / "fx" / "twins"),
                                       "--out", str(out))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        # 90 deg about Z, then (40, 10, 0): x' = 40 - y, y' = 10 + x.
        self.assertEqual(result["placements"]["arm-p"], [[0.0, -1.0, 0.0, 40.0], [1.0, 0.0, 0.0, 10.0], [0.0, 0.0, 1.0, 0.0]])
        arm = next(c for c in self.probe(out)["components"] if c["occurrence"] == "arm-p")
        self.assertEqual(arm["name"], "TST-0202 Arm [@arm-p]")
        # Box x 0..50, y -5..5 and tab x 0..5, y 5..10, rotated then moved: x 30..45, y 10..60.
        assert_close(self, arm["bbox"][0], (30.0, 10.0, 0.0), places=5)
        assert_close(self, arm["bbox"][1], (45.0, 60.0, 5.0), places=5)

    def test_moving_one_sibling_leaves_the_other_at_its_rest_placement(self) -> None:
        hw = self.twins(TWINS_YAML)
        out = self.root / "twins.step"
        proc, result = self.run_script("pose.py", "--hw", str(hw), "--parts-dir", str(self.root / "fx" / "twins"),
                                       "--set", "J-001=90", "--out", str(out))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(result["placements"]["arm-a"], [[0.0, -1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]])
        self.assertEqual(result["placements"]["arm-b"], [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 30.0], [0.0, 0.0, 1.0, 0.0]])
        boxes = {c["occurrence"]: c["bbox"] for c in self.probe(out)["components"] if c["occurrence"]}
        assert_close(self, boxes["arm-a"][0], (-10.0, 0.0, 0.0), places=5)
        assert_close(self, boxes["arm-b"][0], (0.0, 25.0, 0.0), places=5)
        assert_close(self, boxes["arm-b"][1], (50.0, 40.0, 5.0), places=5)

    def test_two_occurrences_of_one_part_collide_in_a_sweep(self) -> None:
        hw = self.twins(TWINS_YAML)
        proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.root / "fx" / "twins"),
                                       "--steps", "2", "--grid", "0", "--end-effector", "@arm-a",
                                       "--worst-step", str(self.root / "w-twins.step"))
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual(result["pairs"]["checked"], [["@arm-a", "@arm-b"]])
        self.assertEqual([c["pose"] for c in result["collisions"]], [{"J-001": 90.0, "J-002": 0.0}])
        hit = result["collisions"][0]["pairs"][0]
        self.assertEqual(hit["pair"], ["@arm-a", "@arm-b"])
        self.assertAlmostEqual(hit["volume_mm3"], 375.0, places=2)  # x 0..5, y 25..40, z 0..5

    def test_a_bare_part_number_placed_twice_is_ambiguous(self) -> None:
        hw = self.twins(TWINS_YAML)
        proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.root / "fx" / "twins"),
                                       "--steps", "2", "--grid", "0", "--end-effector", "TST-0202",
                                       "--worst-step", str(self.root / "w-ambiguous.step"))
        self.assertEqual((proc.returncode, result), (2, {}))
        self.assertIn("ambiguous", proc.stderr)
        self.assertIn("@arm-a, @arm-b", proc.stderr)

    def test_an_assembly_step_with_the_wrong_rest_placement_is_refused(self) -> None:
        hw = self.twins(TWINS_YAML)
        posed = self.root / "twins-posed.step"
        proc, _ = self.run_script("pose.py", "--hw", str(hw), "--parts-dir", str(self.root / "fx" / "twins"),
                                  "--set", "J-001=45", "--out", str(posed))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        proc, result = self.run_script("pose.py", "--hw", str(hw), "--step", str(posed), "--out", str(self.root / "x.step"))
        self.assertEqual((proc.returncode, result), (2, {}))
        self.assertIn("not at its rest placement", proc.stderr)

    def cad_model_version(self) -> Path:
        """A cad-model layout: versions/v1 with zero-pose parts, an assembly.step posed at J-001=30, latest.json."""
        hw = self.hw(90)
        version = hw / "versions" / "v1"
        shutil.copytree(self.planar, version / "parts")
        proc, _ = self.run_script("pose.py", "--hw", str(hw), "--parts-dir", str(self.planar), "--set", "J-001=30",
                                  "--out", str(version / "assembly.step"))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        (version / "manifest.json").write_text(json.dumps({"label": "v1", "pose": {"values": {"J-001": 30.0, "J-002": 0.0}}}),
                                               encoding="utf-8")
        (hw / "versions" / "latest.json").write_text(json.dumps({"label": "v1", "parts": {}}), encoding="utf-8")
        return hw

    def test_a_cad_model_assembly_step_posed_at_nominal_is_refused(self) -> None:
        hw = self.cad_model_version()
        proc, result = self.run_script("sweep.py", "--hw", str(hw), "--step", str(hw / "versions" / "v1" / "assembly.step"),
                                       "--steps", "5", "--grid", "0", "--worst-step", str(self.root / "w3.step"))
        self.assertEqual((proc.returncode, result), (2, {}), proc.stderr[-2000:])
        self.assertIn("--version v1", proc.stderr)

    def test_a_version_sweeps_like_its_parts_dir(self) -> None:
        hw = self.cad_model_version()
        common = ("--hw", str(hw), "--steps", "5", "--grid", "3")
        runs = [self.run_script("sweep.py", *common, *source, "--worst-step", str(self.root / f"w-{n}.step"))
                for n, source in enumerate((("--version", "v1"), ("--parts-dir", str(hw / "versions" / "v1" / "parts"))))]
        (by_version, a), (by_dir, b) = runs
        self.assertEqual((by_version.returncode, by_dir.returncode), (0, 0), by_version.stderr[-2000:] + by_dir.stderr[-2000:])
        for key in ("status", "poses", "pairs", "collisions", "min_clearance", "reach_envelope"):
            self.assertEqual(a[key], b[key], key)
        self.assertEqual((a["worst_case"]["pose"], a["worst_case"]["reach_mm"]), (b["worst_case"]["pose"], b["worst_case"]["reach_mm"]))
        self.assertIn("--version v1", a["worst_case"]["command"])

    def test_latest_resolves_through_latest_json_and_an_unbuilt_version_is_refused(self) -> None:
        hw = self.cad_model_version()
        posed = [self.run_script("pose.py", "--hw", str(hw), *source, "--set", "J-002=90", "--out", str(self.root / f"l-{n}.step"))
                 for n, source in enumerate((("--version", "latest"), ("--parts-dir", str(self.planar))))]
        (latest, a), (by_dir, b) = posed
        self.assertEqual((latest.returncode, by_dir.returncode), (0, 0), latest.stderr[-2000:])
        self.assertEqual(a["placements"], b["placements"])
        proc, _ = self.run_script("pose.py", "--hw", str(hw), "--version", "v2", "--out", str(self.root / "v2.step"))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("not a built cad-model version", proc.stderr)

    def v6_hw(self, misphased: int | None) -> Path:
        """A record over the v6 fixture: v6_record.record(misphased) and part records with their frames."""
        import yaml

        hw = Path(tempfile.mkdtemp(dir=self.root))
        (hw / "assembly.yaml").write_text(yaml.safe_dump(v6_record.record(misphased), sort_keys=False), encoding="utf-8")
        for pn, (title, frame) in v6_record.PARTS.items():
            (hw / "parts" / pn).mkdir(parents=True)
            (hw / "parts" / pn / "part.yaml").write_text(f"PN: {pn}\ntitle: {title}\nmodel_frame: {frame}\n",
                                                       encoding="utf-8")
        return hw

    def v6_sweep(self, misphased: int | None, criterion: str) -> tuple[Path, subprocess.CompletedProcess[str], dict]:
        """The one-driver sweep of the V6 doc: 145 samples, 5 crank degrees apart, no grid."""
        hw = self.v6_hw(misphased)
        proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.v6), "--steps", "145",
                                       "--grid", "0", "--worst-criterion", criterion,
                                       "--worst-step", str(hw / "worst.step"))
        return hw, proc, result

    def test_one_crank_sweeps_the_coupled_v6_and_finds_the_misphased_valve_at_its_tdc(self) -> None:
        hw, proc, result = self.v6_sweep(3, "maximum_interference")
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        poses = result["poses"]
        self.assertEqual((poses["planned"], poses["evaluated"], poses["independent_joints"], poses["spacing"]),
                         (145, 145, ["J-001"], {"J-001": 5.0}))
        self.assertEqual(len(poses["dependent_joints"]), 20)
        expected = {float(q): 9.0 * misphased_depth(q) for q in range(0, 721, 5) if 9.0 * misphased_depth(q) > 1e-3}
        self.assertEqual(sorted(expected), [220.0, 225.0, 230.0, 235.0, 240.0, 245.0, 250.0, 255.0, 260.0])
        collisions = {c["independent_pose"]["J-001"]: c for c in result["collisions"]}
        self.assertEqual(sorted(collisions), sorted(expected))
        for q, collision in collisions.items():
            self.assertEqual([sorted(p["pair"]) for p in collision["pairs"]], [["@piston-3", "@valve-3"]])
            self.assertAlmostEqual(collision["pairs"][0]["volume_mm3"], expected[q], places=3)
        worst = result["worst_case"]
        self.assertEqual((worst["criterion"], worst["independent_pose"], sorted(worst["pair"])),
                         ("maximum_interference", {"J-001": 240.0}, ["@piston-3", "@valve-3"]))
        self.assertAlmostEqual(worst["volume_mm3"], 18.0, places=3)  # 2 mm deep into the crown, 3 x 3 mm head
        self.assertEqual(worst["pose"]["J-043"], 3.0)
        self.assertAlmostEqual(worst["pose"]["J-013"], 0.0, places=6)
        self.assertTrue(worst["command"].endswith(f"--set J-001=240.0 --out {hw / 'worst.step'}"), worst["command"])
        self.assertEqual(worst["command"].count("--set"), 1)  # independent settings only

        step = hw / "worst.step"
        evidence = json.loads((hw / "worst.step.json").read_text(encoding="utf-8"))
        self.assertEqual(evidence["step"]["sha256"], hashlib.sha256(step.read_bytes()).hexdigest())
        self.assertEqual(evidence["step"]["sha256"], worst["step_sha256"])
        self.assertEqual((evidence["criterion"], evidence["sample"]), ("maximum_interference",
                                                                       {"index": 48, "source": "sweep:J-001"}))
        self.assertEqual((evidence["independent_pose"], evidence["pose"]["J-043"]), ({"J-001": 240.0}, 3.0))
        self.assertEqual(evidence["occurrences"]["piston-3"],
                         {"PN": "VSX-0201", "ref": "@piston-3", "component": "VSX-0201 Piston [@piston-3]"})
        self.assertEqual(evidence["occurrences"]["VSX-0101"]["component"], "VSX-0101 Crankshaft")

        # The worst STEP read back: one definition per PN, one named component per occurrence, and every
        # posed rod's ends on its crankpin and its piston's wrist pin.
        probe = self.probe(step)
        self.assertEqual(probe["definitions"], sorted(v6_record.PARTS))
        self.assertEqual(len(probe["components"]), 22)
        self.assertIn("VSX-0211 Connecting rod [@rod-6]", [c["name"] for c in probe["components"]])
        placed = {c["occurrence"] or c["pn"]: rigid(c["location"]) for c in probe["components"]}
        for cylinder, x, side, phase in v6_record.CYLINDERS:
            with self.subTest(cylinder=cylinder):
                crankpin = placed["VSX-0101"].apply(v6_record.crankpin_rest(x, side, phase))
                assert_close(self, placed[f"rod-{cylinder}"].apply((0.0, 0.0, -v6_record.L)), crankpin, places=6)
                assert_close(self, placed[f"rod-{cylinder}"].apply((0.0, 0.0, 0.0)),
                             placed[f"piston-{cylinder}"].apply((0.0, 0.0, 0.0)), places=6)

        # Replaying the independent setting with pose.py reproduces every placement of the worst STEP.
        proc, posed = self.run_script("pose.py", "--hw", str(hw), "--parts-dir", str(self.v6), "--set", "J-001=240.0",
                                      "--out", str(self.root / "v6-replay.step"))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(sorted(posed["placements"]), sorted(placed))
        for oid, rows in posed["placements"].items():
            for row, expected_row in zip(rows, placed[oid].rows()):
                assert_close(self, row, expected_row, places=6)

    def test_the_correctly_timed_v6_passes_and_reports_its_minimum_clearance(self) -> None:
        hw, proc, result = self.v6_sweep(None, "minimum_clearance")
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual((result["status"], result["collisions"], result["limit_findings"]), ("pass", [], []))
        rows = {tuple(sorted(row["pair"])): row for row in result["min_clearance"]}
        for cylinder, _, _, phase in v6_record.CYLINDERS:
            row = rows[(f"@piston-{cylinder}", f"@valve-{cylinder}")]
            # Closest at the cylinder's first TDC, its valve closed: the head's gap above the crown.
            self.assertEqual((row["clearance_mm"], row["independent_pose"]), (v6_record.VALVE_GAP, {"J-001": -phase % 360}))
        worst = result["worst_case"]
        self.assertEqual((worst["criterion"], worst["required_mm"], worst["overlap_mm3"]), ("minimum_clearance", 0.0, 0.0))
        self.assertEqual((worst["clearance_mm"], worst["margin_mm"]), (result["min_clearance"][0]["clearance_mm"],) * 2)
        self.assertEqual(sorted(worst["pair"]), sorted(result["min_clearance"][0]["pair"]))
        self.assertTrue((hw / "worst.step.json").is_file())

    def test_pose_refuses_a_dependent_joint(self) -> None:
        out = self.root / "v6-dependent.step"
        proc, _ = self.run_script("pose.py", "--hw", str(self.v6_hw(None)), "--parts-dir", str(self.v6),
                                  "--set", "J-013=-1", "--out", str(out))
        self.assertEqual(proc.returncode, 2, proc.stderr[-2000:])
        self.assertIn("J-013 follows J-001 (slider_crank cylinder-3 displacement) and cannot be set", proc.stderr)
        self.assertFalse(out.exists())

    def test_an_incomplete_sweep_after_a_complete_one_leaves_no_worst_artifact(self) -> None:
        worst = self.root / "w-stale.step"
        evidence = worst.with_name("w-stale.step.json")
        common = ("--hw", str(self.hw(90)), "--parts-dir", str(self.planar), "--steps", "5", "--grid", "0",
                  "--worst-step", str(worst))
        proc, result = self.run_script("sweep.py", *common)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        recorded = json.loads(evidence.read_text(encoding="utf-8"))
        self.assertEqual(recorded["step"]["sha256"], hashlib.sha256(worst.read_bytes()).hexdigest())
        self.assertEqual(recorded["independent_pose"], recorded["pose"])  # no couplings: every joint is set
        self.assertEqual(result["worst_case"]["command"].count("--set"), 2)
        proc, result = self.run_script("sweep.py", *common, "--time-limit", "0")
        self.assertEqual(proc.returncode, 2, proc.stderr[-2000:])
        self.assertEqual((result["status"], result["worst_case"]), ("incomplete", None))
        self.assertFalse(worst.exists() or evidence.exists())

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
