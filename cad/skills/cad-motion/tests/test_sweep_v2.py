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

    def test_a_moving_body_in_no_or_two_subassemblies_and_a_reserved_name_are_refused(self) -> None:
        import copy
        two = copy.deepcopy(ENGINE)
        two["subassemblies"][1]["parts"].append("TST-0002")  # a legacy PN listed in both
        none = copy.deepcopy(ENGINE)
        none["joints"].append(revolute("J-007", "@valve-1", "TST-0008", -5, 5, nominal=0))  # attached, listed nowhere
        reserved = copy.deepcopy(ENGINE)
        reserved["subassemblies"][1]["id"] = "interface"
        for data, expected in ((two, "TST-0002 belongs to 2 subassemblies"), (none, "TST-0008 belongs to no"),
                               (reserved, "'interface' uses a reserved")):
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


if __name__ == "__main__":
    unittest.main()
