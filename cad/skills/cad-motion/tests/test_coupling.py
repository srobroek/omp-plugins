#!/usr/bin/env python3
"""cad-motion coupling tests: the laws, their DAG and its rejections, and coupled chains; needs no OCP.

Expected values are worked out by hand or from the mechanism's geometry (the rod's crank end must land on
the crankpin), never by calling the law under test.

Run: python3 -m unittest discover -s cad/skills/cad-motion/tests -v
"""

from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import math
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(HERE / "fixtures"))
import v6_record  # noqa: E402 - the kernel-free V6-like record


def load(name: str, path: Path):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pose = load("cad_motion_pose", SCRIPTS / "pose.py")
sweep = load("cad_motion_sweep", SCRIPTS / "sweep.py")
freecad_assembly = load("cad_motion_freecad", SCRIPTS / "freecad_assembly.py")
coupling = pose.coupling
SQRT3_2 = math.sqrt(3.0) / 2.0


def revolute(jid: str, low: float, high: float, **extra) -> dict:
    return {"id": jid, "type": "revolute", "parent": "TST-0001", "child": f"TST-{int(jid[2:]) + 1:04d}",
            "axis": [0, 0, 1], "origin": [0, 0, 0], "min": low, "max": high, **extra}


def chain_of(data: dict):
    """The chain pose.py builds from an assembly.yaml mapping, with every part modeled in place."""
    frames = {pn: frame for pn, (_, frame) in v6_record.PARTS.items()}
    inventory = pose.assembly_data.normalize(data, frames)
    assembly = pose.Assembly(inventory, (), frames)
    joints = [pose.make_joint(raw, assembly.attachable) for raw in data["joints"]]
    return pose.build_chain(joints, inventory.occurrences, couplings=coupling.parse(data))


def problems(data: dict) -> list[str]:
    with unittest.TestCase().assertRaises(coupling.CouplingError) as caught:
        coupling.parse(data)
    return caught.exception.problems


class LinearLaw(unittest.TestCase):
    def test_ratio_and_offset_keep_a_720_degree_driver_unwrapped(self) -> None:
        for ratio, offset, expected in ((0.5, 0.0, (0.0, 180.0, 360.0)), (-0.5, 0.0, (0.0, -180.0, -360.0)),
                                        (0.5, 10.0, (10.0, 190.0, 370.0)), (-0.5, -15.0, (-15.0, -195.0, -375.0))):
            law = coupling.parse({"joints": [revolute("J-001", 0, 720, nominal=0),
                                             revolute("J-002", -400, 400, coupling={
                                                 "type": "linear", "driver": "J-001", "ratio": ratio, "offset": offset})]})
            with self.subTest(ratio=ratio, offset=offset):
                got = tuple(law.derive({"J-001": q})["J-002"] for q in (0.0, 360.0, 720.0))
                self.assertEqual(got, expected)

    def test_a_zero_ratio_is_refused(self) -> None:
        found = problems({"joints": [revolute("J-001", 0, 720, nominal=0),
                                     revolute("J-002", 0, 1, coupling={"type": "linear", "driver": "J-001", "ratio": 0})]})
        self.assertIn("J-002 coupling: ratio must be a finite non-zero number", found[0])


SEAM = {"input_unit": "deg", "output_unit": "deg", "period_deg": 360, "interpolation": "linear",
        "samples": [[0, 2], [90, 4], [270, 0], [360, 2]]}  # rises across the seam: 0 at 270 back to 2 at 360


