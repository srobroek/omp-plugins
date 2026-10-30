#!/usr/bin/env python3
"""cad-motion tests: pure kinematics and frame checks, then STEP runs through OCP and FreeCAD.

Run: python3 -m unittest discover -s cad/skills/cad-motion/tests -v
The STEP tests need `uv`; the FreeCAD test also needs freecadcmd and skips without it.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
BUILDER = HERE / "fixtures" / "build_fixtures.py"
TEMPLATE_HW = HERE.parents[2] / "examples" / "lamp-arm" / "hw"
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

    def test_a_pairs_relative_placement_leaves_out_the_joints_above_its_common_ancestor(self) -> None:
        """J-001 moves TST-0002 and TST-0003 alike, so their relative placement keeps its bits at every
        J-001 value; the pair across J-001 follows it. Both equal T_a^-1 T_b."""
        chain = planar_chain()
        inner, across = ("TST-0002", "TST-0003"), ("TST-0001", "TST-0003")
        values = [{"J-001": q, "J-002": 37.0} for q in (0.0, 13.7, -71.3)]
        relative = [chain.relative_transforms(v, [inner, across]) for v in values]
        self.assertEqual(len({r[inner] for r in relative}), 1)
        self.assertEqual(len({r[across] for r in relative}), 3)
        for v, r in zip(values, relative):
            transforms = chain.transforms(v)
            for a, b in (inner, across):
                for row, expected in zip(r[(a, b)].rows(12), (transforms[a].inverse() @ transforms[b]).rows(12)):
                    assert_close(self, row, expected)

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
        rows, findings = sweep.clearance_report(measured, 0.5, set())
        self.assertEqual(rows[0]["clearance_mm"], 0.5)
        self.assertEqual([f["pair"] for f in findings], [["TST-0001", "TST-0003"]])

    def test_a_fitted_pair_is_listed_but_never_a_clearance_finding(self) -> None:
        measured = {("TST-0003", "TST-0001"): {"pair": ["TST-0003", "TST-0001"], "clearance_mm": 0.0,
                                               "pose": {"J-001": 0.0}}}
        rows, findings = sweep.clearance_report(measured, 0.5, {("TST-0001", "TST-0003")})
        self.assertEqual(([row["clearance_mm"] for row in rows], findings), ([0.0], []))

    @staticmethod
    def bound(lower: float, upper: float, by: str = "mesh") -> dict:
        sample = sweep.Sample(7, "sweep:J-001", {"J-001": 35.0}, {"J-001": 35.0})
        return {"pair": ["@a", "@b"], "lower": lower, "upper": upper, "by": by, "sample": sample}

    def test_a_minimum_that_may_lie_at_a_cleared_request_is_reported_by_bounds_that_bracket_it(self) -> None:
        """The exact minimum 2.6 is not below the cleared request's lower bound 2.51234: the row is
        that bound's, [lower, the smaller of its upper and the exact minimum], rounded outward."""
        exact = {("a", "b"): {"pair": ["@a", "@b"], "clearance_mm": 2.6, "pose": {"J-001": 0.0},
                              "independent_pose": {"J-001": 0.0}}}
        rows, findings = sweep.clearance_report(exact, 0.5, set(), {("a", "b"): self.bound(2.51234, 2.7)})
        self.assertEqual((rows, findings), ([{"pair": ["@a", "@b"], "clearance_mm": 2.5123, "pose": {"J-001": 35.0},
                                              "independent_pose": {"J-001": 35.0}, "method": "mesh",
                                              "bound_mm": [2.5123, 2.6]}], []))

    def test_an_exact_minimum_below_every_cleared_bound_stands(self) -> None:
        exact = {("a", "b"): {"pair": ["@a", "@b"], "clearance_mm": 0.4, "pose": {"J-001": 0.0},
                              "independent_pose": {"J-001": 0.0}}}
        rows, findings = sweep.clearance_report(exact, 0.5, set(), {("a", "b"): self.bound(2.5, 2.7)})
        self.assertEqual([(row["method"], row["clearance_mm"]) for row in rows], [("exact", 0.4)])
        self.assertEqual([f["pair"] for f in findings], [["@a", "@b"]])

    def test_a_pair_cleared_at_every_sample_on_its_box_gap_has_no_upper_bound(self) -> None:
        rows, findings = sweep.clearance_report({}, 0.5, set(), {("a", "b"): self.bound(3.0, math.inf, "box")})
        self.assertEqual([(row["method"], row["bound_mm"]) for row in rows], [("box", [3.0, None])])
        self.assertEqual(findings, [])


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
# Two arms 0.8 mm apart: @arm-a 0.8 mm above the plate on a revolute joint, its tab (y 5..10) facing
# @arm-b (fixed, y 10.8..20.8) over x 0..5, z 0.8..5. Turning @arm-a from 0 to -10 deg lowers its
# largest y, so both gaps are smallest, 0.8 mm, at J-001 = 0: 0.838 mm at -5 deg, 0.952 mm at -10 deg.
GAP_YAML = """occurrences:
  - {id: arm-a, PN: TST-0202, placement: {translation_mm: [0, 0, 0.8]}}
  - {id: arm-b, PN: TST-0202, placement: {translation_mm: [0, 15.8, 0]}}
subassemblies:
  - {id: gap, title: Arms 0.8 mm apart, parts: [TST-0201], occurrences: ["@arm-a", "@arm-b"]}
joints:
  - {id: J-001, type: revolute, parent: TST-0201, child: "@arm-a", axis: [0, 0, 1], origin: [0, 0, 0], min: -10, max: 0, nominal: 0}
  - {id: J-002, type: fixed, parent: TST-0201, child: "@arm-b", axis: [0, 0, 1], origin: [0, 0, 0], min: 0, max: 0, nominal: 0}
"""
# GAP_YAML with @arm-b at y 10..20, touching @arm-a's tab at J-001 = 0 (0 mm; 0.038 mm at -5 deg).
TOUCH_YAML = GAP_YAML.replace("[0, 15.8, 0]", "[0, 15, 0]").replace("Arms 0.8 mm apart", "Arms touching")
# A heat-set insert declared on @arm-a (host) and @arm-b: a checked pair, not joint-connected.
HEAT_SET = {"id": "IF-001", "from": "arm-a", "to": "arm-b", "type": "mounting", "description": "Insert in the arm.",
            "limits": {"heat_set": [{"pair": ["@arm-a", "@arm-b"], "hole_d": 4.0, "insert": "M3 x 4",
                                     "source": "https://example.com/m3-insert"}]}}
# The 2 mm cube TST-0302 of fixtures/nest turning about its own centre inside the 10 mm container
# TST-0301, buried at every pose with no faces touching; the joint-connected pair is checked
# through --include-pair.
NEST_YAML = """subassemblies:
  - {id: nest, title: Buried cube, parts: [TST-0301, TST-0302]}
joints:
  - {id: J-001, type: revolute, parent: TST-0301, child: TST-0302, axis: [0, 0, 1], origin: [5, 5, 5], min: -45, max: 45, nominal: 0}
"""


def clearance_interface(number: int, pair: list[str], minimum: float) -> dict:
    """An interfaces.yaml clearance requirement IF-00<number>."""
    return {"id": f"IF-00{number}", "from": pair[0], "to": pair[1], "type": "clearance", "description": "Running gap.",
            "pair": pair, "min_clearance_mm": minimum}


def assembly_of(text: str):
    """sweep.py's pose.Assembly of an assembly.yaml text whose TST-0202 is part-local. sweep.py runs
    with the pose module freecad_assembly.py loaded last, so its MotionError and Rigid are that module's."""
    import yaml

    motion = sweep.pose
    return motion.Assembly(motion.assembly_data.normalize(yaml.safe_load(text), {"TST-0202": "part_local"}), (), {})


def chain_of(text: str):
    import yaml

    assembly = assembly_of(text)
    joints = [sweep.pose.make_joint(raw, assembly.attachable) for raw in yaml.safe_load(text)["joints"]]
    return sweep.pose.build_chain(joints, assembly.occurrences)


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


