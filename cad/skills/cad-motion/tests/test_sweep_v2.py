#!/usr/bin/env python3
"""cad-motion sweep v2 tests: subsystem ownership and periods, kernel-free.

Run: python3 -m unittest discover -s cad/skills/cad-motion/tests -p test_sweep_v2.py -v
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"


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
subsystems = load("cad_motion_subsystems", SCRIPTS / "subsystems.py")
coupling = pose.coupling


def revolute(jid: str, parent: str, child: str, low: float, high: float, origin=(0, 0, 0), **extra) -> dict:
    return {"id": jid, "type": "revolute", "parent": parent, "child": child, "axis": [0, 0, 1],
            "origin": list(origin), "min": low, "max": high, **extra}


def geared(jid: str, child: str, ratio: float, origin=(0, 0, 0), driver: str = "J-001") -> dict:
    return revolute(jid, "TST-0001", child, -1e5, 1e5, origin,
                    coupling={"type": "linear", "driver": driver, "ratio": ratio})


def chain_of(data: dict):
    """The chain pose.py builds from an assembly.yaml mapping, with its subassemblies as groups; a
    part placed by explicit occurrences is part-local, every other part modeled in place."""
    frames = {item["PN"]: "part_local" for item in data.get("occurrences", [])}
    inventory = pose.assembly_data.normalize(data, frames)
    assembly = pose.Assembly(inventory, (), frames)
    joints = [pose.make_joint(raw, assembly.attachable) for raw in data["joints"]]
    return pose.build_chain(joints, inventory.occurrences, couplings=coupling.parse(data)), inventory.groups


def crank_record(*bodies: dict, crank_max: float = 720.0, parts: list[str] | None = None) -> dict:
    """A crank J-001 (TST-0002 on ground TST-0001) and `bodies` (dependent joints on the ground),
    every part in one subassembly."""
    joints = [revolute("J-001", "TST-0001", "TST-0002", 0, crank_max, nominal=0), *bodies]
    names = parts or ["TST-0001", "TST-0002", *(body["child"] for body in bodies)]
    return {"subassemblies": [{"id": "train", "parts": names}], "joints": joints}


def periods(data: dict, grid: float = 0.25) -> dict:
    chain, groups = chain_of(data)
    crank = chain.joint("J-001")
    split = subsystems.partition(chain, groups, [])

    def at(value: float):
        return chain.transforms(chain.complete({"J-001": value}))

    return subsystems.detect_periods(crank, crank.min, crank.max, split.members, at, grid)


class PeriodTests(unittest.TestCase):
    """detect_period on the transforms of geared bodies; worked from the ratios, not from the code."""

    def test_a_5_5_to_1_starter_pinion_is_720_degrees_and_its_crank_return_at_360_is_rejected(self) -> None:
        found = periods(crank_record(geared("J-002", "TST-0003", 5.5, origin=(60, 0, 0))))["train"]
        self.assertEqual((found.status, found.period, found.unit), ("verified", 720.0, "deg"))
        self.assertEqual([row["lag"] for row in found.rejected], [360.0])
        self.assertEqual(found.rejected[0]["member"], "TST-0003")  # 5.5 x 360 = 1980: the pinion is half a turn off
        self.assertGreater(found.rejected[0]["rotation_deviation"], 1.0)
        self.assertGreater(found.outside_range, 0)  # the second 720 degree cycle lies past the crank's range

    def test_a_crank_alone_is_360_a_half_speed_cam_720_and_a_double_speed_gear_180(self) -> None:
        for ratio, period in ((None, 360.0), (0.5, 720.0), (2.0, 180.0), (-3.0, 120.0)):
            bodies = [] if ratio is None else [geared("J-002", "TST-0003", ratio, origin=(40, 5, 0))]
            parts = ["TST-0001", "TST-0003"] if ratio is not None else None  # the crank in no train when geared
            data = crank_record(*bodies, parts=parts)
            if parts is not None:
                data["subassemblies"].append({"id": "crank", "parts": ["TST-0002"]})
            with self.subTest(ratio=ratio):
                self.assertEqual(periods(data)["train"].period, period)

    def test_a_cam_lobe_that_returns_to_its_start_lift_at_180_is_rejected_there(self) -> None:
        lobe = {"input_unit": "deg", "output_unit": "mm", "period_deg": 360, "interpolation": "linear",
                "samples": [[0, 0], [90, 5], [180, 0], [270, 2], [360, 0]]}
        data = crank_record({"id": "J-002", "type": "prismatic", "parent": "TST-0001", "child": "TST-0003",
                             "axis": [0, 0, 1], "origin": [0, 0, 0], "min": 0, "max": 5,
                             "coupling": {"type": "periodic_table", "driver": "J-001", "profile": "lobe",
                                          "phase_deg": 0}})
        data["profiles"] = {"lobe": lobe}
        data["subassemblies"] = [{"id": "train", "parts": ["TST-0001", "TST-0003"]},
                                 {"id": "crank", "parts": ["TST-0002"]}]
        found = periods(data)["train"]
        self.assertEqual((found.status, found.period), ("verified", 360.0))
        self.assertEqual([row["lag"] for row in found.rejected], [180.0])  # lift 5 at 90 but 2 at 270

    def test_a_body_that_never_returns_or_a_range_shorter_than_its_period_is_unverified(self) -> None:
        slide = {"id": "J-002", "type": "prismatic", "parent": "TST-0001", "child": "TST-0003", "axis": [1, 0, 0],
                 "origin": [0, 0, 0], "min": -1e3, "max": 1e3,
                 "coupling": {"type": "linear", "driver": "J-001", "ratio": 0.1}}
        sliding = crank_record(slide, parts=["TST-0001", "TST-0003"])
        sliding["subassemblies"].append({"id": "crank", "parts": ["TST-0002"]})
        for name, data in (("slide", sliding), ("short range", crank_record(crank_max=270.0))):
            with self.subTest(name):
                found = periods(data)["train"]
                self.assertEqual((found.status, found.period, found.rejected), ("unverified", None, ()))
                self.assertIn("returns", found.reason)
        with_crank = periods(crank_record(slide))["train"]  # the crank's returns at 360 and 720 do not hold the slide
        self.assertEqual((with_crank.status, [row["lag"] for row in with_crank.rejected]), ("unverified", [360.0, 720.0]))

    def test_a_subsystem_the_joint_does_not_move_is_static(self) -> None:
        data = crank_record(revolute("J-002", "TST-0001", "TST-0003", -90, 90, nominal=0))
        data["subassemblies"] = [{"id": "crank", "parts": ["TST-0001", "TST-0002"]},
                                 {"id": "arm", "parts": ["TST-0003"]}]
        found = periods(data)
        self.assertEqual(found["arm"].status, "static")
        self.assertEqual(found["crank"].period, 360.0)

    def test_a_grid_must_be_a_positive_step(self) -> None:
        for grid in (0.0, -1.0, float("nan")):
            with self.subTest(grid=grid), self.assertRaises(ValueError):
                periods(crank_record(), grid)


ENGINE = {
    "occurrences": [{"id": "piston-1", "PN": "TST-0003"}, {"id": "piston-2", "PN": "TST-0003"},
                    {"id": "valve-1", "PN": "TST-0005"}],
    "subassemblies": [
        {"id": "bottom", "parts": ["TST-0001", "TST-0002", "TST-0009"], "occurrences": ["@piston-1", "@piston-2"]},
        {"id": "top", "parts": ["TST-0004"], "occurrences": ["@valve-1"]},
    ],
    "joints": [
        revolute("J-001", "TST-0001", "TST-0002", 0, 720, nominal=0),
        {"id": "J-002", "type": "prismatic", "parent": "TST-0001", "child": "@piston-1", "axis": [0, 0, 1],
         "origin": [0, 0, 0], "min": -50, "max": 50, "coupling": {"type": "linear", "driver": "J-001", "ratio": 0.01}},
        {"id": "J-003", "type": "prismatic", "parent": "TST-0001", "child": "@piston-2", "axis": [0, 0, 1],
         "origin": [0, 0, 0], "min": -50, "max": 50, "coupling": {"type": "linear", "driver": "J-001", "ratio": -0.01}},
        geared("J-004", "TST-0004", 0.5),
        {"id": "J-005", "type": "prismatic", "parent": "TST-0004", "child": "@valve-1", "axis": [0, 0, 1],
         "origin": [0, 0, 0], "min": -50, "max": 50, "coupling": {"type": "linear", "driver": "J-004", "ratio": 0.01}},
        {"id": "J-006", "type": "fixed", "parent": "TST-0001", "child": "TST-0009", "axis": [0, 0, 1],
         "origin": [0, 0, 0], "min": 0, "max": 0, "nominal": 0},
    ],
}


class PartitionTests(unittest.TestCase):
    """partition: every pair gets exactly one owner; problems are refused, not guessed."""

    def split(self, data: dict = ENGINE, pairs=None):
        chain, groups = chain_of(data)
        import itertools
        return chain, subsystems.partition(chain, groups, pairs or list(itertools.combinations(chain.ids, 2)))

    def test_owners_follow_the_moving_bodies(self) -> None:
        chain, split = self.split()
        owner = {frozenset(pair): name for pair, name in split.pair_owner.items()}
        self.assertEqual(owner[frozenset(("TST-0002", "piston-1"))], "bottom")  # one owner
        self.assertEqual(owner[frozenset(("piston-1", "piston-2"))], "bottom")  # a repeated PN, one owner
        self.assertEqual(owner[frozenset(("TST-0001", "valve-1"))], "top")  # moving / static
        self.assertEqual(owner[frozenset(("piston-1", "valve-1"))], "interface")  # two owners
        self.assertEqual(owner[frozenset(("TST-0001", "TST-0009"))], "static")
        self.assertEqual(split.owners, ("bottom", "top", "interface", "static"))
        self.assertEqual(split.members, {"bottom": ("TST-0002", "piston-1", "piston-2"), "top": ("TST-0004", "valve-1")})
        self.assertEqual(split.owner_by_occurrence["TST-0009"], "static")  # listed in bottom, but it does not move

    def test_the_owners_partition_the_pairs_and_selecting_is_by_owner_not_by_body(self) -> None:
        chain, split = self.split()
        selected = [split.select([name]) for name in split.owners]
        self.assertEqual(sum(map(len, selected)), len(split.pair_owner))
        self.assertEqual(set().union(*selected), set(split.pair_owner))
        self.assertNotIn(("piston-1", "valve-1"), split.select(["bottom"]))
        self.assertEqual(len(split.all_pair_ids), len(set(split.all_pair_ids)))
        with self.assertRaises(subsystems.SubsystemError) as caught:
            split.select(["bottom", "nope"])
        self.assertIn("no such subsystem", caught.exception.problems[0])

    def test_a_moving_body_in_no_or_two_subassemblies_a_reserved_name_and_a_repeated_id_are_refused(self) -> None:
        import copy
        two = copy.deepcopy(ENGINE)
        two["subassemblies"][1]["parts"].append("TST-0002")  # a legacy PN listed in both
        none = copy.deepcopy(ENGINE)
        none["joints"].append(revolute("J-007", "@valve-1", "TST-0008", -5, 5, nominal=0))  # attached, listed nowhere
        reserved = copy.deepcopy(ENGINE)
        reserved["subassemblies"][1]["id"] = "interface"
        repeated = copy.deepcopy(ENGINE)
        repeated["subassemblies"][1]["id"] = "bottom"  # two subassemblies, one owner name: never merged
        for data, expected in ((two, "TST-0002 belongs to 2 subassemblies"), (none, "TST-0008 belongs to no"),
                               (reserved, "'interface' uses a reserved"), (repeated, "'bottom' is used 2 times")):
            with self.subTest(expected), self.assertRaises(subsystems.SubsystemError) as caught:
                self.split(data)
            self.assertTrue(any(expected in problem for problem in caught.exception.problems), caught.exception.problems)

    def test_the_digest_names_the_partition(self) -> None:
        import copy
        _, split = self.split()
        moved = copy.deepcopy(ENGINE)
        moved["subassemblies"][0]["occurrences"].remove("@piston-2")
        moved["subassemblies"][1]["occurrences"].append("@piston-2")
        _, other = self.split(moved)
        self.assertEqual(split.digest(), self.split()[1].digest())
        self.assertNotEqual(split.digest(), other.digest())

sweep = load("cad_motion_sweep", SCRIPTS / "sweep.py")
measure = sweep.pair_measure
MARGINS = sweep.design_rules.ClearanceMargins(0.1, {"IF-001": 0.1})


class ReducerTests(unittest.TestCase):
    """The sweep's statistics on given outcomes: subsystem selections combine into exactly the whole
    sweep; needs no OCP. Every request reads from `reading(sample, pair)`."""

    def setUp(self) -> None:
        self.chain, groups = chain_of(ENGINE)
        self.samples = sweep.generate_poses(self.chain, 5, 0)
        self.pairs, _ = sweep.pairs_to_check(self.chain, [])
        self.requirements = {("piston-1", "piston-2"): {"required_mm": 0.5, "source": "IF-001", "interface": "IF-001"}}
        whole = self.plan(None)
        self.split = subsystems.partition(self.chain, groups, whole.measured)
        # far apart: each pose's x grows with the sample, so the last sample reaches farthest
        self.effectors = {s.index: {"low": [0.0] * 3, "high": [1.0] * 3, "centre": [float(s.index), 0.0, 0.0]}
                          for s in self.samples}

    def plan(self, selection):
        return sweep.plan(self.chain, self.samples, self.pairs, set(), self.requirements, 0.0, MARGINS, selection)

    def reading(self, sample: int, pair: tuple[str, str]):
        if pair == ("piston-1", "valve-1") and sample == 4:
            return measure.Measured(0.0, 2.0)  # an interface collision at the farthest-reaching sample
        if pair == ("piston-1", "piston-2"):
            return measure.Measured(0.55 if sample == 2 else 0.9 + sample, 0.0)  # 0.05 above its 0.5 minimum
        if pair == ("TST-0001", "valve-1") and sample == 1:
            return measure.Cleared(3.0, 5.0, "mesh", mesh_mm=4.0)
        return measure.Measured(10.0 + sample + len(pair[0]), 0.0)

    def statistics(self, plan):
        outcomes = [self.reading(item.sample.index, plan.measured[index]) for item in plan.samples
                    if item.transforms is not None for index in plan.selected]
        return sweep.accumulate(plan, outcomes, len(plan.samples), set(), self.requirements, 1e-3, self.effectors)

    def test_the_owners_statistics_combine_into_the_whole_sweeps_and_its_findings(self) -> None:
        whole = self.plan(None)
        parts = [self.statistics(self.plan(self.split.select([owner]))) for owner in self.split.owners]
        combined = sweep.combine_statistics(parts)
        expected = self.statistics(whole)
        self.assertEqual(json_round(combined["pairs"]), json_round(expected["pairs"]))
        self.assertEqual(combined["samples"], expected["samples"])
        reference = (0.0, 0.0, 0.0)
        for criterion in sweep.CRITERIA:
            with self.subTest(criterion):
                merged, alone = (sweep.finalize(self.chain, whole, stats, reference, criterion)
                                 for stats in (combined, expected))
                self.assertEqual((merged.collisions, merged.worst, merged.clearance, merged.bounds.keys()),
                                 (alone.collisions, alone.worst, alone.clearance, alone.bounds.keys()))
        reach = sweep.finalize(self.chain, whole, combined, reference, "max_horizontal_reach")
        self.assertEqual(reach.worst["sample"].index, 3)  # sample 4 collides in the interface run
        bottom = sweep.finalize(self.chain, whole, parts[0], reference, "max_horizontal_reach")
        self.assertEqual(bottom.worst["sample"].index, 4)  # one subsystem alone would take the colliding pose
        self.assertEqual([row["pair"] for row in combined["mesh_cleared"]], [whole.measured.index(("TST-0001", "valve-1"))])

    def test_overlapping_or_mismatched_selections_are_refused(self) -> None:
        part = self.statistics(self.plan(self.split.select(["bottom"])))
        with self.assertRaisesRegex(ValueError, "two inputs"):
            sweep.combine_statistics([part, part])
        other = self.statistics(self.plan(self.split.select(["top"])))
        other["samples"][0]["settings"] = {"J-001": 1.0}
        with self.assertRaisesRegex(ValueError, "same samples"):
            sweep.combine_statistics([part, other])

    def test_a_minimum_within_its_margin_warns_and_one_below_its_requirement_fails_without_a_warning(self) -> None:
        whole = self.plan(None)
        state = sweep.finalize(self.chain, whole, self.statistics(whole), (0.0, 0.0, 0.0), "minimum_clearance")
        warnings = sweep.margin_warnings(self.chain, whole, state)
        self.assertEqual([(row["check"], row["pair"], row["clearance_mm"], row["required_mm"], row["margin_mm"])
                          for row in warnings], [("margin", ["@piston-1", "@piston-2"], 0.55, 0.5, 0.1)])
        self.requirements[("piston-1", "piston-2")]["required_mm"] = 0.6
        whole = self.plan(None)
        state = sweep.finalize(self.chain, whole, self.statistics(whole), (0.0, 0.0, 0.0), "minimum_clearance")
        self.assertEqual(sweep.margin_warnings(self.chain, whole, state), [])
        self.assertEqual(whole.clearing[("piston-1", "piston-2")], 0.6 + 0.1)  # fast mode clears past the margin too

    def test_a_stopped_sweep_reduces_only_samples_whose_pruned_requests_are_proved_inside_them(self) -> None:
        """One pair, one request per sample: sample 1 is pruned on sample 3's distance."""
        samples = [sweep.PlannedSample(None, [], {}, start) for start in range(5)]
        plan = sweep.Plan({("a", "b")}, [("a", "b")], [0], {}, {}, {}, samples, [])
        hit, pruned = measure.Measured, measure.Pruned
        for outcomes, taken in (([hit(1.0, 0.0), pruned(3, 2.0), hit(2.0, 0.0), hit(0.5, 0.0), None], 4),
                                ([hit(1.0, 0.0), pruned(3, 2.0), hit(2.0, 0.0), None, None], 1),
                                ([hit(1.0, 0.0), pruned(0, 2.0), hit(2.0, 0.0), hit(0.5, 0.0), hit(0.7, 0.0)], 5)):
            with self.subTest(outcomes=outcomes):
                self.assertEqual(sweep.measured_prefix(None, plan, outcomes), taken)