class PeriodicTable(unittest.TestCase):
    def couplings(self, phase: float, profile: dict = SEAM):
        return coupling.parse({"profiles": {"seam": profile}, "joints": [
            revolute("J-001", 0, 720, nominal=0),
            revolute("J-002", -10, 10, coupling={"type": "periodic_table", "driver": "J-001", "profile": "seam",
                                                 "phase_deg": phase})]})

    def value(self, couplings, q: float) -> float:
        return couplings.derive({"J-001": q})["J-002"]

    def test_knots_are_exact_and_between_them_it_is_linear(self) -> None:
        law = self.couplings(0.0)
        for q, expected in ((0, 2), (90, 4), (270, 0), (360, 2), (45, 3), (180, 2), (315, 1)):
            with self.subTest(q=q):
                self.assertAlmostEqual(self.value(law, q), expected, places=12)

    def test_the_seam_repeats_at_0_360_and_720(self) -> None:
        law = self.couplings(0.0)
        for q in (0.0, 360.0, 720.0):
            self.assertAlmostEqual(self.value(law, q), 2.0, places=12)
        # 2 degrees either side of each seam: 0 + 2 * 88/90 before, 2 + 2 * 2/90 after.
        for seam in (360.0, 720.0):
            self.assertAlmostEqual(self.value(law, seam - 2), 2 * 88 / 90, places=12)
        for seam in (0.0, 360.0):
            self.assertAlmostEqual(self.value(law, seam + 2), 2 + 2 * 2 / 90, places=12)

    def test_a_negative_phase_wraps_below_zero(self) -> None:
        law = self.couplings(-20.0)
        self.assertAlmostEqual(self.value(law, 10.0), 2 * 80 / 90, places=12)  # table at 350
        self.assertAlmostEqual(self.value(law, 730.0), 2 * 80 / 90, places=12)
        self.assertAlmostEqual(self.value(law, 110.0), 4.0, places=12)  # the knot at 90

    def test_table_and_unit_rejections(self) -> None:
        cases = {
            "strictly increase": {**SEAM, "samples": [[0, 2], [90, 4], [90, 0], [360, 2]]},
            "run from 0 to period_deg": {**SEAM, "samples": [[10, 2], [360, 2]]},
            "closes on itself": {**SEAM, "samples": [[0, 2], [360, 3]]},
            "interpolation must be linear": {**SEAM, "interpolation": "cubic"},
            "outputs mm, but J-002 is a revolute joint in deg": {**SEAM, "output_unit": "mm"},
        }
        for message, profile in cases.items():
            with self.subTest(message=message):
                self.assertTrue(any(message in p for p in problems(
                    {"profiles": {"seam": profile}, "joints": self.couplings_raw()})), message)

    def couplings_raw(self) -> list[dict]:
        return [revolute("J-001", 0, 720, nominal=0),
                revolute("J-002", -10, 10, coupling={"type": "periodic_table", "driver": "J-001", "profile": "seam"})]

    def test_a_prismatic_driver_is_refused(self) -> None:
        joints = self.couplings_raw()
        joints[0] = {**joints[0], "type": "prismatic"}
        found = problems({"profiles": {"seam": SEAM}, "joints": joints})
        self.assertIn("a periodic table needs an angular (revolute) driver", found[0])