class PairRequirementTests(unittest.TestCase):
    """Clearance requirements: pair_policy's reader and sweep's options; needs no OCP."""

    policy = sweep.pair_policy

    @staticmethod
    def requirement(pair: list[str], minimum: object = 1.0, kind: str = "clearance", number: int = 1) -> dict:
        return {"id": f"IF-00{number}", "from": "a", "to": "b", "type": kind, "description": "Gap.", "pair": pair,
                "min_clearance_mm": minimum}

    def declared(self, *interfaces: dict, text: str = GAP_YAML) -> list[dict]:
        return self.policy.declared_clearances(Path("hw"), list(interfaces), assembly_of(text))

    def test_a_requirement_names_its_sorted_occurrence_pair_and_source(self) -> None:
        self.assertEqual(self.declared(self.requirement(["@arm-b", "TST-0201"], 0.5)),
                         [{"pair": ["TST-0201", "arm-b"], "min_clearance_mm": 0.5, "interface": "IF-001",
                           "source": "interfaces.yaml#/interfaces/0"}])

    def test_a_clearance_interface_without_a_pair_stays_descriptive(self) -> None:
        descriptive = {"id": "IF-001", "from": "head", "to": "desk", "type": "clearance", "description": "Clears."}
        self.assertEqual(self.declared(descriptive), [])

    def test_a_malformed_requirement_is_refused(self) -> None:
        pair = ["@arm-a", "@arm-b"]
        without_minimum = {key: value for key, value in self.requirement(pair).items() if key != "min_clearance_mm"}
        cases = {"zero": self.requirement(pair, 0), "negative": self.requirement(pair, -0.5),
                 "boolean": self.requirement(pair, True), "not finite": self.requirement(pair, math.inf),
                 "text": self.requirement(pair, "1"), "another type": self.requirement(pair, kind="mounting"),
                 "one end": self.requirement(["@arm-a"]), "one ref twice": self.requirement(["@arm-a", "@arm-a"]),
                 "no minimum": without_minimum}
        for name, interface in cases.items():
            with self.subTest(name), self.assertRaisesRegex(self.policy.PolicyError, "a clearance requirement needs"):
                self.declared(interface)

    def test_an_unresolved_or_ambiguous_reference_is_refused(self) -> None:
        with self.assertRaisesRegex(sweep.pose.MotionError, "@arm-z"):
            self.declared(self.requirement(["@arm-a", "@arm-z"]))
        with self.assertRaisesRegex(sweep.pose.MotionError, "ambiguous.*@arm-a, @arm-b"):
            self.declared(self.requirement(["TST-0202", "TST-0201"]))

    def test_two_references_to_one_occurrence_are_refused(self) -> None:
        with self.assertRaisesRegex(self.policy.PolicyError, "both ends are the same occurrence"):
            self.declared(self.requirement(["TST-0202", "@arm-p"]), text=PLACED_YAML)

    def test_an_occurrence_pair_takes_one_requirement(self) -> None:
        with self.assertRaisesRegex(self.policy.PolicyError, "already has a clearance requirement at "
                                                             "interfaces.yaml#/interfaces/0"):
            self.declared(self.requirement(["@arm-a", "@arm-b"]), self.requirement(["@arm-b", "@arm-a"], 2.0, number=2))

    def test_running_fits_press_fits_and_inserts_name_the_fitted_pairs(self) -> None:
        running = {"id": "IF-001", "from": "a", "to": "b", "type": "motion", "description": "Pivots.",
                   "limits": {"running_fit": {"fit": "5 f7", "pair": ["@arm-a", "TST-0201"]}}}
        endpoints = {"id": "IF-002", "from": "a", "to": "b", "type": "motion", "description": "Pivots.",
                     "limits": {"running_fit": {"fit": "5 H7/g6", "hole": {"PN": "TST-0202", "occurrence": "@arm-b",
                                                                           "feature": "bore"},
                                                "shaft": {"PN": "TST-0201", "feature": "pin"}}}}
        assembly, hw = assembly_of(GAP_YAML), Path("hw")
        interfaces = [running, endpoints, HEAT_SET]
        fits = self.policy.declared_running_fits(hw, interfaces, assembly)
        self.assertEqual([(fit["pair"], fit["fit"], fit["source"]) for fit in fits], [
            (["TST-0201", "arm-a"], "5 f7", "interfaces.yaml#/interfaces/0/limits/running_fit"),
            (["TST-0201", "arm-b"], "5 H7/g6", "interfaces.yaml#/interfaces/1/limits/running_fit")])
        self.assertEqual(fits[1]["endpoints"]["hole"], {"PN": "TST-0202", "occurrence": "@arm-b", "feature": "bore"})
        fitted = self.policy.fitted_pairs(self.policy.declared_press_fits(hw, interfaces, assembly), fits,
                                          self.policy.declared_heat_sets(hw, interfaces, assembly))
        self.assertEqual(fitted, {("TST-0201", "arm-a"), ("TST-0201", "arm-b"), ("arm-a", "arm-b")})

    def test_a_running_fit_on_one_occurrence_twice_is_refused(self) -> None:
        twice = {"id": "IF-001", "from": "a", "to": "b", "type": "motion", "description": "Pivots.",
                 "limits": {"running_fit": {"fit": "5 f7", "pair": ["TST-0202", "@arm-p"]}}}
        with self.assertRaisesRegex(self.policy.PolicyError, "both ends are the same occurrence"):
            self.policy.declared_running_fits(Path("hw"), [twice], assembly_of(PLACED_YAML))

    def test_an_option_overrides_the_record_or_adds_a_requirement(self) -> None:
        declared = self.declared(self.requirement(["@arm-b", "@arm-a"], 0.5))
        found = sweep.pair_requirements(chain_of(GAP_YAML), declared, ["@arm-b:@arm-a=1.0", "TST-0201:@arm-a=0.75"])
        self.assertEqual(found, {
            ("arm-a", "arm-b"): {"required_mm": 1.0, "source": "--pair-clearance @arm-b:@arm-a=1.0",
                                 "overrides": "interfaces.yaml#/interfaces/0"},
            ("TST-0201", "arm-a"): {"required_mm": 0.75, "source": "--pair-clearance TST-0201:@arm-a=0.75"}})

    def test_a_malformed_option_is_a_usage_error(self) -> None:
        chain = chain_of(GAP_YAML)
        for spec in ("@arm-a:@arm-b", "@arm-a@arm-b=1", "@arm-a:@arm-b=0", "@arm-a:@arm-b=-1", "@arm-a:@arm-b=nan",
                     "@arm-a:@arm-b=mm", "@arm-a:@arm-a=1", "@arm-a:@arm-z=1", "TST-0202:@arm-a=1"):
            with self.subTest(spec), self.assertRaises(sweep.pose.MotionError):
                sweep.pair_requirements(chain, [], [spec])

    def test_a_record_requirement_outside_the_chain_is_a_usage_error(self) -> None:
        stray = [{"pair": ["TST-0201", "TST-0999"], "min_clearance_mm": 1.0, "interface": "IF-001",
                  "source": "interfaces.yaml#/interfaces/0"}]
        with self.assertRaisesRegex(sweep.pose.MotionError, "TST-0999 is not in the swept chain"):
            sweep.pair_requirements(chain_of(GAP_YAML), stray, [])


