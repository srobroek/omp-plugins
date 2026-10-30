#!/usr/bin/env python3
"""cad-motion continuous.py tests: the between-sample check's motion rates, interval proofs and
report, on pose.py transforms, with closed-form distances standing in for the kernel; no OCP.

Run: python3 -m unittest discover -s cad/skills/cad-motion/tests -p test_continuous.py -v
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(HERE / "fixtures"))
import continuous_collision as fixture  # noqa: E402 - the kernel-free between-sample collision


def load(name: str, path: Path):
    """One module per name: the scripts load their siblings under these names, so a second copy
    would leave a module bound to the first."""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pose = load("cad_motion_pose", SCRIPTS / "pose.py")
continuous = load("cad_motion_continuous", SCRIPTS / "continuous.py")


# pair_measure's outcome records (sweep v2), which continuous.py reads by their fields.
@dataclass(frozen=True)
class Measured:
    distance_mm: float
    overlap_mm3: float
    seconds: float = 0.0
    method: str = "exact"


@dataclass(frozen=True)
class Cleared:
    lower_mm: float
    upper_mm: float
    method: str
    mesh_mm: float | None = None
    deviation_mm: float = 0.0
    seconds: float = 0.0


@dataclass(frozen=True)
class Pruned:
    witness_request: int
    lower_mm: float


@dataclass(frozen=True)
class Failure:
    message: str


@dataclass(frozen=True)
class Suspect:
    requests: tuple[int, ...]
    distance_mm: float
    overlap_mm3: float
    lower_mm: float
    upper_mm: float
    reevaluated: tuple = ()


@dataclass(frozen=True)
class Box:
    """mesh_bound's Box at the identity: a definition's envelope in its own frame."""

    low: tuple[float, float, float]
    high: tuple[float, float, float]
    error_mm: float = 0.0


IDENTITY = pose.Rigid.identity()
DESIGN_KEYS = {
    "status", "guarantee", "rigorous", "grid", "safety_factor", "max_depth", "paths", "pairs_checked",
    "contact_pairs_sampled_only", "original_intervals", "leaf_intervals", "proved_collision_free_leaf_intervals",
    "proved_clearance_leaf_intervals", "midpoints", "between_sample_findings", "collision_free_unproved_intervals",
    "clearance_unproved_pairs", "smallest_proved_clearance_margin", "limitation",
}


def chord_rate(radius: float, grid_deg: float = continuous.GRID_DEG) -> float:
    """A point `radius` mm off a turning axis: its chord over one fine step, per degree."""
    return 2 * radius * math.sin(math.radians(grid_deg) / 2) / grid_deg


def aabb(low: tuple[float, ...], high: tuple[float, ...], shift: tuple[float, float, float]) -> tuple[list[float], list[float]]:
    return [lo + s for lo, s in zip(low, shift)], [hi + s for hi, s in zip(high, shift)]


def box_reading(a: tuple[list[float], list[float]], b: tuple[list[float], list[float]]) -> tuple[float, float]:
    """The exact (distance, overlap volume) of two axis-aligned boxes."""
    gaps = [max(0.0, b[0][i] - a[1][i], a[0][i] - b[1][i]) for i in range(3)]
    shared = [min(a[1][i], b[1][i]) - max(a[0][i], b[0][i]) for i in range(3)]
    return math.hypot(*gaps), (math.prod(shared) if all(s > 0 for s in shared) else 0.0)


class BoxWorld:
    """Axis-aligned box bodies moved by translations: exact readings, mesh-like bounds that lie
    `deviation` below them, and the evaluator a sweep would pass, logging every request."""

    def __init__(self, bodies: dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]],
                 shift: Any, deviation: float = 0.04) -> None:
        self.bodies, self.shift, self.deviation = bodies, shift, deviation
        self.requests: list[Any] = []

    def boxes(self, error: float = 0.01) -> dict[str, Box]:
        return {oid: Box(low, high, error) for oid, (low, high) in self.bodies.items()}

    def at(self, path: Any) -> Any:
        def placements(q: float) -> dict[str, Any]:
            settings = path.settings(q)
            shifts = {oid: self.shift(oid, settings) for oid in self.bodies}
            return {oid: IDENTITY if shift is None else pose.Rigid(IDENTITY.rot, shift) for oid, shift in shifts.items()}
        return placements

    def exact(self, pair: tuple[str, str], settings: dict[str, float]) -> tuple[float, float]:
        placed = [aabb(*self.bodies[oid], self.shift(oid, settings) or (0.0, 0.0, 0.0)) for oid in pair]
        return box_reading(*placed)

    def endpoints(self, paths: list[Any], pairs: list[Any]) -> dict[tuple, Measured]:
        return {(path.id, pair.ids, sample): Measured(*self.exact(pair.ids, path.settings(q)))
                for path in paths for pair in pairs for q, sample in zip(path.coordinates, path.sample_ids)}

    def evaluate(self, requests: list[Any]) -> dict[int, Any]:
        """Bound mode: Cleared by the mesh-like bound where it proves no contact, else Measured."""
        answers = {}
        for request in requests:
            self.requests.append(request)
            distance, volume = self.exact(request.pair.ids, request.settings)
            lower = distance - self.deviation
            answers[request.id] = (Cleared(lower, distance + self.deviation, "mesh") if lower > pose.OVERLAP_GATE_MM
                                   else Measured(distance, volume))
        return answers

    def check(self, paths: list[Any], pairs: list[Any], breakpoints: tuple[float, ...] = (), **options: Any) -> Any:
        rates = {path.id: continuous.sample_rates(path, at=self.at(path), boxes=self.boxes(), pairs=pairs,
                                                  grid=continuous.GRID_MM if path.unit == "mm" else continuous.GRID_DEG,
                                                  breakpoints=breakpoints) for path in paths}
        return continuous.prove_between(paths, pairs=pairs, endpoint=self.endpoints(paths, pairs), rates=rates,
                                        evaluate_midpoints=self.evaluate, volume_tol=pose.INTERFERENCE_MM3, **options)


def static(oid: str, settings: dict[str, float]) -> None:
    return None


class BetweenSampleCollision(unittest.TestCase):
    """fixtures/continuous_collision.py: two 1 mm cubes apart at both sampled ends of J-001's
    -10..10 deg sweep, coinciding at 0 deg."""

    PAIR = continuous.PairSpec((fixture.OBSTACLE, fixture.TURNING), (fixture.OBSTACLE, fixture.TURNING),
                               fixture.MINIMUM_MM)
    PATH = continuous.SweepPath("sweep:J-001", "J-001", "deg", fixture.SWEEP_DEG, (0, 1))
    ERROR_MM = 0.02

    @staticmethod
    def at(q: float) -> dict[str, Any]:
        return {fixture.GROUND: IDENTITY, fixture.OBSTACLE: IDENTITY,
                fixture.TURNING: pose.Rigid.rotation((0.0, 0.0, 1.0), q, (0.0, 0.0, 0.0))}

    def rates(self) -> Any:
        boxes = {pn: Box(low, high, self.ERROR_MM) for pn, (_, _, low, high) in fixture.PARTS.items()}
        return continuous.sample_rates(self.PATH, at=self.at, boxes=boxes, pairs=[self.PAIR], grid=continuous.GRID_DEG)

    def check(self, evaluate: Any = None, **options: Any) -> tuple[Any, list[Any]]:
        requests: list[Any] = []

        def bound_mode(batch: list[Any]) -> dict[int, Any]:
            answers = {}
            for request in batch:
                requests.append(request)
                gap = fixture.box_gap_mm(request.coordinate)
                answers[request.id] = (Cleared(gap, math.inf, "box") if gap > pose.OVERLAP_GATE_MM else
                                       Measured(fixture.distance_mm(request.coordinate), fixture.overlap_mm3(request.coordinate)))
            return answers

        endpoint = {(self.PATH.id, self.PAIR.ids, sample): Measured(fixture.distance_mm(q), fixture.overlap_mm3(q))
                    for q, sample in zip(self.PATH.coordinates, self.PATH.sample_ids)}
        report = continuous.prove_between(
            [self.PATH], pairs=[self.PAIR], endpoint=endpoint, rates={self.PATH.id: self.rates()},
            evaluate_midpoints=evaluate or bound_mode, volume_tol=pose.INTERFERENCE_MM3,
            complete=lambda settings: {**settings, "J-002": 0.0}, **options)
        return report, requests

    def test_the_sampled_ends_alone_pass(self) -> None:
        for q in fixture.SWEEP_DEG:
            self.assertAlmostEqual(fixture.distance_mm(q), fixture.ENDPOINT_DISTANCE_MM, places=12)
            self.assertGreater(fixture.distance_mm(q), fixture.MINIMUM_MM)
            self.assertEqual(fixture.overlap_mm3(q), 0.0)
        self.assertAlmostEqual(fixture.overlap_mm3(0.0), 1.0, places=12)

    def test_the_first_midpoint_catches_the_collision(self) -> None:
        report, requests = self.check()
        self.assertEqual((report.status, report.exit_code), ("finding", 1))
        self.assertEqual([request.coordinate for request in requests], [0.0])
        (finding,) = report.between_sample_findings
        self.assertEqual((finding.kind, finding.pair, finding.path, finding.unit),
                         ("collision", self.PAIR.ids, self.PATH.id, "deg"))
        self.assertEqual(finding.coordinate, 0.0)
        self.assertAlmostEqual(finding.overlap_mm3, 1.0, places=9)
        self.assertGreater(finding.overlap_mm3, pose.INTERFERENCE_MM3)
        self.assertEqual(finding.required_mm, fixture.MINIMUM_MM)
        row = report.as_json()["between_sample_findings"][0]
        self.assertEqual((row["independent_pose"], row["pose"]), ({"J-001": 0.0}, {"J-001": 0.0, "J-002": 0.0}))
        self.assertEqual(report.midpoints, {"box": 0, "mesh": 0, "exact": 1, "cache": 0})
        self.assertEqual((report.original_intervals, report.leaf_intervals), (1, 1))

    def test_depth_zero_leaves_the_interval_unproved(self) -> None:
        report, requests = self.check(max_depth=0)
        self.assertEqual((report.status, report.exit_code), ("unproved", 2))
        self.assertEqual((requests, report.between_sample_findings), ([], []))
        (unproved,) = report.collision_free_unproved_intervals
        self.assertEqual((unproved.low, unproved.high, unproved.depth), (-10.0, 10.0, 0))
        self.assertIn("depth 0", unproved.reason)
        self.assertLess(unproved.lower_mm, 0.0)

    def test_the_deadline_leaves_the_interval_unproved(self) -> None:
        report, requests = self.check(deadline=time.monotonic() - 1.0)
        self.assertEqual((report.status, requests), ("unproved", []))
        self.assertIn("deadline", report.collision_free_unproved_intervals[0].reason)
        report, _ = self.check(evaluate=lambda batch: {})  # the evaluator's own deadline: no outcome
        self.assertEqual(report.status, "unproved")
        self.assertIn("deadline", report.collision_free_unproved_intervals[0].reason)

    def test_the_rate_is_the_fastest_inflated_corner(self) -> None:
        corner = math.hypot(10.5 + self.ERROR_MM, 0.5 + self.ERROR_MM)  # the farthest corner from the Z axis
        rates = self.rates()
        self.assertAlmostEqual(rates.rate(self.PAIR.ids, -10.0, 10.0), continuous.SAFETY * chord_rate(corner), places=9)
        self.assertAlmostEqual(rates.rate(self.PAIR.ids, -1.0, 1.0), continuous.SAFETY * chord_rate(corner), places=9)
        self.assertEqual(rates.rate(self.PAIR.ids, -11.0, 0.0), math.inf)  # beyond the path: no evidence


class TwoProofLevels(unittest.TestCase):
    """A slider b 0.3 mm beside a rail a along its whole 0..20 mm travel, required 0.25 mm: the
    samples' exact gaps satisfy it, the interval bounds prove collision freedom, not the minimum."""

    BODIES = {
        "a": ((0.0, 0.0, 0.0), (100.0, 10.0, 10.0)),  # the rail
        "b": ((0.0, 10.3, 0.0), (10.0, 20.3, 10.0)),  # the slider, +x by J-001
        "c": ((200.0, 0.0, 0.0), (210.0, 10.0, 10.0)),  # far off, no requirement, nothing declared
        "d": ((20.0, -10.0, 0.0), (30.0, 0.0, 10.0)),  # touching the rail, contact declared
        "e": ((0.0, -15.0, 0.0), (10.0, -5.0, 10.0)),  # contact declared, but 0.2 mm required
        "f": ((40.0, -10.0, 0.0), (50.0, 1.0, 10.0)),  # overlapping the rail, overlap allowed
    }
    PATH = continuous.SweepPath("sweep:J-001", "J-001", "mm", (0.0, 10.0, 20.0), (0, 1, 2))
    PAIRS = [
        continuous.PairSpec(("a", "b"), ("RAIL", "SLIDER"), 0.25),
        continuous.PairSpec(("b", "c"), ("SLIDER", "FAR")),
        continuous.PairSpec(("a", "c"), ("RAIL", "FAR")),
        continuous.PairSpec(("a", "d"), ("RAIL", "TOUCHING"), contact_declared=True),
        continuous.PairSpec(("a", "e"), ("RAIL", "INSERT"), 0.2, contact_declared=True),
        continuous.PairSpec(("a", "f"), ("RAIL", "PRESSED"), overlap_allowed=True),
    ]

    def setUp(self) -> None:
        self.world = BoxWorld(self.BODIES, lambda oid, s: (s["J-001"], 0.0, 0.0) if oid == "b" else None)
        self.report = self.world.check([self.PATH], self.PAIRS)

    def test_the_sampled_gaps_meet_the_minimum(self) -> None:
        for q in self.PATH.coordinates:
            distance, volume = self.world.exact(("a", "b"), {"J-001": q})
            self.assertAlmostEqual(distance, 0.3, places=9)
            self.assertEqual(volume, 0.0)

    def test_collision_free_is_proved_but_not_the_minimum(self) -> None:
        report = self.report
        self.assertEqual((report.status, report.exit_code), ("proved_collision_free", 0))
        self.assertEqual((report.between_sample_findings, report.collision_free_unproved_intervals), ([], []))
        (unproved,) = report.clearance_unproved_pairs
        self.assertEqual((unproved.pair, unproved.required_mm), (("a", "b"), 0.25))
        self.assertGreater(unproved.lower_mm, 0.0)
        self.assertLess(unproved.lower_mm, 0.25)
        self.assertEqual(report.original_intervals, 2 * 4)
        self.assertEqual(report.proved_collision_free_leaf_intervals, unproved.intervals + 3 * 2)
        self.assertEqual(report.proved_clearance_leaf_intervals, 3 * 2)  # b-c, a-c, a-e
        self.assertEqual(report.leaf_intervals, report.proved_collision_free_leaf_intervals)
        self.assertGreater(report.midpoints["mesh"], 0)

    def test_zero_minimum_pairs_are_checked_and_declared_ones_listed(self) -> None:
        report = self.report
        self.assertEqual(report.pairs_checked, 4)  # a-b, b-c, a-c and a-e, whose 0.2 mm overrides its contact
        self.assertEqual([row["pair"] for row in report.contact_pairs_sampled_only], [["a", "d"], ["a", "f"]])
        self.assertIn("contact declared", report.contact_pairs_sampled_only[0]["reason"])
        self.assertIn("overlap allowed", report.contact_pairs_sampled_only[1]["reason"])
        margin = report.smallest_proved_clearance_margin
        self.assertEqual((margin.pair, margin.required_mm), (("a", "e"), 0.2))
        self.assertAlmostEqual(margin.margin_mm, 4.8, places=9)

    def test_the_report_block(self) -> None:
        block = self.report.as_json()
        self.assertEqual(set(block), DESIGN_KEYS)
        json.dumps(block, allow_nan=False)
        self.assertEqual((block["guarantee"], block["rigorous"]), (continuous.GUARANTEE, False))
        self.assertEqual((block["grid"], block["safety_factor"], block["max_depth"]),
                         ({"deg": None, "mm": continuous.GRID_MM}, continuous.SAFETY, continuous.MAX_DEPTH))
        self.assertEqual(block["paths"][0]["intervals"], 8)
        lower = block["clearance_unproved_pairs"][0]["lower_mm"]
        self.assertLessEqual(lower, self.report.clearance_unproved_pairs[0].lower_mm)  # outward rounded
        self.assertEqual(lower, round(lower, 4))
        self.assertIn("not proven maxima", block["limitation"])
        self.assertIn("Jacobians", block["limitation"])

    def test_a_partition_merges_into_the_whole_run(self) -> None:
        """Pair proofs combine by conjunction: the blocks of two disjoint pair sets merge into the
        whole run's block, whichever order they come in."""
        whole = self.report.as_json()
        parts = [BoxWorld(self.BODIES, self.world.shift).check([self.PATH], pairs).as_json()
                 for pairs in (self.PAIRS[:1] + self.PAIRS[3:4], self.PAIRS[1:3] + self.PAIRS[4:])]
        self.assertEqual(continuous.merge(parts), whole)
        self.assertEqual(continuous.merge(parts[::-1]), whole)
        finding = BetweenSampleCollision("test_the_first_midpoint_catches_the_collision").check()[0].as_json()
        with self.assertRaises(ValueError):  # one path id over two ranges
            continuous.merge([whole, finding])
        finding["paths"] = [{**finding["paths"][0], "id": "turn:J-001"}]
        merged = continuous.merge([whole, finding])
        self.assertEqual((merged["status"], merged["grid"]), ("finding", {"deg": continuous.GRID_DEG, "mm": continuous.GRID_MM}))
        self.assertEqual(merged["original_intervals"], whole["original_intervals"] + 1)
        with self.assertRaises(ValueError):
            continuous.merge([whole, continuous.disabled().as_json()])
        with self.assertRaises(ValueError):
            continuous.merge([whole, {**parts[0], "grid": {"deg": None, "mm": 0.5}}])