class SliderCrank(unittest.TestCase):
    """r = 13.565, L = 48.07: h(90) = sqrt(L^2 - r^2) = 46.116547..., asin(r/L) = 16.3907... deg."""

    H90 = math.sqrt(48.07 ** 2 - 13.565 ** 2)
    BETA90 = math.degrees(math.asin(13.565 / 48.07))

    def mechanism(self, side: int):
        data = v6_record.record()
        index = 0 if side == -1 else 1  # cylinder 1 (right bank, phase 0) or cylinder 2 (left bank, phase -120)
        spec = copy.deepcopy(data["mechanisms"][index])
        spec["phase_deg"] = 0
        data["mechanisms"][index] = spec
        return coupling.parse(data).mechanisms[spec["id"]]

    def test_displacement_and_rod_angle_at_the_quarter_turns_on_both_banks(self) -> None:
        expected = {0: (0.0, 0.0), 90: (self.H90 - 48.07 - 13.565, -self.BETA90),
                    180: (-27.13, 0.0), 270: (self.H90 - 48.07 - 13.565, self.BETA90)}
        for side in (-1, 1):
            mechanism = self.mechanism(side)
            for q, (s, beta) in expected.items():
                with self.subTest(side=side, q=q):
                    self.assertAlmostEqual(mechanism.displacement(q), s, places=9)
                    self.assertAlmostEqual(mechanism.rod_angle(q), beta, places=9)

    def test_crankpin_and_wrist_follow_each_bank_axis(self) -> None:
        r, wrist90 = 13.565, self.H90
        for side, n, t in ((-1, (0.0, 0.5, SQRT3_2), (0.0, -SQRT3_2, 0.5)),
                           (1, (0.0, -0.5, SQRT3_2), (0.0, -SQRT3_2, -0.5))):
            mechanism = self.mechanism(side)
            x = mechanism.origin[0]
            with self.subTest(side=side):
                assert_close(self, mechanism.crankpin(0), (x, r * n[1], r * n[2]))
                assert_close(self, mechanism.crankpin(90), (x, r * t[1], r * t[2]))
                assert_close(self, mechanism.crankpin(180), (x, -r * n[1], -r * n[2]))
                assert_close(self, mechanism.wrist(90), (x, wrist90 * n[1], wrist90 * n[2]))
                assert_close(self, mechanism.wrist(180), (x, (48.07 - r) * n[1], (48.07 - r) * n[2]))

    def test_posed_rods_close_on_crankpin_and_wrist_pin(self) -> None:
        """The rod's crank end (local [0, 0, -L]) lands on the crank's own crankpin, and its wrist on the
        piston's wrist pin, at every 15 degrees over 720: the transforms, not just the formulas, close."""
        chain = chain_of(v6_record.record())
        for q in range(0, 721, 15):
            transforms = chain.transforms(chain.complete({"J-001": float(q)}))
            for cylinder, x, side, phase in v6_record.CYLINDERS:
                with self.subTest(q=q, cylinder=cylinder):
                    crankpin = transforms["VSX-0101"].apply(v6_record.crankpin_rest(x, side, phase))
                    assert_close(self, transforms[f"rod-{cylinder}"].apply((0.0, 0.0, -v6_record.L)), crankpin)
                    wrist = transforms[f"piston-{cylinder}"].apply((0.0, 0.0, 0.0))
                    assert_close(self, transforms[f"rod-{cylinder}"].apply((0.0, 0.0, 0.0)), wrist)
                    n = v6_record.bank_axis(side)
                    across = (wrist[1] * n[2] - wrist[2] * n[1])  # the wrist stays on the bore axis
                    self.assertAlmostEqual(wrist[0], x, places=9)
                    self.assertAlmostEqual(across, 0.0, places=9)
                    self.assertAlmostEqual(math.dist(wrist, crankpin), v6_record.L, places=9)

    def test_mechanism_geometry_must_match_its_joints(self) -> None:
        def broken(change) -> list[str]:
            data = v6_record.record()
            change(data)
            return problems(data)

        def joint(data: dict, jid: str) -> dict:
            return next(j for j in data["joints"] if j["id"] == jid)

        cases = {
            "the piston slides along": lambda d: joint(d, "J-011").update(axis=[0, 0, 1]),
            "the rod turns about [-1.0, 0.0, 0.0]": lambda d: joint(d, "J-021").update(axis=[-1, 0, 0]),
            "from cylinder-1's TDC wrist": lambda d: joint(d, "J-021").update(origin=[-41.25, 0, 0]),
            "crank_axis and bank_axis are not perpendicular": lambda d: d["mechanisms"][0].update(bank_axis=[1, 0, 1]),
            "needs rod_length_mm > crank_radius_mm > 0": lambda d: d["mechanisms"][0].update(rod_length_mm=10),
            "drives a prismatic joint, not a revolute one": lambda d: joint(d, "J-021")["coupling"].update(
                output="displacement"),
            "mechanism 'cylinder-9' is not in `mechanisms`": lambda d: joint(d, "J-011")["coupling"].update(
                mechanism="cylinder-9"),
        }
        for message, change in cases.items():
            with self.subTest(message=message):
                found = broken(change)
                self.assertTrue(any(message in p for p in found), found)