class BroadPhaseTests(unittest.TestCase):
    """pair_measure's broad phase on stand-in unit cubes slid along x, whose box gap is their
    distance, so every bound is tight; needs no OCP."""

    @classmethod
    def run_requests(cls, offsets: list[float], thresholds: tuple[float, ...] = (), prune: bool = True,
                     **fast) -> tuple[list, int]:
        outcomes, calls, _ = cls.run_measurer(offsets, thresholds, prune, **fast)
        return outcomes, calls

    @staticmethod
    def run_measurer(offsets: list[float], thresholds: tuple[float, ...] = (), prune: bool = True,
                     band: float | None = None, mesh=None, box: float = 0.0, kernel=None) -> tuple[list, int, object]:
        """(outcomes, kernel calls, the measurer) of b at each x offset; `box` enlarges each stand-in
        box that far beyond its cube, `mesh` stands in for mesh_bound.MeshBounds, `kernel` (x ->
        distance) for the cubes' distance."""
        cube = ([-box, -box, -box], [1.0 + box, 1.0 + box, 1.0 + box])
        measure = sweep.pair_measure
        with mock.patch.object(measure, "box_corners", side_effect=lambda shape, tolerance=False: cube):
            measurer = measure.PairMeasurer({"A": "a", "B": "b"}, band=band, mesh=mesh)
        rigid = sweep.pose.Rigid
        requests = [measure.Request("A", "B", rigid(rigid.identity().rot, (x, 0.0, 0.0)), thresholds=thresholds,
                                    group="pair") for x in offsets]
        distance = kernel or (lambda x: max(0.0, abs(x) - 1.0))
        with mock.patch.object(measure.pose, "placed", side_effect=lambda shape, at: at.trans[0]), \
                mock.patch.object(measure.pose, "interference",
                                  side_effect=lambda a, x, box_gap=0.0, threads=False: (distance(x), 0.0)) as calls:
            return measurer.measure(requests, prune=prune), calls.call_count, measurer

    def assert_sound(self, offsets: list[float], thresholds: tuple[float, ...] = ()) -> list:
        """Pruned and unpruned agree on every measured request; each pruned one is farther than the
        group minimum, the gate and every threshold, and its witness holds a measured distance."""
        full, _ = self.run_requests(offsets, thresholds, prune=False)
        pruned, calls = self.run_requests(offsets, thresholds)
        minimum = min(outcome[0] for outcome in full)
        for got, want in zip(pruned, full):
            if isinstance(got, sweep.pair_measure.Pruned):
                self.assertGreater(want[0], max(minimum, sweep.pose.OVERLAP_GATE_MM, *thresholds))
                self.assertIsInstance(pruned[got.witness], tuple)
            else:
                self.assertEqual(got, want)
        self.assertEqual(calls, sum(1 for outcome in pruned if isinstance(outcome, tuple)))
        return pruned

    def test_requests_beyond_the_group_minimum_are_pruned_after_the_smallest_gap_is_measured(self) -> None:
        pruned = self.assert_sound([6.0, 4.0, 3.0, 5.0, 2.5])
        self.assertEqual(pruned, [sweep.pair_measure.Pruned(4)] * 4 + [(1.5, 0.0)])

    def test_a_request_below_a_threshold_is_measured(self) -> None:
        pruned = self.assert_sound([6.0, 4.0, 3.0, 5.0, 2.5], thresholds=(2.5,))
        self.assertEqual([isinstance(outcome, tuple) for outcome in pruned], [False, False, True, False, True])

    def test_a_threshold_just_above_a_distance_keeps_that_request_measured(self) -> None:
        pruned = self.assert_sound([6.0, 4.0, 3.0, 5.0, 2.5], thresholds=(2.0 + 1e-7,))
        self.assertEqual(pruned[2], (2.0, 0.0))

    def test_nothing_is_pruned_within_the_slack_of_the_minimum_or_of_contact(self) -> None:
        pruned = self.assert_sound([2.5 + 5e-7, 2.5, 6.0])
        self.assertEqual([isinstance(outcome, tuple) for outcome in pruned], [True, True, False])
        pruned = self.assert_sound([0.5, 1.0 + 5e-7, 0.7, 3.0])  # touching at 0.5 and 0.7, 5e-7 mm apart at 1.0000005
        self.assertEqual([isinstance(outcome, tuple) for outcome in pruned], [True, True, True, False])

    def test_bitwise_equal_placements_share_one_measurement_and_one_bit_apart_does_not(self) -> None:
        above = math.nextafter(3.0, math.inf)
        outcomes, calls = self.run_requests([3.0, 3.0, above, 3.0], prune=False)
        self.assertEqual((outcomes, calls), ([(2.0, 0.0), (2.0, 0.0), (above - 1.0, 0.0), (2.0, 0.0)], 2))

    class Mesh:
        """mesh_bound.MeshBounds' stand-in: the cubes' distance -+ 0.05 mm, deflection 0.02 mm."""

        linear, angular = 0.02, 0.2

        def __init__(self) -> None:
            self.calls = 0

        def interval(self, a: str, b: str, placement) -> tuple[float, float]:
            self.calls += 1
            distance = max(0.0, abs(placement.trans[0]) - 1.0)
            return distance - 0.05, distance + 0.05

        @staticmethod
        def spread(a: str, b: str) -> float:
            return 0.05

    def test_fast_mode_clears_requests_proved_beyond_their_thresholds_plus_the_band(self) -> None:
        """Band 2 over a 1 mm threshold: distances 5 and 4 are cleared on their box gaps, 3 is within
        the band by the slack, so it and 2 are pruned on the measured minimum 1.5."""
        outcomes, calls, measurer = self.run_measurer([6.0, 4.0, 3.0, 5.0, 2.5], thresholds=(1.0,), band=2.0)
        cleared, pruned = sweep.pair_measure.Cleared, sweep.pair_measure.Pruned
        self.assertEqual(outcomes, [cleared(5.0, math.inf, "box"), pruned(4), pruned(4), cleared(4.0, math.inf, "box"),
                                    (1.5, 0.0)])
        self.assertEqual((calls, measurer.cleared, measurer.suspects), (1, {"box": 2, "mesh": 0}, []))

    def test_a_mesh_bound_clears_where_the_box_gap_does_not(self) -> None:
        """Boxes 1 mm larger than their cubes: at distance 5 the box gap, 3, clears; at distance 3 the
        gap, 1, does not, the mesh bound, 2.95, does; neither is measured."""
        mesh = self.Mesh()
        outcomes, calls, measurer = self.run_measurer([6.0, 4.0], band=1.0, mesh=mesh, box=1.0)
        cleared = sweep.pair_measure.Cleared
        self.assertEqual(outcomes, [cleared(3.0, math.inf, "box"), cleared(2.95, 3.05, "mesh")])
        self.assertEqual((calls, mesh.calls, measurer.cleared), (0, 1, {"box": 1, "mesh": 1}))

    def test_fast_mode_clears_the_same_requests_with_the_same_bounds_in_any_order(self) -> None:
        offsets = [6.0, 4.0, 3.0, 5.0, 2.5, 3.5, 4.0]
        forward, _, _ = self.run_measurer(offsets, thresholds=(1.0,), band=1.0, mesh=self.Mesh(), box=1.0)
        backward, _, _ = self.run_measurer(offsets[::-1], thresholds=(1.0,), band=1.0, mesh=self.Mesh(), box=1.0)
        cleared = sweep.pair_measure.Cleared
        for one, other in zip(forward, backward[::-1]):
            self.assertEqual(isinstance(one, cleared), isinstance(other, cleared))
            if isinstance(one, cleared) or (isinstance(one, tuple) and isinstance(other, tuple)):
                self.assertEqual(one, other)  # a measured request may be pruned in the other order
        self.assertEqual(sum(isinstance(outcome, cleared) for outcome in forward), 5)  # all but distances 2 and 1.5

    def test_a_mesh_bound_inside_the_band_does_not_prune(self) -> None:
        """Band 1, boxes 1 mm larger: the request at distance 0.8 has the mesh bound 0.75, above the
        measured minimum 0.5 but inside the band, so it is measured, not pruned."""
        outcomes, calls, _ = self.run_measurer([1.5, 1.8], band=1.0, mesh=self.Mesh(), box=1.0)
        self.assertEqual((outcomes, calls), ([(0.5, 0.0), (0.8, 0.0)], 2))

    def degenerate(self, kernel, band: float | None = 1.0, thresholds: tuple[float, ...] = (2.5,)):
        """One request at distance 3 (box gap 3, mesh interval [2.95, 3.05]) whose kernel `kernel`
        reads at x = 4."""
        mesh = self.Mesh()
        outcomes, calls, measurer = self.run_measurer([4.0], thresholds=thresholds, band=band, mesh=mesh, kernel=kernel)
        (suspect,) = measurer.suspects
        self.assertEqual((suspect.requests, suspect.distance, suspect.lower, suspect.upper), ((0,), 0.0, 3.0, 3.05))
        self.assertEqual([label for label, _, _ in sorted(suspect.reevaluated)], ["+0.01 mm", "-0.01 mm", "swapped"])
        self.assertEqual((calls, measurer.measured, measurer.reevaluations, mesh.calls), (4, 1, 3, 3))
        return outcomes, suspect

    def test_a_degenerate_zero_is_a_suspect_resolved_by_its_reevaluations_and_feeds_no_result(self) -> None:
        """Exact mode, threshold 0.5: the kernel reads 0 at x = 4 only; the re-measurements 0.01 mm
        either way and with the parts swapped agree with their mesh intervals, and the bound 3 clears
        the threshold plus the 2 mm band, so the request reads as the mesh bounds, not 0."""
        outcomes, suspect = self.degenerate(lambda x: 0.0 if x == 4.0 else max(0.0, abs(x) - 1.0), None, (0.5,))
        self.assertEqual(outcomes, [sweep.pair_measure.Cleared(3.0, 3.05, "mesh (exact suspect)")])
        self.assertTrue(suspect.resolved)
        for label, (distance, volume), bounds in suspect.reevaluated:
            if label != "swapped":
                self.assertTrue(bounds[0] <= distance <= bounds[1], label)

    def test_a_suspect_whose_bounds_lie_within_the_band_stays_unresolved(self) -> None:
        """Fast mode, threshold 2.5, band 1: the re-measurements agree, but the bound 3 does not clear
        3.5, as clearing would require, so the suspect fails."""
        outcomes, suspect = self.degenerate(lambda x: 0.0 if x == 4.0 else max(0.0, abs(x) - 1.0))
        self.assertEqual((outcomes, suspect.resolved), ([sweep.pair_measure.Cleared(3.0, 3.05, "suspect")], False))

    def test_a_suspect_its_reevaluations_do_not_resolve_stays_unresolved(self) -> None:
        outcomes, suspect = self.degenerate(lambda x: 0.0, None, (0.5,))
        self.assertEqual((outcomes, suspect.resolved), ([sweep.pair_measure.Cleared(3.0, 3.05, "suspect")], False))

    def test_exact_mode_checks_every_measurement_against_the_mesh(self) -> None:
        """No threshold and no contact: the one measurement still gets its interval, and agrees with it."""
        mesh = self.Mesh()
        outcomes, calls, measurer = self.run_measurer([6.0, 4.0], mesh=mesh)
        self.assertEqual((outcomes, calls, mesh.calls, measurer.cleared, measurer.suspects),
                         ([sweep.pair_measure.Pruned(1), (3.0, 0.0)], 1, 1, {"box": 0, "mesh": 0}, []))

    def test_a_stopped_sweep_reduces_only_samples_whose_pruned_requests_are_proved_inside_them(self) -> None:
        """One pair, one request per sample: sample 1 is pruned on sample 3's distance."""
        samples = [sweep.PlannedSample(None, [], {}, start) for start in range(5)]
        plan = sweep.Plan({("a", "b")}, [("a", "b")], {}, {}, samples, [])
        pruned = sweep.pair_measure.Pruned
        for outcomes, taken in (([(1.0, 0.0), pruned(3), (2.0, 0.0), (0.5, 0.0), None], 4),
                                ([(1.0, 0.0), pruned(3), (2.0, 0.0), None, None], 1),
                                ([(1.0, 0.0), pruned(0), (2.0, 0.0), (0.5, 0.0), (0.7, 0.0)], 5)):
            with self.subTest(outcomes=outcomes):
                self.assertEqual(sweep.measured_prefix(mock.Mock(), plan, outcomes), taken)