class PathsAndRates(unittest.TestCase):
    def test_paths_are_never_joined(self) -> None:
        """Two sweeps sharing the nominal sample: a flattened sample list would join x+ to z-, whose
        straight-line midpoint collides; each path is proved along its own joint only."""
        bodies = {"a": ((5.0, 0.0, -5.0), (6.0, 1.0, -4.0)), "b": ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))}
        world = BoxWorld(bodies, lambda oid, s: (s["J-001"], 0.0, s["J-002"]) if oid == "b" else None)
        along_x = continuous.SweepPath("sweep:J-001", "J-001", "mm", (-10.0, 0.0, 10.0), ("x-", "nominal", "x+"), {"J-002": 0.0})
        along_z = continuous.SweepPath("sweep:J-002", "J-002", "mm", (-10.0, 0.0, 10.0), ("z-", "nominal", "z+"), {"J-001": 0.0})
        self.assertGreater(world.exact(("a", "b"), {"J-001": 5.0, "J-002": -5.0})[1], pose.INTERFERENCE_MM3)
        report = world.check([along_x, along_z], [continuous.PairSpec(("a", "b"), ("A", "B"))])
        self.assertEqual(report.status, "proved_collision_free")
        self.assertEqual((report.original_intervals, [path["intervals"] for path in report.paths]), (4, [2, 2]))
        self.assertTrue(world.requests)
        for request in world.requests:
            other = "J-002" if request.path.driver_joint == "J-001" else "J-001"
            self.assertEqual(request.settings[other], 0.0)
            self.assertTrue(-10.0 < request.coordinate < 10.0)

    RAMP = (1.0, 1.05, 1.10)  # the knots of a 1 mm ramp toward the rail and back, inside one fine cell

    @classmethod
    def ramp(cls, q: float) -> float:
        start, peak, end = cls.RAMP
        if start < q <= peak:
            return (q - start) / (peak - start)
        if peak < q < end:
            return (end - q) / (end - peak)
        return 0.0

    def ramp_world(self) -> tuple[BoxWorld, Any, Any]:
        bodies = {"a": ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)), "b": ((0.0, 1.5, 0.0), (1.0, 2.5, 1.0))}
        world = BoxWorld(bodies, lambda oid, s: (0.0, -self.ramp(s["J-001"]), 0.0) if oid == "b" else None)
        return world, continuous.SweepPath("cam:J-001", "J-001", "deg", (0.0, 2.0), (0, 1)), \
            continuous.PairSpec(("a", "b"), ("A", "B"))

    def test_a_known_ramp_keeps_its_own_cells(self) -> None:
        world, path, pair = self.ramp_world()
        self.assertGreater(world.exact(pair.ids, {"J-001": self.RAMP[1]})[1], pose.INTERFERENCE_MM3)
        report = world.check([path], [pair], breakpoints=self.RAMP)
        self.assertEqual((report.status, report.exit_code), ("finding", 1))
        (finding,) = report.between_sample_findings
        self.assertEqual(finding.kind, "collision")
        self.assertTrue(self.RAMP[0] < finding.coordinate < self.RAMP[2])

    def test_an_unmarked_ramp_is_the_stated_limitation(self) -> None:
        """Without its knots the ramp lies inside one fine cell, whose ends do not move: the sampled
        rate is 0 and the colliding interval reads proved. The report never claims rigour."""
        world, path, pair = self.ramp_world()
        report = world.check([path], [pair])
        self.assertEqual(report.status, "proved_collision_free")
        block = report.as_json()
        self.assertIs(block["rigorous"], False)
        self.assertEqual(block["guarantee"], "conditional_sampled_rate_and_mesh_envelope")
        self.assertIn("not proven maxima", block["limitation"])

    SEAM = {"input_unit": "deg", "output_unit": "mm", "period_deg": 360, "interpolation": "linear",
            "samples": [[0, 1.2], [0.05, 0], [359.95, 0], [360, 1.2]]}  # a 0.1-degree lift across the seam

    def test_a_ramp_across_the_profile_seam_of_a_720_degree_path_keeps_its_cells(self) -> None:
        """A cam profile whose lift wraps its 360-degree seam, on a crank path over 0..720: the
        samples at 350.1 and 370.1 are clear, no fine cell edge (350.1 + k/4) and no bisection
        midpoint falls in the lift. Without the seam's knots the interval reads proved; with
        incremental.breakpoints' knots the rate sees the lift and the leaves at the seam stay unproved."""
        incremental = load("cad_motion_incremental", SCRIPTS / "incremental.py")
        data = {"profiles": {"seam": self.SEAM}, "joints": [
            {"id": "J-001", "type": "revolute", "parent": "TST-0001", "child": "TST-0002", "axis": [0, 0, 1],
             "origin": [0, 0, 0], "min": 0, "max": 720, "nominal": 0},
            {"id": "J-002", "type": "prismatic", "parent": "TST-0001", "child": "TST-0003", "axis": [0, 0, 1],
             "origin": [0, 0, 0], "min": 0, "max": 2,
             "coupling": {"type": "periodic_table", "driver": "J-001", "profile": "seam", "phase_deg": 0.0}}]}
        chain = pose.build_chain([pose.make_joint(raw) for raw in data["joints"]], (), None, pose.coupling.parse(data))
        points = incremental.breakpoints(chain)["J-001"]
        for knot in (359.95, 360.0, 360.05, 719.95):
            self.assertTrue(any(abs(p - knot) <= 1e-9 for p in points), (knot, points))
        lift = lambda oid, s: (0.0, -chain.complete(s)["J-002"], 0.0) if oid == "b" else None  # noqa: E731
        world = BoxWorld({"a": ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)), "b": ((0.0, 1.5, 0.0), (1.0, 2.5, 1.0))}, lift)
        path = continuous.SweepPath("sweep:J-001", "J-001", "deg", (350.1, 370.1), (0, 1))
        pair = continuous.PairSpec(("a", "b"), ("A", "B"))
        self.assertGreater(world.exact(pair.ids, {"J-001": 360.0})[1], pose.INTERFERENCE_MM3)
        self.assertEqual(world.check([path], [pair]).status, "proved_collision_free")  # the stated limitation
        report = world.check([path], [pair], breakpoints=points)
        self.assertEqual((report.status, report.exit_code, report.between_sample_findings), ("unproved", 2, []))
        seam = [row for row in report.collision_free_unproved_intervals if row.low < 360.0 < row.high]
        self.assertEqual([(row.depth, row.reason) for row in seam], [(6, "not proved collision-free at depth 6")])

    def test_the_smaller_direction_bounds_the_rate(self) -> None:
        """A small cube turning about its own centre beside a long static bar: b's corners move
        little in a's frame, a's far corners sweep wide in b's; the smaller bounds the distance."""
        path = continuous.SweepPath("sweep:J-001", "J-001", "deg", (0.0, 90.0), (0, 1))
        boxes = {"a": Box((100.0, -1.0, -1.0), (102.0, 1.0, 1.0)), "b": Box((-1.0, -1.0, -1.0), (1.0, 1.0, 1.0))}
        rates = continuous.sample_rates(
            path, at=lambda q: {"a": IDENTITY, "b": pose.Rigid.rotation((0.0, 0.0, 1.0), q, (0.0, 0.0, 0.0))},
            boxes=boxes, pairs=[continuous.PairSpec(("a", "b"), ("A", "B"))], grid=continuous.GRID_DEG)
        self.assertAlmostEqual(rates.rate(("a", "b"), 0.0, 90.0), continuous.SAFETY * chord_rate(math.sqrt(2)), places=9)

    def test_an_invalid_fine_pose_leaves_its_interval_uncovered(self) -> None:
        bodies = {"a": ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)), "b": ((50.0, 0.0, 0.0), (51.0, 1.0, 1.0))}
        world = BoxWorld(bodies, static)
        path = continuous.SweepPath("sweep:J-001", "J-001", "deg", (0.0, 3.0, 7.0, 10.0), (0, 1, 2, 3))
        pair = continuous.PairSpec(("a", "b"), ("A", "B"))
        valid = world.at(path)
        rates = continuous.sample_rates(path, at=lambda q: None if 4.0 < q < 6.0 else valid(q), boxes=world.boxes(),
                                        pairs=[pair], grid=continuous.GRID_DEG)
        report = continuous.prove_between([path], pairs=[pair], endpoint=world.endpoints([path], [pair]),
                                          rates={path.id: rates}, evaluate_midpoints=world.evaluate,
                                          volume_tol=pose.INTERFERENCE_MM3)
        self.assertEqual((report.status, report.proved_collision_free_leaf_intervals), ("unproved", 2))
        (unproved,) = report.collision_free_unproved_intervals
        self.assertEqual((unproved.low, unproved.high), (3.0, 7.0))
        self.assertIn("no finite motion rate", unproved.reason)
        self.assertEqual(world.requests, [])