class Dag(unittest.TestCase):
    def joints(self, *couplings: tuple[str, str]) -> list[dict]:
        """J-001 independent, then one linear coupling per (dependent, driver)."""
        listed = [revolute("J-001", 0, 720, nominal=0)]
        for dependent, driver in couplings:
            listed.append(revolute(dependent, -720, 720, coupling={"type": "linear", "driver": driver, "ratio": 1}))
        return listed

    def test_drivers_are_derived_before_the_joints_they_drive(self) -> None:
        parsed = coupling.parse({"joints": self.joints(("J-004", "J-003"), ("J-003", "J-002"), ("J-002", "J-001"))})
        self.assertEqual(parsed.order, ("J-002", "J-003", "J-004"))
        self.assertEqual(parsed.root("J-004"), "J-001")
        self.assertEqual(parsed.derive({"J-001": 30.0})["J-004"], 30.0)

    def test_a_self_coupling_is_rejected(self) -> None:
        self.assertEqual(problems({"joints": self.joints(("J-002", "J-002"))}),
                         ["J-002 coupling: J-002 is coupled to itself"])

    def test_a_multi_node_cycle_is_rejected_by_name(self) -> None:
        found = problems({"joints": self.joints(("J-002", "J-003"), ("J-003", "J-004"), ("J-004", "J-002"))})
        self.assertEqual(found, ["coupling cycle: J-002 -> J-004 -> J-003 -> J-002 (each joint drives the next)"])

    def test_a_missing_driver_is_rejected_not_invented(self) -> None:
        self.assertEqual(problems({"joints": self.joints(("J-002", "J-099"))}),
                         ["J-002 coupling: driver J-099 is not a joint of this assembly"])

    def test_a_fixed_driver_or_dependent_is_rejected(self) -> None:
        fixed = {**revolute("J-005", 0, 0, nominal=0), "type": "fixed"}
        found = problems({"joints": [*self.joints(("J-002", "J-005")), fixed]})
        self.assertEqual(found, ["J-002 coupling: driver J-005 is a fixed joint; a driver moves"])
        coupled_fixed = {**fixed, "coupling": {"type": "linear", "driver": "J-001", "ratio": 1}}
        found = problems({"joints": [*self.joints(), coupled_fixed]})
        self.assertIn("a fixed joint cannot be coupled", found[0])

    def test_a_missing_profile_is_rejected(self) -> None:
        joints = [revolute("J-001", 0, 720, nominal=0),
                  revolute("J-002", 0, 1, coupling={"type": "periodic_table", "driver": "J-001", "profile": "lift"})]
        self.assertEqual(problems({"joints": joints}), ["J-002 coupling: profile 'lift' is not in `profiles`"])