class PairCacheTests(unittest.TestCase):
    """pair_measure.PairCache under a PairMeasurer, on stand-in definitions whose BRep bytes and
    measurement salt are patched in, and a stand-in kernel; needs no OCP."""

    def setUp(self) -> None:
        self.folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.folder)
        self.geometry = {"a": b"a v1", "b": b"b v1", "c": b"c v1"}
        self.salt = b"salt 1"

    def run_requests(self, failing: frozenset = frozenset(), folder: Path | None = None) -> tuple[list, list, object]:
        """A-B, A-C and B-C at two placements each: (outcomes, the kernel's (a, b) calls, the measurer)."""
        measure = sweep.pair_measure
        cube = ([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
        cache = measure.PairCache(folder or self.folder)
        self.addCleanup(cache.close)
        with mock.patch.object(measure, "box_corners", side_effect=lambda shape, tolerance=False: cube):
            measurer = measure.PairMeasurer({"A": "a", "B": "b", "C": "c"}, cache=cache)
        rigid = sweep.pose.Rigid
        requests = [measure.Request(a, b, rigid(rigid.identity().rot, (x, 0.0, 0.0)))
                    for a, b in (("A", "B"), ("A", "C"), ("B", "C")) for x in (3.0, 4.5)]

        def kernel(shape, moved, box_gap=0.0, threads=False):
            if (shape, moved[0]) in failing:
                raise RuntimeError("Standard_Failure")
            return moved[1] / 3.1, 0.0

        with mock.patch.object(measure, "shape_bytes", side_effect=lambda shape: self.geometry[shape]), \
                mock.patch.object(measure, "measurement_salt", return_value=self.salt), \
                mock.patch.object(measure.pose, "placed", side_effect=lambda shape, at: (shape, at.trans[0])), \
                mock.patch.object(measure.pose, "interference", side_effect=kernel) as calls:
            outcomes = measurer.measure(requests)
        return outcomes, [(args[0], args[1][0]) for args, _ in calls.call_args_list], measurer

    def test_a_warm_run_reads_every_measurement_back_bitwise(self) -> None:
        cold, cold_calls, _ = self.run_requests()
        warm, warm_calls, measurer = self.run_requests()
        self.assertEqual((len(cold_calls), warm_calls, measurer.disk_hits), (6, [], 6))
        self.assertEqual([[v.hex() for v in o] for o in warm], [[v.hex() for v in o] for o in cold])

    def test_editing_one_definition_misses_only_its_pairs(self) -> None:
        self.run_requests()
        self.geometry["c"] = b"c v2"
        _, calls, _ = self.run_requests()
        self.assertEqual(calls, [("a", "c"), ("a", "c"), ("b", "c"), ("b", "c")])

    def test_a_salt_change_misses_every_entry(self) -> None:
        self.run_requests()
        self.salt = b"salt 2"
        self.assertEqual(len(self.run_requests()[1]), 6)

    def test_a_failed_measurement_is_not_stored(self) -> None:
        outcomes, _, _ = self.run_requests(failing=frozenset({("a", "b")}))
        self.assertEqual(outcomes[:2], [sweep.pair_measure.Failure("Standard_Failure")] * 2)
        self.assertEqual(self.run_requests()[1], [("a", "b"), ("a", "b")])

    def test_a_corrupt_or_unusable_cache_measures_without_it_and_says_so(self) -> None:
        (self.folder / "corrupt").mkdir()
        (self.folder / "corrupt" / "pairs.sqlite").write_bytes(b"not a database " * 100)
        (self.folder / "taken").write_text("a file where the cache directory goes", encoding="utf-8")
        for name in ("corrupt", "taken"):
            with self.subTest(name=name), contextlib.redirect_stderr(io.StringIO()) as err:
                outcomes, calls, _ = self.run_requests(folder=self.folder / name)
                self.assertEqual(len(calls), 6)
                self.assertTrue(all(isinstance(outcome, tuple) for outcome in outcomes))
                self.assertIn("is unusable, measuring without it", err.getvalue())

    def test_past_the_size_cap_the_oldest_entries_go(self) -> None:
        measure = sweep.pair_measure
        keys = [hashlib.sha256(str(i).encode()).digest() for i in range(401)]
        cache = measure.PairCache(self.folder)
        for key in keys[:400]:
            cache.store(key, (1.0, 0.0))
        cache.close()
        with contextlib.closing(sqlite3.connect(cache.path)) as connection:
            page_size, pages, free = (connection.execute(f"PRAGMA {name}").fetchone()[0]
                                      for name in ("page_size", "page_count", "freelist_count"))
        capped = measure.PairCache(self.folder, max_bytes=(pages - free) * page_size // 2)
        self.addCleanup(capped.close)
        capped.store(keys[400], (2.0, 0.0))
        capped.flush()
        kept = capped.lookup(keys)
        self.assertTrue(0 < len(kept) < 300, len(kept))
        self.assertEqual(set(kept), set(keys[-len(kept):]))


class JobsArgumentTests(unittest.TestCase):
    """`--jobs`: auto is the CPU count capped at AUTO_JOBS_MAX; needs no OCP."""

    def test_auto_follows_the_cpu_count_up_to_the_cap_and_a_count_must_be_positive(self) -> None:
        measure = sweep.pair_measure
        for cpus, jobs in ((None, 1), (1, 1), (4, 4), (32, measure.AUTO_JOBS_MAX)):
            with self.subTest(cpus=cpus), mock.patch.object(measure.os, "cpu_count", return_value=cpus):
                self.assertEqual(measure.jobs_argument("auto"), jobs)
        self.assertEqual(measure.jobs_argument("3"), 3)
        for text in ("0", "-1", "two", ""):
            with self.subTest(text=text), self.assertRaises(sweep.argparse.ArgumentTypeError):
                measure.jobs_argument(text)


class WorkerLifetimeTests(unittest.TestCase):
    """pair_measure.die_with: a worker armed with its measuring process's id ends when that process
    is killed, mid-sleep as mid-measurement; needs no OCP."""

    WORKER = ("import importlib.util, sys, time\n"
              "spec = importlib.util.spec_from_file_location('cad_motion_pair_measure', sys.argv[1])\n"
              "module = importlib.util.module_from_spec(spec)\n"
              "sys.modules[spec.name] = module\n"
              "spec.loader.exec_module(module)\n"
              "module.die_with(int(sys.argv[2]))\n"
              "print('armed', flush=True)\n"
              "time.sleep(120)\n")
    PARENT = ("import os, subprocess, sys, time\n"
              "worker = subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2], str(os.getpid())],\n"
              "                          stdout=subprocess.PIPE, text=True)\n"
              "assert worker.stdout.readline().strip() == 'armed'\n"
              "print(worker.pid, flush=True)\n"
              "time.sleep(120)\n")

    @staticmethod
    def alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True

    @unittest.skipUnless(sys.platform.startswith("linux") or hasattr(__import__("select"), "kqueue"),
                         "die_with arms nothing without PR_SET_PDEATHSIG or kqueue")
    def test_a_worker_dies_with_its_killed_measuring_process(self) -> None:
        parent = subprocess.Popen([sys.executable, "-c", self.PARENT, self.WORKER, str(SCRIPTS / "pair_measure.py")],
                                  stdout=subprocess.PIPE, text=True)
        worker = int(parent.stdout.readline())
        self.addCleanup(lambda: self.alive(worker) and os.kill(worker, signal.SIGKILL))
        self.assertTrue(self.alive(worker))
        parent.kill()
        parent.wait()
        parent.stdout.close()
        deadline = time.monotonic() + 10.0
        while self.alive(worker) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(self.alive(worker))


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

    def run_script(self, script: str, *args: str, adapt_outputs: bool = True) -> tuple[subprocess.CompletedProcess[str], dict]:
        """Run one CLI with scratch-only output paths; mirror test artifacts to requested fixture paths."""
        if script == "sweep.py" and not {"--cache", "--no-cache"} & set(args):
            args = (*args, "--cache", tempfile.mkdtemp(dir=self.root))
        values = list(args)
        hw = Path(values[values.index("--hw") + 1])
        mirrors: list[tuple[Path, Path]] = []
        if adapt_outputs:
            for option in ("--out", "--worst-step", "--job-dir"):
                if option not in values:
                    continue
                index = values.index(option) + 1
                requested = Path(values[index])
                try:
                    requested.resolve().relative_to((hw.parent / ".cad-work").resolve())
                except ValueError:
                    # a fresh folder per call: the CLIs refuse to overwrite an existing scratch output
                    run_dir = hw.parent / ".cad-work" / "test-output" / hw.name
                    run_dir.mkdir(parents=True, exist_ok=True)
                    scratch = Path(tempfile.mkdtemp(dir=run_dir)) / f"{script}-{len(mirrors)}-{requested.name}"
                    values[index] = str(scratch)
                    mirrors.append((scratch, requested))
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(SCRIPTS / script), *values],
                              capture_output=True, text=True, check=False, timeout=900)
        for scratch, requested in mirrors:
            if scratch.is_file():
                requested.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(scratch, requested)
            sidecar = scratch.with_name(scratch.name + ".json")
            if sidecar.is_file():
                shutil.copyfile(sidecar, requested.with_name(requested.name + ".json"))
        return proc, json.loads(proc.stdout) if proc.stdout.strip() else {}

    def assert_same_sweeps(self, runs: list[tuple[Path, dict]]) -> None:
        """Each (folder of its worst.step, result) reports what the first does: the JSON but its
        timings, the evidence but its paths, and the worst-case STEP but its header time."""

        def comparable(folder: Path, result: dict) -> tuple[str, str, str]:
            worst = {k: v for k, v in result["worst_case"].items() if k != "step_sha256"}  # the STEP header has a time
            kept = {**{k: v for k, v in result.items() if k != "timings_s"}, "worst_case": worst}
            # each run's own folder, then the scratch folder run_script mirrors its outputs from
            text = json.dumps(kept).replace(str(folder), "OUT").replace(str(folder.parent), "OUT_PARENT")
            text = re.sub(r"/\.cad-work/test-output/[^/\"]+/[^/\"]+/", "/.cad-work/test-output/HW/RUN/", text)
            evidence = json.loads((folder / "worst.step.json").read_text(encoding="utf-8"))
            step = re.sub(r"FILE_NAME\(.*?\);", "", (folder / "worst.step").read_text(encoding="utf-8"), count=1,
                          flags=re.S)
            self.assertTrue(step)
            return (text, json.dumps({k: v for k, v in evidence.items() if k not in ("step", "inputs", "command")}), step)

        first, *others = [comparable(folder, result) for folder, result in runs]
        for other in others:
            self.assertEqual(other, first)

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
    def test_pose_step_declares_millimetre_units(self) -> None:
        out = self.root / "posed-mm.step"
        proc, _ = self.run_script("pose.py", "--hw", str(self.hw(180)), "--parts-dir", str(self.planar),
                                  "--set", "J-002=90", "--out", str(out))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        text = out.read_text(encoding="utf-8")
        self.assertIn("SI_UNIT(.MILLI.,.METRE.)", text)

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

    def test_a_part_buried_in_a_solid_or_a_compound_part_is_a_collision(self) -> None:
        hw = Path(tempfile.mkdtemp(dir=self.root))
        (hw / "assembly.yaml").write_text(NEST_YAML, encoding="utf-8")
        for container in ("solid", "compound"):
            with self.subTest(container=container):
                parts = self.root / "fx" / "nest" / container
                proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(parts), "--steps", "3",
                                               "--grid", "0", "--include-pair", "TST-0301:TST-0302",
                                               "--worst-step", str(hw / "worst.step"))
                self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
                self.assertEqual(result["collision_pose_count"], 3, result["collisions"])
                for collision in result["collisions"]:
                    self.assertEqual([hit["pair"] for hit in collision["pairs"]], [["TST-0301", "TST-0302"]])
                    self.assertAlmostEqual(collision["pairs"][0]["volume_mm3"], 8.0, places=3)
                self.assertEqual([row["clearance_mm"] for row in result["min_clearance"]], [0.0])

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
        hw = shutil.copytree(TEMPLATE_HW, Path(tempfile.mkdtemp(dir=self.root)) / "hw")  # scratch lands beside it
        proc, result = self.run_script("pose.py", "--hw", str(hw), "--step", str(self.lamp / "lamp-arm.step"),
                                       "--set", "J-002=-90", "--out", str(out))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(sorted(result["placements"]),
                         [f"LMP-{n:04d}" for n in range(1, 11)] + ["ring-base", "ring-elbow", "ring-head"])
        self.assertEqual({oid: pn for oid, pn in result["occurrences"].items() if pn == "LMP-0011"},
                         {"ring-base": "LMP-0011", "ring-elbow": "LMP-0011", "ring-head": "LMP-0011"})
        text = out.read_text(encoding="utf-8")
        self.assertIn("PRODUCT('LMP-0003 Upper link'", text)
        self.assertEqual(text.count("PRODUCT('LMP-0011 Retaining ring DIN 471 - 5x0.6'"), 1)
        probe = self.probe(out)
        rings = sorted(c["occurrence"] for c in probe["components"] if c["pn"] == "LMP-0011")
        self.assertEqual(rings, ["ring-base", "ring-elbow", "ring-head"])
        boxes = {c["occurrence"]: c["bbox"] for c in probe["components"] if c["occurrence"]}
        assert_close(self, boxes["ring-elbow"][0], (156.8, -11.605, 36.8), places=3)
        assert_close(self, boxes["ring-elbow"][1], (163.2, -11.005, 43.2), places=3)
        assert_close(self, boxes["ring-head"][0], (156.8, -9.105, 236.8), places=3)
        assert_close(self, boxes["ring-head"][1], (163.2, -8.505, 243.2), places=3)

    def probe(self, step: Path) -> dict:
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(HERE / "fixtures" / "probe_step.py"), str(step)],
                              capture_output=True, text=True, check=False, timeout=900)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        return json.loads(proc.stdout)

    def test_the_bounds_hold_and_the_broad_phase_containment_skip_and_threads_change_no_measured_value(self) -> None:
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(HERE / "fixtures" / "measure_probe.py"),
                               str(self.root / "fx")], capture_output=True, text=True, check=False, timeout=900)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        report = json.loads(proc.stdout)
        self.assertEqual((report["bound_violations"], report["mismatches"], report["thread_mismatches"],
                          report["prune_violations"]), ([], [], [], []))
        self.assertGreater(report["wrapped"], report["compared"] // 2, report)
        self.assertGreater(report["pruned"], report["requests"] // 10, report)
        self.assertEqual(report["buried"]["gap"], 0.0)
        self.assertEqual(report["buried"]["result"][0], 0.0)
        self.assertAlmostEqual(report["buried"]["result"][1], 8.0, places=6)

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
        self.assertEqual(result["placements"]["arm-p"],
                         [[0.0, -1.0, 0.0, 40.0], [1.0, 0.0, 0.0, 10.0], [0.0, 0.0, 1.0, 0.0]])
        arm = next(c for c in self.probe(out)["components"] if c["occurrence"] == "arm-p")
        self.assertEqual(arm["name"], "TST-0202 Arm [@arm-p]")
        assert_close(self, arm["bbox"][0], (30.0, 10.0, 0.0), places=5)
        assert_close(self, arm["bbox"][1], (45.0, 60.0, 5.0), places=5)

    def test_moving_one_sibling_leaves_the_other_at_its_rest_placement(self) -> None:
        hw = self.twins(TWINS_YAML)
        out = self.root / "twins.step"
        proc, result = self.run_script("pose.py", "--hw", str(hw), "--parts-dir", str(self.root / "fx" / "twins"),
                                       "--set", "J-001=90", "--out", str(out))
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(result["placements"]["arm-a"],
                         [[0.0, -1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]])
        self.assertEqual(result["placements"]["arm-b"],
                         [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 30.0], [0.0, 0.0, 1.0, 0.0]])
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
        self.assertAlmostEqual(hit["volume_mm3"], 375.0, places=2)

    def test_a_bare_part_number_placed_twice_is_ambiguous(self) -> None:
        hw = self.twins(TWINS_YAML)
        proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.root / "fx" / "twins"),
                                       "--steps", "2", "--grid", "0", "--end-effector", "TST-0202",
                                       "--worst-step", str(self.root / "w-ambiguous.step"))
        self.assertEqual((proc.returncode, result), (2, {}))
        self.assertIn("ambiguous", proc.stderr)
        self.assertIn("@arm-a, @arm-b", proc.stderr)

    def twins_sweep(self, assembly: str, interfaces: list[dict], *options: str):
        """Sweep twins geometry and return pair clearance rows by pair."""
        import yaml

        hw = self.twins(assembly)
        (hw / "interfaces.yaml").write_text(yaml.safe_dump({"interfaces": interfaces}), encoding="utf-8")
        proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.root / "fx" / "twins"),
                                       "--steps", "3", "--grid", "0", *options,
                                       "--worst-step", str(hw / "worst.step"))
        return proc, result, {tuple(row["pair"]): row for row in result.get("pair_clearance", [])}

    def gap_sweep(self, between: float | None, plate: float | None, *options: str):
        """Sweep twins with optional arm-gap and ground-plate clearance requirements."""
        declared = [(1, ["@arm-a", "@arm-b"], between), (2, ["TST-0201", "@arm-a"], plate)]
        return self.twins_sweep(GAP_YAML, [clearance_interface(n, pair, minimum) for n, pair, minimum in declared
                                           if minimum is not None], *options)

    def test_a_pair_requirement_above_the_gap_fails_and_one_below_it_passes(self) -> None:
        proc, result, rows = self.gap_sweep(1.0, 1.0)
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual((result["status"], result["collisions"], result["clearance_findings"]), ("fail", [], []))
        self.assertEqual(result["pairs"]["excluded_adjacent"], [["TST-0201", "@arm-a"], ["TST-0201", "@arm-b"]])
        for pair, (angle, index) in ((("@arm-a", "@arm-b"), (0.0, 2)), (("TST-0201", "@arm-a"), (-10.0, 0))):
            with self.subTest(pair=pair):
                row = rows[pair]
                self.assertEqual((row["status"], row["required_mm"], row["clearance_mm"], row["samples_below"]),
                                 ("fail", 1.0, 0.8, 3))
                self.assertEqual((row["independent_pose"], row["pose"]), ({"J-001": angle},) * 2)
                self.assertEqual(row["sample"], {"index": index, "source": "sweep:J-001"})
        self.assertEqual((rows[("@arm-a", "@arm-b")]["interface"], rows[("@arm-a", "@arm-b")]["source"]),
                         ("IF-001", "interfaces.yaml#/interfaces/0"))
        proc, result, rows = self.gap_sweep(0.5, 0.5)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(result["status"], "pass")
        self.assertEqual({pair: (row["status"], row["clearance_mm"], row["samples_below"]) for pair, row in rows.items()},
                         {("@arm-a", "@arm-b"): ("pass", 0.8, 0), ("TST-0201", "@arm-a"): ("pass", 0.8, 0)})

    def test_a_pair_clearance_option_overrides_the_record_or_adds_a_requirement(self) -> None:
        proc, _, rows = self.gap_sweep(0.5, None, "--pair-clearance", "@arm-a:@arm-b=1.0",
                                       "--pair-clearance", "TST-0201:@arm-a=0.75")
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        between, plate = rows[("@arm-a", "@arm-b")], rows[("TST-0201", "@arm-a")]
        self.assertEqual((between["status"], between["required_mm"], between["clearance_mm"]), ("fail", 1.0, 0.8))
        self.assertEqual((between["source"], between["overrides"]),
                         ("--pair-clearance @arm-a:@arm-b=1.0", "interfaces.yaml#/interfaces/0"))
        self.assertEqual((plate["status"], plate["required_mm"], plate["source"]),
                         ("pass", 0.75, "--pair-clearance TST-0201:@arm-a=0.75"))
        self.assertNotIn("overrides", plate)

    def test_an_unresolved_requirement_reference_is_a_usage_error(self) -> None:
        proc, result, _ = self.gap_sweep(0.5, None, "--pair-clearance", "@arm-a:@arm-z=1.0")
        self.assertEqual((proc.returncode, result), (2, {}), proc.stderr[-2000:])
        self.assertIn("--pair-clearance @arm-a:@arm-z=1.0", proc.stderr)
        self.assertIn("@arm-z", proc.stderr)

    def test_a_fitted_pair_inherits_no_min_clearance_but_keeps_its_own_requirement(self) -> None:
        proc, result, _ = self.twins_sweep(TOUCH_YAML, [], "--min-clearance", "0.5")
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual([(f["pair"], f["clearance_mm"]) for f in result["clearance_findings"]],
                         [(["@arm-a", "@arm-b"], 0.0)])
        proc, result, _ = self.twins_sweep(TOUCH_YAML, [HEAT_SET], "--min-clearance", "0.5")
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual((result["status"], result["clearance_findings"], result["collisions"]), ("pass", [], []))
        self.assertEqual((result["pairs"]["checked"], result["pairs"]["declared_fit"]),
                         ([["@arm-a", "@arm-b"]], [["@arm-a", "@arm-b"]]))
        self.assertEqual(result["min_clearance"][0]["clearance_mm"], 0.0)
        proc, result, rows = self.twins_sweep(TOUCH_YAML, [HEAT_SET, clearance_interface(2, ["@arm-a", "@arm-b"], 0.5)],
                                              "--min-clearance", "0.5")
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual(result["clearance_findings"], [])
        row = rows[("@arm-a", "@arm-b")]
        self.assertEqual((row["status"], row["required_mm"], row["clearance_mm"], row["independent_pose"]),
                         ("fail", 0.5, 0.0, {"J-001": 0.0}))

    def test_the_minimum_clearance_worst_case_follows_the_tightest_requirement(self) -> None:
        proc, result, _ = self.gap_sweep(None, None, "--worst-criterion", "minimum_clearance")
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        worst = result["worst_case"]
        self.assertEqual((worst["pair"], worst["independent_pose"], worst["clearance_mm"], worst["required_mm"],
                          worst["requirement"], worst["margin_mm"]),
                         (["@arm-a", "@arm-b"], {"J-001": 0.0}, 0.8, 0.0, "--min-clearance", 0.8))

    def test_an_incomplete_sweep_does_not_publish_a_version_bundle(self) -> None:
        hw, _ = self.sealed_planar_version()
        args = ("--hw", str(hw), "--version", "v1", "--case", "incomplete", "--steps", "5", "--grid", "0",
                "--time-limit", "0")
        proc, result = self.run_script("sweep.py", *args)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("sweep incomplete", proc.stderr)
        self.assertFalse((hw / "motion" / "v1" / "incomplete").exists())

    def test_pose_refuses_a_dependent_joint(self) -> None:
        out = self.root / "v6-dependent.step"
        proc, _ = self.run_script("pose.py", "--hw", str(self.v6_hw(None)), "--parts-dir", str(self.v6),
                                  "--set", "J-013=-1", "--out", str(out))
        self.assertEqual(proc.returncode, 2, proc.stderr[-2000:])
        self.assertIn("J-013 follows J-001 (slider_crank cylinder-3 displacement) and cannot be set", proc.stderr)
        self.assertFalse(out.exists())

    def test_pose_does_not_overwrite_an_existing_scratch_output(self) -> None:
        hw = self.hw(90)
        output = hw.parent / ".cad-work" / "motion-tests" / "posed.step"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"original")
        proc, _ = self.run_script("pose.py", "--hw", str(hw), "--parts-dir", str(self.planar),
                                  "--set", "J-001=30", "--out", str(output), adapt_outputs=False)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(output.read_bytes(), b"original")

    def test_a_part_buried_in_a_solid_or_a_compound_part_is_a_collision(self) -> None:
        hw = Path(tempfile.mkdtemp(dir=self.root))
        (hw / "assembly.yaml").write_text(NEST_YAML, encoding="utf-8")
        for container in ("solid", "compound"):
            with self.subTest(container=container):
                parts = self.root / "fx" / "nest" / container
                proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(parts), "--steps", "3",
                                               "--grid", "0", "--include-pair", "TST-0301:TST-0302",
                                               "--worst-step", str(hw / "worst.step"))
                self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
                self.assertEqual(result["collision_pose_count"], 3, result["collisions"])
                for collision in result["collisions"]:
                    self.assertEqual([hit["pair"] for hit in collision["pairs"]], [["TST-0301", "TST-0302"]])
                    self.assertAlmostEqual(collision["pairs"][0]["volume_mm3"], 8.0, places=3)
                self.assertEqual([row["clearance_mm"] for row in result["min_clearance"]], [0.0])

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
        hw = shutil.copytree(TEMPLATE_HW, Path(tempfile.mkdtemp(dir=self.root)) / "hw")  # scratch lands beside it
        proc, result = self.run_script("pose.py", "--hw", str(hw), "--step", str(self.lamp / "lamp-arm.step"),
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

    def test_the_bounds_hold_and_the_broad_phase_containment_skip_and_threads_change_no_measured_value(self) -> None:
        """fixtures/measure_probe.py over every fixture pair at seeded placements: box gap and motion
        bound <= distance; a pair measured with its gap (no containment test past SOLID_GAP_MM) or on
        OCCT's thread pool is bitwise unchanged; pruned and full runs agree, and each pruned request
        lies beyond its group minimum and threshold."""
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(HERE / "fixtures" / "measure_probe.py"),
                               str(self.root / "fx")], capture_output=True, text=True, check=False, timeout=900)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        report = json.loads(proc.stdout)
        self.assertEqual((report["bound_violations"], report["mismatches"], report["thread_mismatches"],
                          report["prune_violations"]), ([], [], [], []))
        self.assertGreater(report["wrapped"], report["compared"] // 2, report)
        self.assertGreater(report["pruned"], report["requests"] // 10, report)
        self.assertEqual(report["buried"]["gap"], 0.0)
        self.assertEqual(report["buried"]["result"][0], 0.0)
        self.assertAlmostEqual(report["buried"]["result"][1], 8.0, places=6)

    def test_the_mesh_bounds_hold_and_fast_mode_clears_only_pairs_proved_beyond_the_band(self) -> None:
        """fixtures/mesh_probe.py: every sampled face point lies within its mesh's deviation; every
        measured distance lies in its mesh interval; a pin in a block's void keeps a bound, a buried or
        touching one does not; fast mode measures what the exact run does bitwise and every cleared
        pair-pose, measured exactly, lies in its bounds, unoverlapped, beyond its threshold plus the
        band; a pair just outside the band reports bounds that bracket its exact minimum."""
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(HERE / "fixtures" / "mesh_probe.py"),
                               str(self.root / "fx")], capture_output=True, text=True, check=False, timeout=1800)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        report = json.loads(proc.stdout)
        deviation, intervals, fast = report["deviation"], report["intervals"], report["fast"]
        self.assertEqual((deviation["violations"], intervals["violations"], fast["mismatches"], fast["violations"]),
                         ([], [], [], []))
        self.assertGreater(deviation["samples"], 5000, deviation)
        self.assertLess(deviation["max_ratio"], 1.0, deviation)  # within the linear deflection, half the deviation
        self.assertGreater(intervals["informative"], intervals["compared"] // 2, intervals)
        self.assertGreater(fast["cleared_mesh"], 100, fast)
        self.assertLess(fast["max_abs_mesh_minus_exact_mm"], 0.04, fast)
        cases = report["containment"]
        void = cases["void"]
        self.assertEqual((void["distance"], void["volume"]), (2.0, 0.0))
        self.assertGreater(void["lower"], 1.9)
        self.assertLessEqual(void["lower"], void["distance"])
        for name in ("embedded", "touching", "nest/solid", "nest/compound"):
            with self.subTest(case=name):
                self.assertEqual((cases[name]["lower"], cases[name]["distance"]), (0.0, 0.0))
                self.assertGreaterEqual(cases[name]["upper"], 0.0)
        self.assertAlmostEqual(cases["embedded"]["volume"], 2 * math.pi * 3, places=3)  # the whole r 1 x 6 pin
        bracket = report["bracket"]
        self.assertTrue(bracket["all_mesh"] and bracket["brackets"], bracket)
        self.assertLess(bracket["box_gap_minimum"], bracket["band"])  # the box gap alone clears none of it
        self.assertLess(bracket["outside_by"], 0.1, bracket)
        freeform = report["freeform"]
        self.assertEqual(freeform["violations"], [])
        self.assertGreater(freeform["faces"].get("BSplineSurface", 0), 0, freeform)
        self.assertGreater(freeform["samples"], 1000, freeform)
        self.assertLess(freeform["max_ratio"], 2.0, freeform)  # mesh_bound.DEVIATION_FACTOR x the deflection

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

    def twins_sweep(self, assembly: str, interfaces: list[dict], *options: str):
        """Sweep `assembly` over the twins geometry (J-001 at -10, -5 and 0 deg) with `interfaces` as
        hw/interfaces.yaml; returns the process, the result and its pair_clearance rows by pair."""
        import yaml

        hw = self.twins(assembly)
        (hw / "interfaces.yaml").write_text(yaml.safe_dump({"interfaces": interfaces}), encoding="utf-8")
        proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.root / "fx" / "twins"),
                                       "--steps", "3", "--grid", "0", *options, "--worst-step", str(hw / "worst.step"))
        return proc, result, {tuple(row["pair"]): row for row in result.get("pair_clearance", [])}

    def gap_sweep(self, between: float | None, plate: float | None, *options: str):
        """Sweep GAP_YAML requiring `between` mm for @arm-a / @arm-b and `plate` mm for the
        joint-connected TST-0201 / @arm-a (None: no requirement)."""
        declared = [(1, ["@arm-a", "@arm-b"], between), (2, ["TST-0201", "@arm-a"], plate)]
        return self.twins_sweep(GAP_YAML, [clearance_interface(n, pair, minimum) for n, pair, minimum in declared
                                           if minimum is not None], *options)

    def test_a_pair_requirement_above_the_gap_fails_and_one_below_it_passes(self) -> None:
        proc, result, rows = self.gap_sweep(1.0, 1.0)
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual((result["status"], result["collisions"], result["clearance_findings"]), ("fail", [], []))
        # The plate and @arm-a are joint-connected, so no collision pair, but their requirement still holds.
        self.assertEqual(result["pairs"]["excluded_adjacent"], [["TST-0201", "@arm-a"], ["TST-0201", "@arm-b"]])
        # The arms are closest at J-001 = 0, the last sample; the plate gap is 0.8 mm at every sample,
        # so the earliest, J-001 = -10, keeps the tie.
        for pair, (angle, index) in ((("@arm-a", "@arm-b"), (0.0, 2)), (("TST-0201", "@arm-a"), (-10.0, 0))):
            with self.subTest(pair=pair):
                row = rows[pair]
                self.assertEqual((row["status"], row["required_mm"], row["clearance_mm"], row["samples_below"]),
                                 ("fail", 1.0, 0.8, 3))
                self.assertEqual((row["independent_pose"], row["pose"]), ({"J-001": angle},) * 2)
                self.assertEqual(row["sample"], {"index": index, "source": "sweep:J-001"})
        self.assertEqual((rows[("@arm-a", "@arm-b")]["interface"], rows[("@arm-a", "@arm-b")]["source"]),
                         ("IF-001", "interfaces.yaml#/interfaces/0"))

        proc, result, rows = self.gap_sweep(0.5, 0.5)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual(result["status"], "pass")
        self.assertEqual({pair: (row["status"], row["clearance_mm"], row["samples_below"]) for pair, row in rows.items()},
                         {("@arm-a", "@arm-b"): ("pass", 0.8, 0), ("TST-0201", "@arm-a"): ("pass", 0.8, 0)})

    def test_a_pair_clearance_option_overrides_the_record_or_adds_a_requirement(self) -> None:
        proc, result, rows = self.gap_sweep(0.5, None, "--pair-clearance", "@arm-a:@arm-b=1.0",
                                            "--pair-clearance", "TST-0201:@arm-a=0.75")
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        between, plate = rows[("@arm-a", "@arm-b")], rows[("TST-0201", "@arm-a")]
        self.assertEqual((between["status"], between["required_mm"], between["clearance_mm"]), ("fail", 1.0, 0.8))
        self.assertEqual((between["source"], between["overrides"]),
                         ("--pair-clearance @arm-a:@arm-b=1.0", "interfaces.yaml#/interfaces/0"))
        self.assertEqual((plate["status"], plate["required_mm"], plate["source"]),
                         ("pass", 0.75, "--pair-clearance TST-0201:@arm-a=0.75"))
        self.assertNotIn("overrides", plate)

    def test_an_unresolved_requirement_reference_is_a_usage_error(self) -> None:
        proc, result, _ = self.gap_sweep(0.5, None, "--pair-clearance", "@arm-a:@arm-z=1.0")
        self.assertEqual((proc.returncode, result), (2, {}), proc.stderr[-2000:])
        self.assertIn("--pair-clearance @arm-a:@arm-z=1.0", proc.stderr)
        self.assertIn("@arm-z", proc.stderr)

    def test_a_fitted_pair_inherits_no_min_clearance_but_keeps_its_own_requirement(self) -> None:
        proc, result, _ = self.twins_sweep(TOUCH_YAML, [], "--min-clearance", "0.5")
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual([(f["pair"], f["clearance_mm"]) for f in result["clearance_findings"]],
                         [(["@arm-a", "@arm-b"], 0.0)])

        # Declared as a heat-set insert, the 0 mm pair passes the global 0.5 mm running clearance.
        proc, result, _ = self.twins_sweep(TOUCH_YAML, [HEAT_SET], "--min-clearance", "0.5")
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertEqual((result["status"], result["clearance_findings"], result["collisions"]), ("pass", [], []))
        self.assertEqual((result["pairs"]["checked"], result["pairs"]["declared_fit"]),
                         ([["@arm-a", "@arm-b"]], [["@arm-a", "@arm-b"]]))
        self.assertEqual(result["min_clearance"][0]["clearance_mm"], 0.0)  # still reported

        # An explicit 0.5 mm requirement on that fitted pair still holds.
        proc, result, rows = self.twins_sweep(TOUCH_YAML, [HEAT_SET, clearance_interface(2, ["@arm-a", "@arm-b"], 0.5)],
                                              "--min-clearance", "0.5")
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual(result["clearance_findings"], [])
        row = rows[("@arm-a", "@arm-b")]
        self.assertEqual((row["status"], row["required_mm"], row["clearance_mm"], row["independent_pose"]),
                         ("fail", 0.5, 0.0, {"J-001": 0.0}))

    def test_the_minimum_clearance_worst_case_follows_the_tightest_requirement(self) -> None:
        criterion = ("--worst-criterion", "minimum_clearance")
        proc, result, _ = self.gap_sweep(None, None, *criterion)
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        worst = result["worst_case"]
        self.assertEqual((worst["pair"], worst["independent_pose"], worst["clearance_mm"], worst["required_mm"],
                          worst["requirement"], worst["margin_mm"]),
                         (["@arm-a", "@arm-b"], {"J-001": 0.0}, 0.8, 0.0, "--min-clearance", 0.8))

        # 1 mm on the plate gap (0.8 mm at every sample) is the tightest margin: -0.2 mm, the earliest sample.
        proc, result, _ = self.gap_sweep(None, 1.0, *criterion)
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        worst = result["worst_case"]
        self.assertEqual((worst["pair"], worst["independent_pose"], worst["clearance_mm"], worst["required_mm"],
                          worst["requirement"], worst["margin_mm"]),
                         (["TST-0201", "@arm-a"], {"J-001": -10.0}, 0.8, 1.0, "interfaces.yaml#/interfaces/0", -0.2))
        evidence = json.loads(Path(worst["evidence"]).read_text(encoding="utf-8"))
        self.assertEqual((evidence["pair"], evidence["metric"]["requirement"]),
                         (["TST-0201", "@arm-a"], "interfaces.yaml#/interfaces/0"))

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

    def sealed_planar_version(self) -> tuple[Path, Path]:
        """A verified v1 version with the canonical record snapshot and zero-pose definitions."""
        import hashlib

        hw = self.hw(90)
        version = hw / "versions" / "v1"
        shutil.copytree(self.planar, version / "parts")
        record = version / "record"
        record.mkdir(parents=True)
        (record / "product.yaml").write_text("id: planar-test\n", encoding="utf-8")
        (record / "assembly.yaml").write_text(PLANAR_YAML.format(j2_max=90), encoding="utf-8")
        (record / "interfaces.yaml").write_text("interfaces: []\n", encoding="utf-8")
        parts = record / "parts"
        for pn, title in (("TST-0001", "Ground link"), ("TST-0002", "Middle link"), ("TST-0003", "Tip link")):
            (parts / pn).mkdir(parents=True)
            (parts / pn / "part.yaml").write_text(f"PN: {pn}\ntitle: {title}\nmodel_frame: assembly_zero\n",
                                                   encoding="utf-8")
        files = {path.relative_to(version).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in sorted(version.rglob("*")) if path.is_file()}
        (version / "manifest.json").write_text(json.dumps({"label": "v1", "files": files}), encoding="utf-8")
        (hw / "versions" / "latest.json").write_text(json.dumps({"label": "v1"}), encoding="utf-8")
        return hw, version

    def test_a_sweep_refuses_to_start_while_a_recorded_sweep_group_still_runs(self) -> None:
        hw, _ = self.sealed_planar_version()
        holder = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        self.addCleanup(holder.wait)
        self.addCleanup(holder.kill)
        lock = hw / "motion" / "v1" / ".sweep-locked.json"
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text(json.dumps({"pgid": holder.pid, "pid": holder.pid}), encoding="utf-8")
        proc, _ = self.run_script("sweep.py", "--hw", str(hw), "--version", "v1", "--case", "locked", "--steps", "3",
                                  "--grid", "0")
        self.assertEqual(proc.returncode, 2, proc.stderr[-2000:])
        self.assertIn(f"kill -TERM -- -{holder.pid}", proc.stderr)
        holder.kill()
        holder.wait()
        proc, _ = self.run_script("sweep.py", "--hw", str(hw), "--version", "v1", "--case", "locked", "--steps", "3",
                                  "--grid", "0")
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assertFalse(lock.exists())  # a finished sweep removes its record

    def test_versioned_sweep_reuses_and_replaces_without_changing_old_bundle(self) -> None:
        hw, version = self.sealed_planar_version()
        common = ("--hw", str(hw), "--version", "v1", "--case", "sweep-test", "--steps", "3", "--grid", "0")
        first, published = self.run_script("sweep.py", *common)
        self.assertEqual(first.returncode, 0, first.stderr[-2000:])
        bundle = hw / "motion" / "v1" / "sweep-test"
        self.assertEqual(published["bundle"], str(bundle))
        before = {path.relative_to(bundle).as_posix(): path.read_bytes() for path in bundle.rglob("*") if path.is_file()}
        second, reused = self.run_script("sweep.py", *common)
        self.assertEqual(second.returncode, 0, second.stderr[-2000:])
        self.assertTrue(reused["reused"])
        conflict, _ = self.run_script("sweep.py", *common, "--steps", "5")
        self.assertEqual(conflict.returncode, 2)
        self.assertIn("--replace", conflict.stderr)
        replaced, summary = self.run_script("sweep.py", *common, "--steps", "5", "--replace")
        self.assertEqual(replaced.returncode, 0, replaced.stderr[-2000:])
        replaced_files = {path.relative_to(bundle).as_posix(): path.read_bytes() for path in bundle.rglob("*")
                          if path.is_file()}
        self.assertNotEqual(before["manifest.json"], replaced_files["manifest.json"])
        manifest = json.loads(replaced_files["manifest.json"])
        self.assertTrue(manifest["replaces"]["moved_to"].startswith(".cad-work/replaced/"))
        old = hw.parent / manifest["replaces"]["moved_to"]
        old_files = {path.relative_to(old).as_posix(): path.read_bytes() for path in old.rglob("*") if path.is_file()}
        self.assertEqual(old_files, before)
        layout_path = Path(__file__).resolve().parents[2] / "cad-record" / "scripts" / "layout.py"
        spec = importlib.util.spec_from_file_location("cad_record_layout", layout_path)
        self.assertIsNotNone(spec)
        layout = sys.modules.get("cad_record_layout")
        if layout is None:
            layout = importlib.util.module_from_spec(spec)
            sys.modules["cad_record_layout"] = layout
            spec.loader.exec_module(layout)
        self.assertEqual(layout.verify(bundle), [])
        self.assertEqual(summary["status"], "pass")

    def test_versioned_pose_publishes_and_reuses_bundle(self) -> None:
        hw, _ = self.sealed_planar_version()
        common = ("--hw", str(hw), "--version", "v1", "--case", "TST-0001", "--set", "J-001=30")
        first, published = self.run_script("pose.py", *common)
        self.assertEqual(first.returncode, 0, first.stderr[-2000:])
        self.assertEqual((hw / "motion" / "v1" / "TST-0001" / "pose.step").is_file(), True)
        second, reused = self.run_script("pose.py", *common)
        self.assertEqual(second.returncode, 0, second.stderr[-2000:])
        self.assertTrue(reused["reused"])
        self.assertEqual(published["bundle"], reused["bundle"])

    def test_explicit_motion_outputs_outside_cad_work_are_refused(self) -> None:
        hw = self.hw(90)
        outside = self.root / "outside.step"
        pose_run, _ = self.run_script("pose.py", "--hw", str(hw), "--parts-dir", str(self.planar),
                                      "--set", "J-001=30", "--out", str(outside), adapt_outputs=False)
        self.assertEqual(pose_run.returncode, 2)
        self.assertFalse(outside.exists())
        sweep_run, _ = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.planar),
                                       "--steps", "3", "--grid", "0", "--worst-step", str(outside),
                                       adapt_outputs=False)
        self.assertEqual(sweep_run.returncode, 2)
        self.assertFalse(outside.exists())

    def test_a_version_sweeps_like_its_parts_dir(self) -> None:
        hw, _ = self.sealed_planar_version()
        common = ("--hw", str(hw), "--steps", "5", "--grid", "3")
        by_version, a = self.run_script("sweep.py", *common, "--version", "v1", "--case", "version-test")
        by_dir, b = self.run_script("sweep.py", *common, "--parts-dir", str(hw / "versions" / "v1" / "parts"),
                                    "--worst-step", str(self.root / "version-parts.step"))
        self.assertEqual((by_version.returncode, by_dir.returncode), (0, 0),
                         by_version.stderr[-2000:] + by_dir.stderr[-2000:])
        for key in ("status", "poses", "pairs", "collisions", "min_clearance", "reach_envelope"):
            self.assertEqual(a[key], b[key], key)
        self.assertEqual((a["worst_case"]["pose"], a["worst_case"]["reach_mm"]),
                         (b["worst_case"]["pose"], b["worst_case"]["reach_mm"]))
        self.assertIn("--version v1", a["worst_case"]["command"])

    def test_latest_resolves_through_latest_json_and_an_unbuilt_version_is_refused(self) -> None:
        hw, _ = self.sealed_planar_version()
        latest, latest_result = self.run_script("pose.py", "--hw", str(hw), "--version", "latest",
                                                "--set", "J-002=90", "--case", "latest-pose")
        by_dir, dir_result = self.run_script("pose.py", "--hw", str(hw), "--parts-dir", str(self.planar),
                                             "--set", "J-002=90", "--out", str(self.root / "latest-scratch.step"))
        self.assertEqual((latest.returncode, by_dir.returncode), (0, 0), latest.stderr[-2000:])
        self.assertEqual(latest_result["placements"], dir_result["placements"])
        proc, _ = self.run_script("pose.py", "--hw", str(hw), "--version", "v2", "--case", "unbuilt")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("not a built version", proc.stderr)

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

    def v6_sweep(self, misphased: int | None, criterion: str,
                 *options: str) -> tuple[Path, subprocess.CompletedProcess[str], dict]:
        """The one-driver sweep of the V6 doc: 145 samples, 5 crank degrees apart, no grid, with every
        valve required to keep VALVE_GAP from its piston (v6_record.interfaces)."""
        import yaml

        hw = self.v6_hw(misphased)
        (hw / "interfaces.yaml").write_text(yaml.safe_dump(v6_record.interfaces(), sort_keys=False), encoding="utf-8")
        proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.v6), "--steps", "145",
                                       "--grid", "0", "--worst-criterion", criterion,
                                       "--worst-step", str(hw / "worst.step"), *options)
        return hw, proc, result

    def test_worker_processes_report_exactly_what_one_process_does(self) -> None:
        """The tie-sensitive minimum_clearance worst case of the V6 sweep, in one process and in three
        workers: the same JSON, evidence and worst-case STEP."""
        runs = [self.v6_sweep(None, "minimum_clearance", "--jobs", jobs) for jobs in ("1", "3")]
        for hw, proc, _ in runs:
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        self.assert_same_sweeps([(hw, result) for hw, _, result in runs])

    def test_a_cold_and_a_warm_pair_cache_report_exactly_what_no_cache_does(self) -> None:
        """The cold run fills the cache and the warm one measures nothing; all three report the same
        JSON, evidence and worst-case STEP. Exact mode: fast mode clears every pair of this fixture."""
        hw, cache = self.hw(90), Path(tempfile.mkdtemp(dir=self.root))
        runs = []
        for option in (["--no-cache"], ["--cache", str(cache)], ["--cache", str(cache)]):
            out = Path(tempfile.mkdtemp(dir=self.root))
            proc, result = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.planar), "--steps", "5",
                                           "--grid", "3", "--worst-criterion", "minimum_clearance", "--exact",
                                           "--worst-step", str(out / "worst.step"), *option)
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            runs.append((out, result))
        cold, warm = runs[1][1]["timings_s"], runs[2][1]["timings_s"]
        self.assertGreater(cold["pair_evaluations"], 0)
        self.assertEqual((runs[0][1]["timings_s"]["disk_hits"], cold["disk_hits"]), (0, 0))
        self.assertEqual((warm["pair_evaluations"], warm["disk_hits"]), (0, cold["pair_evaluations"]))
        self.assert_same_sweeps(runs)

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
        self.assertIn("/.cad-work/test-output/", worst["command"])
        self.assertEqual(worst["command"].count("--set"), 1)

        # Valve 3 breaks its 1 mm requirement wherever lift + displacement > 0, the 11 samples around
        # its TDC; deepest, 18 mm^3 at crank 240, where 0 mm ties the other overlaps. At crank 600, its
        # other TDC, the closed valve sits exactly 1 mm above the crown, which passes.
        requirements = {tuple(sorted(row["pair"])): row for row in result["pair_clearance"]}
        below = [q for q in range(0, 721, 5) if misphased_depth(q) > -v6_record.VALVE_GAP + 1e-9]
        self.assertEqual(below, list(range(215, 266, 5)))
        valve = requirements[("@piston-3", "@valve-3")]
        self.assertEqual(result["pair_clearance"][0], valve)  # smallest margin first
        self.assertEqual((valve["status"], valve["required_mm"], valve["clearance_mm"], valve["samples_below"]),
                         ("fail", 1.0, 0.0, len(below)))
        self.assertEqual((valve["independent_pose"], valve["sample"]), ({"J-001": 240.0}, {"index": 48, "source": "sweep:J-001"}))
        self.assertAlmostEqual(valve["overlap_mm3"], 18.0, places=3)
        self.assertEqual(valve["pose"]["J-043"], 3.0)
        self.assertEqual({pair: row["status"] for pair, row in requirements.items() if pair != ("@piston-3", "@valve-3")},
                         {(f"@piston-{c}", f"@valve-{c}"): "pass" for c in (1, 2, 4, 5, 6)})

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
        # The tightest margin is a valve's: exactly its 1 mm requirement, 0 mm to spare, first at crank 0,
        # where cylinders 1 and 4 are at TDC; the smallest unrequired gap (--min-clearance 0) is wider.
        worst = result["worst_case"]
        self.assertEqual((worst["criterion"], worst["required_mm"], worst["margin_mm"], worst["overlap_mm3"]),
                         ("minimum_clearance", 1.0, 0.0, 0.0))
        self.assertEqual((worst["pair"], worst["independent_pose"], worst["requirement"]),
                         (["@piston-1", "@valve-1"], {"J-001": 0.0}, "interfaces.yaml#/interfaces/0"))
        self.assertGreater(result["min_clearance"][0]["clearance_mm"], 0.0)
        self.assertTrue((hw / "worst.step.json").is_file())

        # Each valve keeps exactly its 1 mm requirement, closed at its cylinder's first TDC.
        requirements = {tuple(sorted(row["pair"])): row for row in result["pair_clearance"]}
        self.assertEqual(len(requirements), 6)
        for cylinder, _, _, phase in v6_record.CYLINDERS:
            row = requirements[(f"@piston-{cylinder}", f"@valve-{cylinder}")]
            self.assertEqual((row["status"], row["required_mm"], row["clearance_mm"], row["samples_below"]),
                             ("pass", 1.0, 1.0, 0), cylinder)
            self.assertEqual(row["independent_pose"], {"J-001": -phase % 360}, cylinder)

    def test_fast_and_exact_v6_sweeps_agree_on_every_verdict_and_every_exact_row(self) -> None:
        """The V6 sweep with --exact, then in fast mode with a 0.5 mm band from a cold and a warm pair
        cache (with --spot-check): the same collisions, findings, worst case and requirement rows;
        every exact row of the fast run is the exact run's; every bounded row, mesh-bounded ones
        among them, brackets the exact minimum; the spot check passes; the warm run measures nothing
        and reports what the cold one does."""
        cache = Path(tempfile.mkdtemp(dir=self.root))
        _, proc, exact = self.v6_sweep(None, "minimum_clearance", "--exact")
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        runs = []
        for _ in range(2):
            hw, proc, result = self.v6_sweep(None, "minimum_clearance", "--mesh-band", "0.5", "--cache", str(cache))
            self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
            runs.append((hw, result))
        self.assert_same_sweeps(runs)
        cold, warm = runs[0][1], runs[1][1]
        self.assertEqual((warm["timings_s"]["pair_evaluations"], warm["timings_s"]["disk_hits"]),  # the spot check's too
                         (0, cold["timings_s"]["pair_evaluations"] + cold["spot_check"]["checked"]))
        self.assertLess(cold["timings_s"]["pair_evaluations"], exact["timings_s"]["pair_evaluations"] // 10)
        self.assertGreater(cold["timings_s"]["cleared_mesh"], 0)
        self.assertEqual((exact["broad_phase"]["mode"], cold["broad_phase"]["mode"], cold["broad_phase"]["band_mm"]),
                         ("exact", "fast", 0.5))
        for key in ("status", "collisions", "limit_findings", "clearance_findings", "suspect_measurements",
                    "pair_clearance"):  # every requirement's minimum lies within the band
            self.assertEqual(cold[key], exact[key], key)
        worst = lambda result: {k: v for k, v in result["worst_case"].items()  # noqa: E731
                                if k not in ("step", "step_sha256", "evidence", "command")}
        self.assertEqual(worst(cold), worst(exact))
        rows = {tuple(row["pair"]): row for row in exact["min_clearance"]}
        self.assertEqual({row["method"] for row in exact["min_clearance"]}, {"exact"})
        methods = {"exact": 0, "box": 0, "mesh": 0}
        for row in cold["min_clearance"]:
            methods[row["method"]] += 1
            want = rows[tuple(row["pair"])]
            if row["method"] == "exact":
                self.assertEqual(row, want)
            else:
                low, high = row["bound_mm"]
                self.assertLessEqual(low, want["clearance_mm"] + 1e-4, row)
                self.assertTrue(high is None or want["clearance_mm"] <= high + 1e-4, row)
                self.assertGreater(low, 0.5, row)  # beyond --min-clearance 0 by more than the band
        self.assertGreater(methods["exact"], 0)
        self.assertGreater(methods["box"] + methods["mesh"], methods["exact"])
        spot = cold["spot_check"]
        self.assertEqual(spot["failures"], [])
        self.assertGreater(spot["checked"], 0)
        self.assertLess(spot["max_abs_mesh_minus_exact_mm"], 0.04)

    def test_pose_refuses_a_dependent_joint(self) -> None:
        out = self.root / "v6-dependent.step"
        proc, _ = self.run_script("pose.py", "--hw", str(self.v6_hw(None)), "--parts-dir", str(self.v6),
                                  "--set", "J-013=-1", "--out", str(out))
        self.assertEqual(proc.returncode, 2, proc.stderr[-2000:])
        self.assertIn("J-013 follows J-001 (slider_crank cylinder-3 displacement) and cannot be set", proc.stderr)
        self.assertFalse(out.exists())

    def test_scratch_outputs_cannot_be_overwritten(self) -> None:
        hw = self.hw(90)
        outside = self.root / "w-stale.step"
        outside.write_bytes(b"original")
        proc, _ = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.planar),
                                  "--steps", "5", "--grid", "0", "--worst-step", str(outside),
                                  adapt_outputs=False)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(outside.read_bytes(), b"original")
        scratch = hw.parent / ".cad-work" / "motion-tests" / "w-stale.step"
        scratch.parent.mkdir(parents=True, exist_ok=True)
        scratch.write_bytes(b"original")
        proc, _ = self.run_script("sweep.py", "--hw", str(hw), "--parts-dir", str(self.planar),
                                  "--steps", "5", "--grid", "0", "--worst-step", str(scratch),
                                  adapt_outputs=False)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(scratch.read_bytes(), b"original")

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