class LeafLabels(unittest.TestCase):
    def test_an_interval_never_proved_ends_in_64_labelled_leaves_at_depth_6(self) -> None:
        """Touching static boxes: every reading is 0 mm, so no leaf is ever proved and each sample
        interval bisects to MAX_DEPTH, 64 leaves of 1/64 of it, each labelled with its depth."""
        world = BoxWorld({"a": ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)), "b": ((1.0, 0.0, 0.0), (2.0, 1.0, 1.0))}, static)
        path = continuous.SweepPath("sweep:J-001", "J-001", "deg", (0.0, 64.0), (0, 1))
        report = world.check([path], [continuous.PairSpec(("a", "b"), ("A", "B"))])
        self.assertEqual(continuous.MAX_DEPTH, 6)
        self.assertEqual((report.status, report.original_intervals, report.leaf_intervals), ("unproved", 1, 64))
        self.assertEqual(report.midpoints["exact"], 63)  # 1 + 2 + ... + 32
        rows = [row.as_json() for row in report.collision_free_unproved_intervals]
        self.assertEqual([row["interval"] for row in rows], [[float(k), float(k + 1)] for k in range(64)])
        self.assertEqual({(row["depth"], row["reason"], row["lower_mm"]) for row in rows},
                         {(6, "not proved collision-free at depth 6", 0.0)})