class CoupledChain(unittest.TestCase):
    def setUp(self) -> None:
        self.chain = chain_of(v6_record.record())

    def test_only_the_crank_is_independent(self) -> None:
        self.assertEqual([j.id for j in self.chain.independent], ["J-001"])
        self.assertEqual(len(self.chain.dependent), 20)

    def test_setting_a_dependent_joint_is_refused(self) -> None:
        with self.assertRaisesRegex(pose.MotionError, r"J-013 follows J-001 \(slider_crank cylinder-3 displacement\) "
                                                      r"and cannot be set; set an independent joint: \['J-001'\]"):
            self.chain.complete({"J-013": -1.0})

    def test_the_complete_map_holds_every_unwrapped_coordinate(self) -> None:
        values = self.chain.complete({"J-001": 720.0})
        self.assertEqual((values["J-031"], values["J-032"]), (360.0, 360.0))
        self.assertAlmostEqual(values["J-011"], 0.0, places=9)  # cylinder 1 at TDC again
        # Valve 1 peaks at cylinder 1's BDC, crank 180 (phase 65 - 180 / 2 = -25): table at 360 - 25, closed.
        # Valve 3 peaks at crank 60 (phase 65 - 60 / 2 = 35): table at 360 + 35 -> 35, 0.75 mm open.
        self.assertEqual((values["J-041"], values["J-043"]), (0.0, 0.75))

    def test_a_derived_value_beyond_its_limits_is_a_finding(self) -> None:
        data = v6_record.record()
        next(j for j in data["joints"] if j["id"] == "J-031").update(max=180)  # the cam reaches 360
        chain = chain_of(data)
        findings = chain.limit_findings(chain.complete({"J-001": 720.0}))
        self.assertEqual([(f["joint"], f["value"]) for f in findings], [("J-031", 360.0)])
        self.assertIn("(derived: J-031 follows J-001 (linear ratio 0.5 offset 0))", findings[0]["message"])
        limits = {j["id"]: (j["min"], j["max"]) for j in data["joints"]}
        nominal = {j["id"]: j["nominal"] for j in data["joints"] if "nominal" in j}
        units = {j["id"]: coupling.JOINT_UNITS[j["type"]] for j in data["joints"]}
        self.assertEqual(coupling.parse(data).range_problems(limits, nominal, units),
                         ["J-031 follows J-001 (linear ratio 0.5 offset 0) reaches 180.25 deg at J-001 = 360.5 deg, "
                          "outside its limits [0, 180]"])

    def test_the_bottom_dead_centre_rounding_is_inside_the_stroke(self) -> None:
        values = self.chain.complete({"J-001": 180.0})  # cylinder 1 at BDC: -2r, give or take one ulp
        self.assertAlmostEqual(values["J-011"], -v6_record.STROKE, places=12)
        self.assertEqual(self.chain.limit_findings(values), [])

    def crank_train(self) -> list[tuple[str, str]]:
        """The occurrence pairs the crank alone moves: block, crankshaft, pistons and rods."""
        ids = [oid for oid in self.chain.ids if not oid.startswith(("cam-", "valve-"))]
        return [(a, b) for index, a in enumerate(ids) for b in ids[index + 1:]]

    def relative(self, q: float, pairs: list[tuple[str, str]]) -> dict:
        return self.chain.relative_transforms(self.chain.complete({"J-001": q}), pairs)

    @staticmethod
    def bits(rigid) -> bytes:
        return struct.pack("<12d", *rigid.rot[0], *rigid.rot[1], *rigid.rot[2], *rigid.trans)

    def test_a_crank_turn_later_the_crank_train_is_placed_with_the_very_same_bits(self) -> None:
        """coupling.canonical_degrees: 360 degrees on, every pair the crank alone moves repeats its
        placement bitwise, the half-speed cams do not, and a piston at -theta from its TDC sits with
        the bits it has at +theta."""
        pairs = self.crank_train()
        self.assertEqual(len(pairs), 91)  # 14 occurrences
        for q in range(0, 360, 5):
            now, later = self.relative(float(q), pairs), self.relative(float(q + 360), pairs)
            self.assertEqual([self.bits(now[p]) for p in pairs], [self.bits(later[p]) for p in pairs], q)
        cam = ("VSX-0001", "cam-right")
        self.assertNotEqual(self.bits(self.relative(40.0, [cam])[cam]), self.bits(self.relative(400.0, [cam])[cam]))
        piston = ("VSX-0001", "piston-1")  # cylinder 1's TDC is at crank 0
        for q in (5.0, 85.0, 175.0):
            self.assertEqual(self.bits(self.relative(q, [piston])[piston]),
                             self.bits(self.relative(360.0 - q, [piston])[piston]), q)

    def test_the_second_crank_turn_of_the_crank_train_measures_nothing(self) -> None:
        """pair_measure's exact key finds every repeat: measuring the crank train over 720 degrees
        takes the kernel calls 360 do."""
        measure = sweep.pair_measure
        box = ([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
        pairs = self.crank_train()

        def calls(stop: int) -> int:
            with mock.patch.object(measure, "box_corners", side_effect=lambda shape, tolerance=False: box):
                measurer = measure.PairMeasurer({self.chain.pn(oid): None for oid in self.chain.ids})
            requests = [measure.Request(self.chain.pn(a), self.chain.pn(b), placement)
                        for q in range(0, stop, 5) for (a, b), placement in self.relative(float(q), pairs).items()]
            with mock.patch.object(measure.pose, "placed", side_effect=lambda shape, at: shape), \
                    mock.patch.object(measure.pose, "interference", return_value=(1.0, 0.0)) as kernel:
                measurer.measure(requests)
            self.assertEqual(measurer.reused + kernel.call_count, len(requests))
            return kernel.call_count

        self.assertEqual(calls(720), calls(360))

    def test_a_tenth_degree_grid_repeats_every_crank_turn_bitwise(self) -> None:
        """sweep.linspace's 0.1 degree grid over 720 degrees: every sample and the one 360 degrees on
        reduce to the same angle, and place the crank train with the same bits."""
        values = sweep.linspace(0.0, 720.0, 7201)
        self.assertEqual(sum(coupling.canonical_degrees(values[k]) == coupling.canonical_degrees(values[k + 3600])
                             for k in range(3601)), 3601)
        pairs = self.crank_train()
        for k in range(0, 3601, 97):
            now, later = self.relative(values[k], pairs), self.relative(values[k + 3600], pairs)
            self.assertEqual([self.bits(now[p]) for p in pairs], [self.bits(later[p]) for p in pairs], values[k])

    def test_a_chain_without_the_record_couplings_is_refused(self) -> None:
        data = v6_record.record()
        inventory = pose.assembly_data.normalize(data, {pn: f for pn, (_, f) in v6_record.PARTS.items()})
        joints = [pose.make_joint(raw, pose.Assembly(inventory, (), {}).attachable) for raw in data["joints"]]
        with self.assertRaisesRegex(pose.MotionError, "need the record's couplings"):
            pose.build_chain(joints, inventory.occurrences)

    def test_a_coupled_joint_authors_no_nominal(self) -> None:
        raw = {**v6_record.record()["joints"][1], "nominal": 0}
        with self.assertRaisesRegex(pose.MotionError, "J-031: a coupled joint derives its value from its coupling"):
            pose.make_joint(raw)


class CoupledSampling(unittest.TestCase):
    def test_one_driver_sweeps_145_samples_and_derives_the_rest(self) -> None:
        chain = chain_of(v6_record.record())
        self.assertEqual(sweep.pose_count_bound(chain, 145, 0), 145)
        samples = sweep.generate_poses(chain, 145, 3)  # the grid's 0, 360 and 720 are already sampled
        self.assertEqual(len(samples), 145)
        self.assertEqual([s.settings["J-001"] for s in samples[:3]], [0.0, 5.0, 10.0])
        self.assertEqual(set(samples[0].settings), {"J-001"})
        self.assertEqual(len(samples[0].values), 21)
        self.assertEqual(samples[-1].values["J-031"], 360.0)

    def test_independent_sweeps_sample_as_before(self) -> None:
        """Without couplings every movable joint is independent: per-joint sweeps with the others at
        nominal, then the grid, duplicates dropped."""
        joints = [pose.make_joint(raw) for raw in (
            revolute("J-001", -90, 90, nominal=0, parent="TST-0001", child="TST-0002"),
            revolute("J-002", 0, 90, nominal=0, parent="TST-0002", child="TST-0003"))]
        samples = sweep.generate_poses(pose.build_chain(joints), 3, 2)
        self.assertEqual([(s.source, s.values) for s in samples], [
            ("sweep:J-001", {"J-001": -90.0, "J-002": 0.0}), ("sweep:J-001", {"J-001": 0.0, "J-002": 0.0}),
            ("sweep:J-001", {"J-001": 90.0, "J-002": 0.0}), ("sweep:J-002", {"J-001": 0.0, "J-002": 45.0}),
            ("sweep:J-002", {"J-001": 0.0, "J-002": 90.0}), ("grid", {"J-001": -90.0, "J-002": 90.0}),
            ("grid", {"J-001": 90.0, "J-002": 90.0})])
        self.assertTrue(all(s.settings == s.values for s in samples))


class FreecadRefusal(unittest.TestCase):
    def test_a_coupled_record_is_refused_before_freecad_starts(self) -> None:
        import yaml

        with tempfile.TemporaryDirectory() as directory:
            hw = Path(directory)
            (hw / "assembly.yaml").write_text(yaml.safe_dump(v6_record.record()), encoding="utf-8")
            for pn, (title, frame) in v6_record.PARTS.items():
                (hw / "parts" / pn).mkdir(parents=True)
                (hw / "parts" / pn / "part.yaml").write_text(f"PN: {pn}\ntitle: {title}\nmodel_frame: {frame}\n",
                                                           encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                code = freecad_assembly.main(["--hw", str(hw), "--parts-dir", str(hw / "parts"),
                                              "--freecad", str(hw / "no-freecadcmd")])
        self.assertEqual(code, 2)
        self.assertIn("coupled joints are not supported by the FreeCAD Assembly simulation", stderr.getvalue())
        self.assertIn("J-031 follows J-001 (linear ratio 0.5 offset 0)", stderr.getvalue())
        self.assertIn("pose.py --set on an independent joint and sweep.py", stderr.getvalue())


def assert_close(case: unittest.TestCase, actual, expected, places: int = 9) -> None:
    for a, e in zip(actual, expected):
        case.assertAlmostEqual(a, e, places=places)


if __name__ == "__main__":
    unittest.main()