def json_round(value):
    import json
    return json.loads(json.dumps(value))


@unittest.skipUnless(__import__("shutil").which("uv"), "uv is required to build and read STEP through OCP")
class BetweenSampleCliTests(unittest.TestCase):
    """sweep.py on continuous_collision.py's cubes: the samples pass, the between-sample check
    finds the collision at 0 degrees and replays it there."""

    @classmethod
    def setUpClass(cls) -> None:
        import subprocess
        import tempfile
        import yaml

        sys.path.insert(0, str(HERE / "fixtures"))
        import continuous_collision as fixture

        cls.fixture = fixture
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.parts, cls.hw = root / "parts", root / "project" / "hw"
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(HERE / "fixtures" / "continuous_collision.py"),
                               str(cls.parts)], capture_output=True, text=True, check=False, timeout=900)
        if proc.returncode != 0:
            raise RuntimeError(f"fixture build failed: {proc.stderr[-2000:]}")
        (cls.hw / "parts").mkdir(parents=True)
        (cls.hw / "assembly.yaml").write_text(yaml.safe_dump(fixture.record(), sort_keys=False), encoding="utf-8")
        (cls.hw / "interfaces.yaml").write_text(yaml.safe_dump(fixture.interfaces(), sort_keys=False), encoding="utf-8")
        for pn, (title, frame, *_) in fixture.PARTS.items():
            (cls.hw / "parts" / pn).mkdir()
            (cls.hw / "parts" / pn / "part.yaml").write_text(f"PN: {pn}\ntitle: {title}\nmodel_frame: {frame}\n",
                                                            encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def sweep(self, *options: str, env: dict[str, str] | None = None):
        import json
        import os
        import subprocess
        import tempfile

        out = Path(tempfile.mkdtemp(dir=self.hw.parent / ".cad-work" if (self.hw.parent / ".cad-work").is_dir()
                                    else self.make_work()))
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(SCRIPTS / "sweep.py"), "--hw", str(self.hw),
                               "--parts-dir", str(self.parts), "--steps", "2", "--grid", "0", "--no-cache",
                               "--worst-step", str(out / "worst.step"), *options],
                              capture_output=True, text=True, check=False, timeout=900,
                              env={**os.environ, **(env or {})})
        return proc, json.loads(proc.stdout) if proc.stdout.strip() else {}

    def make_work(self) -> Path:
        work = self.hw.parent / ".cad-work"
        work.mkdir(exist_ok=True)
        return work

    def test_a_collision_between_two_passing_samples_is_found_and_replayable(self) -> None:
        proc, result = self.sweep()
        self.assertEqual(proc.returncode, 1, proc.stderr[-2000:])
        self.assertEqual((result["collision_pose_count"], result["status"]), (0, "fail"))
        between = result["continuous"]
        self.assertEqual((between["status"], between["rigorous"]), ("finding", False))
        finding = between["between_sample_findings"][0]
        self.assertEqual((finding["kind"], finding["pair"], finding["coordinate"]),
                         ("collision", [self.fixture.TURNING, self.fixture.OBSTACLE], 0.0))  # chain order
        self.assertGreater(finding["overlap_mm3"], 1e-3)
        self.assertEqual(finding["independent_pose"], {"J-001": 0.0})
        self.assertIn("Jacobians", between["limitation"])

    def test_without_the_check_or_its_bisection_the_sweep_says_what_it_did_not_prove(self) -> None:
        sampled, result = self.sweep("--no-continuous")
        self.assertEqual(sampled.returncode, 0, sampled.stderr[-2000:])
        self.assertEqual((result["status"], result["continuous"]["status"]), ("pass", "disabled"))
        shallow, result = self.sweep("--continuous-depth", "0")  # no bisection: the collision stays unproved
        self.assertEqual(shallow.returncode, 0, shallow.stderr[-2000:])
        self.assertEqual((result["status"], result["continuous"]["status"]), ("pass", "incomplete"))
        warning = next(row for row in result["warnings"] if row["check"] == "continuous")
        self.assertEqual((warning["severity"], warning["unproved_pairs"]),
                         ("warning", [[self.fixture.TURNING, self.fixture.OBSTACLE]]))
        self.assertIn("--steps", warning["resolve"])
        required, result = self.sweep("--continuous-depth", "0", "--require-continuous")
        self.assertEqual(required.returncode, 2, required.stderr[-2000:])
        self.assertEqual((result["status"], result["continuous"]["status"]), ("incomplete", "incomplete"))
        refused, _ = self.sweep("--continuous-depth", "7")
        self.assertEqual(refused.returncode, 2)
        self.assertIn("--continuous-depth", refused.stderr)

    def test_require_continuous_fails_a_sweep_whose_proof_did_not_run(self) -> None:
        import tempfile

        for options in (("--no-continuous",), ("--smoke",)):
            with self.subTest(options=options):
                refused, result = self.sweep(*options, "--require-continuous")
                self.assertEqual((refused.returncode, result), (2, {}))
                self.assertIn("--require-continuous", refused.stderr)
        hidden = Path(tempfile.mkdtemp(dir=self.make_work()))
        (hidden / "fcl.py").write_text("raise ImportError('python-fcl hidden by the test')\n", encoding="utf-8")
        unbounded = {"PYTHONPATH": str(hidden)}  # mesh_bound imports fcl: no mesh bounds, no between-sample proof
        warned, result = self.sweep(env=unbounded)
        self.assertEqual(warned.returncode, 0, warned.stderr[-2000:])
        self.assertEqual((result["status"], result["continuous"]["status"]), ("pass", "disabled"))
        self.assertIn("mesh bounds unavailable", result["continuous"]["reason"])
        required, result = self.sweep("--require-continuous", env=unbounded)
        self.assertEqual(required.returncode, 2, required.stderr[-2000:])
        self.assertEqual((result["status"], result["continuous"]["status"]), ("incomplete", "disabled"))


if __name__ == "__main__":
    unittest.main()