class EndpointReadings(unittest.TestCase):
    """The per-sample lower bounds by method, on a static pair (rate 0)."""

    PAIR = continuous.PairSpec(("a", "b"), ("A", "B"))

    def check(self, outcomes: dict[Any, Any], sample_ids: tuple[Any, ...]) -> Any:
        path = continuous.SweepPath("sweep:J-001", "J-001", "deg", tuple(float(k) for k in range(len(sample_ids))), sample_ids)
        world = BoxWorld({"a": ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)), "b": ((5.0, 0.0, 0.0), (6.0, 1.0, 1.0))}, static)
        rates = continuous.sample_rates(path, at=world.at(path), boxes=world.boxes(), pairs=[self.PAIR], grid=1.0)
        endpoint = {(path.id, self.PAIR.ids, sample): outcome for sample, outcome in outcomes.items()}
        return continuous.prove_between([path], pairs=[self.PAIR], endpoint=endpoint, rates={path.id: rates},
                                        evaluate_midpoints=world.evaluate, volume_tol=pose.INTERFERENCE_MM3)

    def test_each_method_bounds_or_uncovers(self) -> None:
        report = self.check({0: Measured(4.0, 0.0), 1: Pruned(7, 0.8), 2: Cleared(0.7, math.inf, "box"),
                             3: Cleared(0.6, 4.1, "cache-bound"), 4: Failure("BRepExtrema failed")}, (0, 1, 2, 3, 4, 5))
        self.assertEqual((report.status, report.proved_collision_free_leaf_intervals), ("unproved", 3))
        self.assertEqual(report.smallest_proved_clearance_margin.margin_mm, 0.6)
        reasons = [(u.low, u.high, u.reason) for u in report.collision_free_unproved_intervals]
        self.assertEqual([r[:2] for r in reasons], [(3.0, 4.0), (4.0, 5.0)])
        self.assertIn("failed: BRepExtrema failed", reasons[0][2])
        self.assertIn("failed: BRepExtrema failed", reasons[1][2])
        report = self.check({0: Measured(4.0, 0.0)}, (0, 1, None))
        self.assertEqual([u.reason.split(": ", 1)[1] for u in report.collision_free_unproved_intervals],
                         ["no reading", "no reading"])
        report = self.check({0: Measured(4.0, 0.0), 1: Measured(4.0, 0.0)}, (0, 1, None))
        self.assertIn("no valid sample", report.collision_free_unproved_intervals[0].reason)
        report = self.check({0: Cleared(0.5, 4.2, "mesh"), 1: Measured(4.0, 0.0)}, (0, 1))  # a mesh bound
        self.assertEqual((report.status, report.proved_collision_free_leaf_intervals), ("proved_collision_free", 1))
        self.assertEqual(report.smallest_proved_clearance_margin.margin_mm, 0.5)

    def test_a_suspect_never_qualifies(self) -> None:
        report = self.check({0: Measured(4.0, 0.0), 1: Suspect((3,), 4.0, 0.0, 3.9, 4.1)}, (0, 1))
        self.assertEqual(report.status, "unproved")
        self.assertIn("suspect", report.collision_free_unproved_intervals[0].reason)

    def test_a_sampled_collision_is_not_refined(self) -> None:
        report = self.check({0: Measured(0.0, 0.5), 1: Measured(4.0, 0.0)}, (0, 1))
        self.assertEqual((report.status, report.between_sample_findings), ("unproved", []))
        self.assertIn("sampled endpoint", report.collision_free_unproved_intervals[0].reason)

    def test_an_unknown_outcome_is_refused(self) -> None:
        with self.assertRaises(TypeError):
            self.check({0: (4.0, 0.0), 1: Measured(4.0, 0.0)}, (0, 1))


class Settings(unittest.TestCase):
    PATH = continuous.SweepPath("sweep:J-001", "J-001", "deg", (0.0, 1.0), (0, 1))

    def test_invalid_settings_are_refused(self) -> None:
        for grid in (0.0, -0.25, math.inf, math.nan):
            with self.subTest(grid=grid), self.assertRaises(ValueError):
                continuous.sample_rates(self.PATH, at=lambda q: {}, boxes={}, pairs=[], grid=grid)
        with self.assertRaises(ValueError):
            continuous.sample_rates(self.PATH, at=lambda q: {}, boxes={}, pairs=[], grid=0.25, safety=0.99)
        for depth in (-1, 7, 2.0):
            with self.subTest(depth=depth), self.assertRaises(ValueError):
                continuous.prove_between([], pairs=[], endpoint={}, rates={}, evaluate_midpoints=dict,
                                         volume_tol=pose.INTERFERENCE_MM3, max_depth=depth)
        for coordinates in ((1.0, 0.0), (0.0, 0.0), (0.0, math.nan)):
            with self.subTest(coordinates=coordinates), self.assertRaises(ValueError):
                continuous.SweepPath("p", "J-001", "deg", coordinates, (0, 1))
        with self.assertRaises(ValueError):
            continuous.SweepPath("p", "J-001", "rad", (0.0, 1.0), (0, 1))

    def test_disabled_stays_sampled_only(self) -> None:
        report = continuous.disabled()
        block = report.as_json()
        self.assertEqual((block["status"], report.exit_code, block["rigorous"]), ("disabled", 0, False))
        self.assertEqual(set(block), DESIGN_KEYS)
        self.assertIn("only the sampled poses", block["limitation"])


if __name__ == "__main__":
    unittest.main()
