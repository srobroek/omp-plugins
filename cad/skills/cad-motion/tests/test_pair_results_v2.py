"""cad-motion pair results v2 (pair_measure.py, pose.py identity): cache keys and their guard,
geometry and rule invalidation, warm reruns, suspects, task chunks and resume.

The kernel-free tests stand in for OCP: a definition is a ball (centre, radius) whose box is its
bounding box, the kernel measures the balls' distance, and a mesh stand-in reports that distance
with a fixed deviation. The real-geometry tests run tests/fixtures/measure_probe.py --session.
"""

from __future__ import annotations

import contextlib
import dataclasses
import hashlib
import importlib.util
import io
import json
import math
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

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
pm = load("cad_motion_pair_measure", SCRIPTS / "pair_measure.py")
Rigid = pose.Rigid


@dataclasses.dataclass(frozen=True)
class Ball:
    name: str
    centre: tuple[float, float, float]
    radius: float

    @property
    def box(self) -> tuple[list[float], list[float]]:
        return [c - self.radius for c in self.centre], [c + self.radius for c in self.centre]


def ball_distance(a: Ball, b: Ball, placement) -> tuple[float, float]:
    """The kernel stand-in: the distance of ball a and ball b placed by `placement`, 0 with a
    positive volume where they overlap."""
    gap = math.dist(a.centre, placement.apply(b.centre)) - a.radius - b.radius
    return (gap, 0.0) if gap > 0.0 else (0.0, 1.0)


class FakeMesh:
    """mesh_bound.MeshBounds' stand-in: the kernel stand-in's distance (+ `offset`, per pair of
    names) with DEVIATION_MM per definition; `calls` counts queries."""

    DEVIATION_MM = 0.05

    def __init__(self, shapes: dict[str, Ball], linear: float = 0.02, angular: float = 0.2) -> None:
        self.shapes, self.linear, self.angular = shapes, linear, angular
        self.offset: dict[tuple[str, str], float] = {}
        self.calls = 0

    def settings(self) -> dict:
        return {"linear_mm": self.linear, "angular_rad": self.angular, "deviation_factor": 2.0, "python_fcl": "stand-in"}

    def query(self, a: str, b: str, placement):
        self.calls += 1
        distance = ball_distance(self.shapes[a], self.shapes[b], placement)[0] + self.offset.get((a, b), 0.0)
        spread = 2 * self.DEVIATION_MM
        lower = distance - spread if distance - spread > pose.SOLID_GAP_MM else 0.0
        return types.SimpleNamespace(lower_mm=lower, upper_mm=distance + spread, mesh_mm=distance,
                                     deviation_a_mm=self.DEVIATION_MM, deviation_b_mm=self.DEVIATION_MM)


def geometry(name: str, version: int = 1) -> bytes:
    return hashlib.sha256(f"stand-in geometry {name} v{version}".encode()).digest()


def diagonal(offset: float) -> Rigid:
    return Rigid(Rigid.identity().rot, (offset, offset, offset))


class Kernel:
    """Patches OCP out of pair_measure: box corners from the balls, placement as (shape, rigid), and
    the kernel; `calls` lists (a name, b name, placement) per kernel measurement."""

    def __init__(self, override=None) -> None:
        self.calls: list[tuple[str, str, Rigid]] = []
        self.override = override  # (a, b, placement) -> (distance, volume) | None
        self.corner_calls = 0

    @contextlib.contextmanager
    def active(self):
        def interference(shape, moved, box_gap=0.0, threads=False):
            other, placement = moved
            self.calls.append((shape.name, other.name, placement))
            found = self.override(shape, other, placement) if self.override else None
            return found if found is not None else ball_distance(shape, other, placement)

        def corners(shape, tolerance=False):
            self.corner_calls += 1
            return shape.box

        with mock.patch.object(pose, "box_corners", side_effect=corners), \
                mock.patch.object(pose, "placed", side_effect=lambda shape, rigid: (shape, rigid)), \
                mock.patch.object(pose, "interference", side_effect=interference):
            yield self


class Case(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.folder)
        self.shapes = {"A": Ball("A", (0.0, 0.0, 0.0), 1.0), "B": Ball("B", (0.0, 0.0, 0.0), 1.0),
                       "C": Ball("C", (0.0, 0.0, 0.0), 2.0), "D": Ball("D", (0.0, 0.0, 0.0), 0.5)}
        self.ids = {key: geometry(key) for key in self.shapes}

    def run_measure(self, requests, *, mesh=None, rule=None, cache=True, prune=False, kernel=None, ids=None,
                    neighbours=None, on_chunk=None, threads=False):
        """(outcomes, the kernel, the measurer, the session's suspects) of one fresh measurer over
        the pair cache in self.folder."""
        kernel = kernel or Kernel()
        store = pm.PairCache(self.folder) if cache else None
        if store is not None:
            self.addCleanup(store.close)
        measurer = pm.PairMeasurer(self.shapes, geometry_ids=ids or self.ids, rule=rule or pm.RuleVersion.current(mesh),
                                   cache=store, mesh=mesh, threads=threads)
        with kernel.active(), measurer.session() as session:
            outcomes = session.measure(requests, prune=prune, neighbours=neighbours, on_chunk=on_chunk)
            suspects = session.suspects
        if store is not None:
            store.close()
        return outcomes, kernel, measurer, suspects


def bits(outcome) -> object:
    """An outcome with a Measured reading's IEEE bits spelled out."""
    if isinstance(outcome, pm.Measured):
        return ("measured", outcome.distance_mm.hex(), outcome.overlap_mm3.hex())
    return outcome


class WarmRerunTests(Case):
    """A warm rerun answers every request from the cache: no kernel measurement, no mesh query."""

    def requests(self):
        # Two unit balls along the diagonal at s(1, 1, 1): box gap sqrt(3)(s - 2), distance sqrt(3)s - 2.
        # Cap 2 mm (no minimum, band 2): s 1.5 and 2.2 are measured, 2.6 is cleared by the mesh only
        # (box gap 1.04), 4 by the box gap; the exact-mode and C-D requests are measured.
        out = []
        for s in (1.5, 2.2, 2.6, 4.0):
            out.append(pm.Request("A", "B", diagonal(s), group=("a", "b"), sample_id=f"s{s}"))
            out.append(pm.Request("A", "C", diagonal(s + 1.0), group=("a", "c"), mode="exact"))
            out.append(pm.Request("C", "D", diagonal(s + 0.5), group=("c", "d"), minimum_mm=0.5))
        return out

    def test_a_warm_rerun_reads_every_result_back_without_kernel_or_mesh_work(self) -> None:
        mesh = FakeMesh(self.shapes)
        cold, _, measured, _ = self.run_measure(self.requests(), mesh=mesh, prune=True)
        self.assertGreater(measured.counters.kernel_evaluations, 0)
        self.assertGreater(measured.counters.fcl_queries, 0)
        self.assertGreater(measured.counters.cleared["mesh"], 0)
        self.assertGreater(measured.counters.cleared["box"], 0)
        warm_mesh = FakeMesh(self.shapes)
        warm, kernel, measurer, _ = self.run_measure(self.requests(), mesh=warm_mesh, prune=True)
        self.assertEqual((kernel.calls, warm_mesh.calls, measurer.counters.kernel_evaluations,
                          measurer.counters.fcl_queries), ([], 0, 0, 0))
        self.assertGreater(measurer.counters.exact_hits, 0)
        self.assertGreater(measurer.counters.decision_hits, 0)
        self.assertEqual([type(o) for o in warm], [type(o) for o in cold])
        self.assertEqual([bits(o) for o in warm if not isinstance(o, pm.Pruned)],
                         [bits(o) for o in cold if not isinstance(o, pm.Pruned)])

    def test_one_evaluation_per_unit_and_reversed_operands_are_the_same_evaluation(self) -> None:
        placement = diagonal(1.5)
        requests = [pm.Request("A", "B", placement, mode="exact"), pm.Request("A", "B", placement, mode="exact"),
                    pm.Request("B", "A", placement.inverse(), mode="exact")]
        outcomes, kernel, measurer, _ = self.run_measure(requests)
        self.assertEqual(len(kernel.calls), 1)
        self.assertEqual(measurer.counters.reused, 2)
        self.assertEqual(len({bits(o) for o in outcomes}), 1)


class GeometryIdentityTests(Case):
    """Results are keyed by geometry identity: one changed definition recomputes only its pairs."""

    def requests(self):
        placements = (diagonal(1.5), Rigid.rotation((0.0, 0.0, 1.0), 30.0, (0.5, 0.0, 0.0)) @ diagonal(2.0))
        pairs = (("A", "B"), ("A", "C"), ("B", "C"), ("C", "D"), ("A", "A"))  # A-A: two occurrences of one PN
        return [pm.Request(a, b, placement, mode="exact") for a, b in pairs for placement in placements]

    def test_one_changed_definition_misses_only_its_pairs_and_the_rest_read_back_bitwise(self) -> None:
        cold, kernel, _, _ = self.run_measure(self.requests())
        self.assertEqual(len(kernel.calls), 10)
        ids = {**self.ids, "C": geometry("C", 2)}
        warm, kernel, measurer, _ = self.run_measure(self.requests(), ids=ids)
        self.assertEqual(sorted({tuple(sorted((a, b))) for a, b, _ in kernel.calls}), [("A", "C"), ("B", "C"), ("C", "D")])
        self.assertEqual(len(kernel.calls), 6)
        self.assertEqual(measurer.counters.exact_hits, 4)
        untouched = [i for i, r in enumerate(self.requests()) if "C" not in (r.a, r.b)]
        self.assertEqual([bits(warm[i]) for i in untouched], [bits(cold[i]) for i in untouched])

    def test_a_moved_placement_misses_only_that_pair_pose(self) -> None:
        self.run_measure(self.requests())
        requests = self.requests()
        requests[0] = dataclasses.replace(requests[0], placement=diagonal(1.75))
        _, kernel, _, _ = self.run_measure(requests)
        self.assertEqual([tuple(sorted((a, b))) for a, b, _ in kernel.calls], [("A", "B")])

    def test_step_data_hash_reads_only_the_data_sections(self) -> None:
        header = "ISO-10303-21;\nHEADER;\nFILE_NAME('part.step','{stamp}',('x'),(''),'','','');\nENDSEC;\n"
        data = ("DATA;\n#1=PRODUCT('TST-0001 a; ENDSEC; DATA;','',' ''quoted'' ',(#2));\n/* DATA; ENDSEC; */\n"
                "#2=PRODUCT_CONTEXT('',#3,'mechanical');\nENDSEC;\n")
        trailer = "END-ISO-10303-21;\n"

        def digest(text: str) -> bytes:
            path = self.folder / "probe.step"
            path.write_text(text, encoding="utf-8")
            return pose.step_data_hash(path)

        base = digest(header.format(stamp="2026-10-30T10:00:00") + data + trailer)
        self.assertEqual(digest(header.format(stamp="2027-01-01T00:00:00") + data + trailer), base)
        self.assertEqual(digest(header.format(stamp="x") + data + "END-ISO-10303-21;"), base)
        self.assertNotEqual(digest(header.format(stamp="x") + data.replace("mechanical", "electrical") + trailer), base)
        self.assertNotEqual(digest(header.format(stamp="x") + data.replace("#2=", "#4=") + trailer), base)
        second = "DATA(('one'));\n#9=DUMMY();\nENDSEC;\n"
        two = digest(header.format(stamp="x") + data + second + trailer)
        self.assertNotEqual(two, base)
        self.assertNotEqual(digest(header.format(stamp="x") + second + data + trailer), two)
        for broken, message in ((header + trailer, "no STEP DATA section"),
                                (header + "DATA;\n#1=X('open);\nENDSEC;\n", "unterminated STEP string"),
                                (header + "DATA;\n#1=X();\n/* open\n", "unterminated STEP comment"),
                                (header + "DATA;\n#1=X();\n", "has no ENDSEC")):
            with self.subTest(message=message), self.assertRaisesRegex(pose.MotionError, message):
                digest(broken.format(stamp="x"))

    def test_geometry_ids_use_step_provenance_else_a_tagged_brep_hash(self) -> None:
        provenance = hashlib.sha256(b"from a STEP file").digest()
        parts = {"A": pose.Part("A", "A", "shape a", provenance), "B": pose.Part("B", "B", "shape b")}
        with mock.patch.object(pose, "shape_bytes", side_effect=lambda shape: shape.encode()) as brep:
            ids = pose.geometry_ids(parts)
        self.assertEqual(brep.call_args_list, [mock.call("shape b")])
        self.assertEqual(ids["A"], provenance)
        self.assertEqual(ids["B"], hashlib.sha256(pose.BREP_TAG + b"shape b").digest())
        self.assertNotEqual(ids["B"], hashlib.sha256(pose.STEP_DATA_TAG + b"shape b").digest())


class BucketGuardTests(Case):
    """A rounded bucket is a lookup, never equality: another placement in it gives a widened
    interval that may clear a request, never an exact reading."""

    def setUp(self) -> None:
        super().setUp()
        # A long-radius definition: ball F's centre 1000 mm from its origin, so a rotation moves it far.
        self.shapes["F"] = Ball("F", (1000.0, 0.0, 0.0), 1.0)
        self.shapes["G"] = Ball("G", (0.0, 0.0, 0.0), 10.0)
        # G's identity sorts first, so G-F requests keep their operand order and placement bits.
        self.ids.update(F=geometry("F"), G=bytes(32))

    def pair(self, delta: float = 0.0, distance: float = 5.0) -> Rigid:
        """F placed in G's frame so its centre sits on G's diagonal, `distance` from G's surface, the
        rotation turned `delta` degrees about z: the box gap is 0 though the balls are apart."""
        turned = Rigid.rotation((0.0, 0.0, 1.0), 45.0 + delta, (0.0, 0.0, 0.0))
        target = (10.0 + 1.0 + distance) / math.sqrt(3.0)
        moved = turned.apply((1000.0, 0.0, 0.0))
        return Rigid(turned.rot, tuple(t - m for t, m in zip((target, target, target), moved)))

    def neighbour(self, placement: Rigid) -> Rigid:
        """`placement` with its rotation entries moved by 1e-9: another exact fingerprint, same bucket."""
        rot = tuple(tuple(v + 1e-9 for v in row) for row in placement.rot)
        nudged = Rigid(rot, placement.trans)
        self.assertNotEqual(pm.exact_fingerprint(nudged), pm.exact_fingerprint(placement))
        self.assertEqual(pm._rounded(nudged), pm._rounded(placement))
        return nudged

    def test_a_bucket_neighbour_is_cleared_cache_bound_by_a_bracketing_interval_and_never_read_exact(self) -> None:
        stored = self.pair()
        self.run_measure([pm.Request("G", "F", stored, mode="exact")])
        nudged = self.neighbour(stored)
        exact = ball_distance(self.shapes["G"], self.shapes["F"], nudged)[0]
        far, kernel, measurer, _ = self.run_measure([pm.Request("G", "F", nudged)])
        self.assertEqual(kernel.calls, [])
        cleared = far[0]
        self.assertIsInstance(cleared, pm.Cleared)
        self.assertEqual(cleared.method, "cache-bound")
        self.assertLessEqual(cleared.lower_mm, exact)
        self.assertGreaterEqual(cleared.upper_mm, exact)
        self.assertEqual(measurer.counters.bucket_hits, 1)
        exact_mode, kernel, _, _ = self.run_measure([pm.Request("G", "F", nudged, mode="exact")])
        self.assertEqual(len(kernel.calls), 1)
        self.assertEqual(bits(exact_mode[0]), bits(pm.Measured(exact, 0.0)))

    def test_a_bucket_neighbour_straddling_its_cap_is_evaluated(self) -> None:
        one = self.pair(distance=3.0)
        other = self.neighbour(one)
        far, near = sorted((one, other), key=lambda p: -ball_distance(self.shapes["G"], self.shapes["F"], p)[0])
        stored_exact, exact = (ball_distance(self.shapes["G"], self.shapes["F"], p)[0] for p in (far, near))
        self.assertGreater(stored_exact, exact)
        self.run_measure([pm.Request("G", "F", far, mode="exact")])
        # cap = minimum + band, between the two: the stored reading clears it, the neighbour's own distance does not.
        minimum = (stored_exact + exact) / 2 - pm.MESH_BAND_MM
        outcomes, kernel, _, _ = self.run_measure([pm.Request("G", "F", near, minimum_mm=minimum)])
        self.assertEqual(len(kernel.calls), 1)
        self.assertEqual(bits(outcomes[0]), bits(pm.Measured(exact, 0.0)))

    def test_signed_zero_and_inverted_placements_share_a_bucket_but_not_an_exact_reading(self) -> None:
        self.ids["A"] = bytes(32)  # A first: the requests' own placements are evaluated, -0 kept
        plus, minus = Rigid(Rigid.identity().rot, (3.0, 0.0, 0.0)), Rigid(Rigid.identity().rot, (3.0, -0.0, 0.0))
        self.assertEqual(pm._rounded(plus), pm._rounded(minus))
        self.run_measure([pm.Request("A", "B", plus, mode="exact")])
        _, kernel, measurer, _ = self.run_measure([pm.Request("A", "B", minus, mode="exact")])
        self.assertEqual((len(kernel.calls), measurer.counters.exact_hits), (1, 0))
        _, kernel, measurer, _ = self.run_measure([pm.Request("B", "A", plus.inverse(), mode="exact")])
        self.assertEqual((kernel.calls, measurer.counters.exact_hits), ([], 1))  # an exact inverse: the same reading

    def test_an_overlap_is_never_carried_to_a_bucket_neighbour(self) -> None:
        stored = Rigid(Rigid.identity().rot, (1.0, 0.0, 0.0))  # A and B overlap
        self.run_measure([pm.Request("A", "B", stored, mode="exact")])
        nudged = self.neighbour(stored)
        outcomes, kernel, _, _ = self.run_measure([pm.Request("A", "B", nudged)])
        self.assertEqual(len(kernel.calls), 1)
        self.assertIsInstance(outcomes[0], pm.Measured)


class RuleVersionTests(Case):
    """Every input of the rule invalidates; worker counts and threads do not."""

    def test_each_rule_input_changes_the_digest_and_misses_the_cache(self) -> None:
        mesh = FakeMesh(self.shapes)
        rule = pm.RuleVersion.current(mesh)
        self.assertEqual(rule.digest, pm.RuleVersion.current(FakeMesh(self.shapes)).digest)
        variants = {
            "source": dataclasses.replace(rule, sources={**rule.sources, "pose.py": "0" * 64}),
            "revision": dataclasses.replace(rule, revision=rule.revision + 1),
            "fuzzy": dataclasses.replace(rule, constants={**rule.constants, "FUZZY_MM": 2e-7}),
            "gate": dataclasses.replace(rule, constants={**rule.constants, "OVERLAP_GATE_MM": 2e-6}),
            "linear": pm.RuleVersion.current(FakeMesh(self.shapes, linear=0.01)),
            "angular": pm.RuleVersion.current(FakeMesh(self.shapes, angular=0.1)),
            "deviation": dataclasses.replace(rule, mesh={**rule.mesh, "deviation_factor": 3.0}),
            "band": pm.RuleVersion.current(mesh, band_mm=1.0),
            "library": dataclasses.replace(rule, libraries={**rule.libraries, "ocp": "OCP 9"}),
            "platform": dataclasses.replace(rule, platform={**rule.platform, "machine": "other"}),
            "no mesh": pm.RuleVersion.current(None),
        }
        with mock.patch.object(pose, "FUZZY_MM", 3e-7):
            variants["current fuzzy"] = pm.RuleVersion.current(mesh)
        requests = [pm.Request("A", "B", diagonal(s), mode="exact") for s in (1.5, 2.2)]
        self.run_measure(requests, rule=rule)
        for name, variant in variants.items():
            with self.subTest(changed=name):
                self.assertNotEqual(variant.digest, rule.digest)
                _, kernel, _, _ = self.run_measure(requests, rule=variant)
                self.assertEqual(len(kernel.calls), 2)
        _, kernel, _, _ = self.run_measure(requests, rule=rule, threads=True)
        self.assertEqual(kernel.calls, [])
        self.assertIsInstance(json.dumps(rule.as_json()), str)


class SuspectTests(Case):
    """A reading its own bounds contradict answers nothing until its re-evaluations resolve it."""

    # A unit ball and a radius-10 ball on the diagonal: boxes touching (gap 0), balls 8.05 mm apart,
    # the documented case of an exact 0 against a mesh distance of about 8.
    ORIGINAL = diagonal(11.0)

    def setUp(self) -> None:
        super().setUp()
        self.shapes["G"] = Ball("G", (0.0, 0.0, 0.0), 10.0)
        self.ids["G"] = geometry("G")

    @staticmethod
    def broken(*, always: bool) -> Kernel:
        """A kernel reading 0 for its first measurement, or for every one."""
        kernel = Kernel()
        kernel.override = lambda a, b, placement: (0.0, 0.0) if always or len(kernel.calls) == 1 else None
        return kernel

    def request(self, **fields) -> object:
        return pm.Request("A", "G", self.ORIGINAL, mode="exact", minimum_mm=1.0, **fields)

    def test_an_unresolved_suspect_fails_and_is_never_stored(self) -> None:
        outcomes, kernel, _, suspects = self.run_measure([self.request()], mesh=FakeMesh(self.shapes),
                                                         kernel=self.broken(always=True))
        self.assertIsInstance(outcomes[0], pm.Failure)
        (suspect,) = suspects
        self.assertEqual((suspect.distance_mm, suspect.resolved), (0.0, False))
        self.assertGreater(suspect.lower_mm, 7.9)
        self.assertEqual(sorted(label for label, _, _ in suspect.reevaluated), ["+0.01 mm", "-0.01 mm", "swapped"])
        self.assertEqual(len(kernel.calls), 4)
        _, kernel, _, suspects = self.run_measure([self.request()], mesh=FakeMesh(self.shapes),
                                                  kernel=self.broken(always=True))
        self.assertEqual(len(kernel.calls), 4)  # nothing of it was cached
        self.assertFalse(suspects[0].cached)

    def test_a_resolved_suspect_reads_as_its_bounds_and_a_warm_run_reports_it_again(self) -> None:
        requests = [self.request(), self.request(require_exact=True)]
        asked = []
        outcomes, kernel, _, suspects = self.run_measure(
            requests, mesh=FakeMesh(self.shapes), kernel=self.broken(always=False),
            neighbours=lambda index: asked.append(index) or [("independent +0.1", diagonal(11.01)),
                                                              ("independent -0.1", diagonal(10.99))])
        self.assertEqual((asked, len(kernel.calls)), ([0], 4))
        cleared, required = outcomes
        self.assertIsInstance(cleared, pm.Cleared)
        self.assertEqual(cleared.method, pm.SUSPECT_METHOD)
        self.assertIsInstance(required, pm.Failure)  # an exact-required request never reads a bound
        (suspect,) = suspects
        self.assertTrue(suspect.resolved)
        self.assertEqual(suspect.replacement, cleared)
        warm, kernel, measurer, suspects = self.run_measure(requests[:1], mesh=FakeMesh(self.shapes),
                                                            kernel=self.broken(always=False))
        self.assertEqual((kernel.calls, measurer.counters.fcl_queries), ([], 0))
        self.assertEqual(warm, [cleared])
        (cached,) = suspects
        self.assertTrue(cached.cached and cached.resolved)
        self.assertEqual((cached.distance_mm, len(cached.reevaluated)), (0.0, 3))


class QueueTests(Case):
    """Tasks of at most 24 units, each committed before it is reported; a stopped run resumes."""

    def requests(self, count: int = 25):
        return [pm.Request("A", "B", diagonal(1.2 + 0.01 * k), mode="exact") for k in range(count)]

    def test_tasks_hold_at_most_24_units_and_outcomes_stay_in_request_order(self) -> None:
        chunks = []
        outcomes, _, measurer, _ = self.run_measure(self.requests(), on_chunk=chunks.append)
        self.assertEqual([len(chunk.requests) for chunk in chunks], [24, 1])
        self.assertEqual(sorted(i for chunk in chunks for i in chunk.requests), list(range(25)))
        self.assertEqual(measurer.counters.committed_chunks, 2)
        want = [ball_distance(self.shapes["A"], self.shapes["B"], r.placement)[0] for r in self.requests()]
        self.assertEqual([o.distance_mm for o in outcomes], want)

    def test_a_run_stopped_after_a_committed_chunk_resumes_from_it(self) -> None:
        class Stop(Exception):
            pass

        def stop(chunk) -> None:
            raise Stop

        with self.assertRaises(Stop):
            self.run_measure(self.requests(), on_chunk=stop)
        resumed, kernel, measurer, _ = self.run_measure(self.requests())
        self.assertEqual((len(kernel.calls), measurer.counters.exact_hits), (1, 24))
        clean, _, _, _ = self.run_measure(self.requests(), cache=False)
        self.assertEqual([bits(o) for o in resumed], [bits(o) for o in clean])

    def test_a_passed_deadline_answers_nothing(self) -> None:
        kernel = Kernel()
        measurer = pm.PairMeasurer(self.shapes, geometry_ids=self.ids, rule=pm.RuleVersion.current())
        with kernel.active(), measurer.session() as session:
            self.assertEqual(session.measure(self.requests(3), deadline=0.0), [None, None, None])
        self.assertEqual(kernel.calls, [])

    def test_given_box_gaps_spare_the_parent_every_brep_box(self) -> None:
        requests = [pm.Request("A", "B", diagonal(10.0), box_gap_mm=5.0) for _ in range(3)]
        outcomes, kernel, _, _ = self.run_measure(requests, cache=False)
        self.assertEqual((kernel.calls, kernel.corner_calls), ([], 0))
        self.assertEqual(outcomes, [pm.Cleared(5.0, math.inf, "box")] * 3)

    def test_requests_validate_their_mode_and_minimum(self) -> None:
        for fields in ({"mode": "fast"}, {"minimum_mm": -1.0}, {"minimum_mm": math.inf}):
            with self.subTest(**fields), self.assertRaises(ValueError):
                pm.Request("A", "B", Rigid.identity(), **fields)


class PairCacheTests(Case):
    """hw/.cad/pairs-v2.sqlite: narrow ignores, graceful disable, bounded size."""

    def test_the_cache_ignores_exactly_its_own_files(self) -> None:
        (self.folder / ".gitignore").write_text("other\npairs-v2.sqlite", encoding="utf-8")
        pm.PairCache(self.folder).close()
        pm.PairCache(self.folder).close()
        self.assertEqual((self.folder / ".gitignore").read_text(encoding="utf-8").splitlines(),
                         ["other", "pairs-v2.sqlite", "pairs-v2.sqlite-wal", "pairs-v2.sqlite-shm"])
        self.assertEqual(pm.default_cache_dir(Path("hw")), Path("hw") / ".cad")

    def test_a_corrupt_or_unusable_cache_evaluates_without_it_and_says_so(self) -> None:
        (self.folder / "corrupt").mkdir()
        (self.folder / "corrupt" / pm.CACHE_FILE).write_bytes(b"not a database " * 100)
        (self.folder / "taken").write_text("a file where the cache directory goes", encoding="utf-8")
        clean, _, _, _ = self.run_measure(WarmRerunTests.requests(self), cache=False)
        for name in ("corrupt", "taken"):
            with self.subTest(name=name), contextlib.redirect_stderr(io.StringIO()) as err:
                store = pm.PairCache(self.folder / name)
                measurer = pm.PairMeasurer(self.shapes, geometry_ids=self.ids, rule=pm.RuleVersion.current(),
                                           cache=store)
                kernel = Kernel()
                with kernel.active(), measurer.session() as session:
                    outcomes = session.measure(WarmRerunTests.requests(self))
                store.close()
                self.assertIn("is unusable, measuring without it", err.getvalue())
                self.assertEqual([bits(o) for o in outcomes], [bits(o) for o in clean])

    def test_past_the_size_cap_the_oldest_rows_go(self) -> None:
        requests = [pm.Request("A", "B", diagonal(1.2 + 0.001 * k), mode="exact") for k in range(400)]
        self.run_measure(requests)
        with contextlib.closing(sqlite3.connect(self.folder / pm.CACHE_FILE)) as connection:
            page_size, pages, free = (connection.execute(f"PRAGMA {name}").fetchone()[0]
                                      for name in ("page_size", "page_count", "freelist_count"))
        capped = pm.PairCache(self.folder, max_bytes=(pages - free) * page_size // 2)
        capped.close()
        _, kernel, _, _ = self.run_measure(requests)
        self.assertTrue(100 < len(kernel.calls) < 400, len(kernel.calls))
        measured = {round(abs(placement.trans[0]), 6) for _, _, placement in kernel.calls}  # either operand order
        self.assertEqual(measured, {round(1.2 + 0.001 * k, 6) for k in range(len(kernel.calls))})  # the oldest went


class SpotCheckFloorTests(unittest.TestCase):
    """spot_check.audit's strict floor, threshold + band - 2 x deflection: a mesh-cleared request
    measured exactly at the floor fails the audit, one ulp above it passes."""

    CLEARING, BAND, DEFLECTION = 1.0, 2.0, 0.25  # binary fractions: the floor is exactly 2.5

    def audit(self, exact: float) -> dict:
        spot = load("cad_motion_spot_check", SCRIPTS / "spot_check.py")
        pair = ("a", "b")
        sample = types.SimpleNamespace(index=0, values={}, settings={"J-001": 0.0})
        chain = types.SimpleNamespace(relative_transforms=lambda values, pairs: {pair: diagonal(3.0)},
                                      pn=lambda oid: oid.upper(), ref=lambda oid: oid)
        plan = types.SimpleNamespace(samples=[types.SimpleNamespace(sample=sample)], measured=[pair],
                                     clearing={pair: self.CLEARING})
        session = types.SimpleNamespace(measure=lambda requests, deadline: [pm.Measured(exact, 0.0) for _ in requests])
        mesh = types.SimpleNamespace(query=lambda a, b, placement: types.SimpleNamespace(mesh_mm=exact))
        picks = [{"pair": 0, "sample": 0, "lower": 2.0, "upper": 3.0}]
        return spot.audit(chain, plan, picks, session, mesh, self.BAND, self.DEFLECTION, math.inf)

    def test_a_reading_exactly_at_the_strict_floor_fails_and_one_above_passes(self) -> None:
        floor = self.CLEARING + self.BAND - 2 * self.DEFLECTION
        self.assertGreater(floor, pose.OVERLAP_GATE_MM)
        at = self.audit(floor)
        self.assertEqual((at["checks"][0]["floor_mm"], at["checks"][0]["ok"]), (2.5, False))
        self.assertEqual(len(at["failures"]), 1)
        above = self.audit(math.nextafter(floor, math.inf))
        self.assertEqual((above["checks"][0]["ok"], above["failures"]), (True, []))



@unittest.skipUnless(shutil.which("uv"), "uv is required to build and read STEP through OCP")
class RealGeometryTests(unittest.TestCase):
    """fixtures/measure_probe.py --session on the built fixtures: STEP DATA identity, a warm rerun
    without kernel or FCL work through worker processes, jobs 1 and 4 alike, one worker start per
    session, and posed mesh boxes once per occurrence."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        build = subprocess.run(["uv", "run", "--quiet", "--script", str(HERE / "fixtures" / "build_fixtures.py"),
                                str(root / "fx")], capture_output=True, text=True, check=False, timeout=900)
        if build.returncode != 0:
            raise AssertionError(build.stderr[-2000:])
        proc = subprocess.run(["uv", "run", "--quiet", "--script", str(HERE / "fixtures" / "measure_probe.py"),
                               str(root / "fx"), "--session"], capture_output=True, text=True, check=False, timeout=1800)
        if proc.returncode != 0:
            raise AssertionError(proc.stderr[-4000:])
        cls.report = json.loads(proc.stdout)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_step_data_identity_ignores_the_header_and_follows_the_data(self) -> None:
        identity = self.report["identity"]
        self.assertTrue(identity["loaded_equals_hash"], identity)
        self.assertTrue(identity["header_only_equal"], identity)
        self.assertTrue(identity["data_change_differs"], identity)

    def test_a_warm_rerun_in_workers_does_no_kernel_or_fcl_work(self) -> None:
        warm = self.report["warm"]
        self.assertGreater(warm["cold"]["kernel_evaluations"], 0, warm)
        self.assertGreater(warm["cold"]["fcl_queries"], 0, warm)
        self.assertEqual((warm["warm"]["kernel_evaluations"], warm["warm"]["fcl_queries"]), (0, 0), warm)
        self.assertTrue(warm["same"], warm)

    def test_jobs_1_and_4_give_the_same_indexed_outcomes_with_one_start_per_worker(self) -> None:
        queue = self.report["queue"]
        self.assertTrue(queue["same"], queue)
        self.assertLessEqual(queue["worker_pids"], 4, queue)
        self.assertEqual(queue["calls"], 3, queue)

    def test_posed_boxes_are_computed_once_per_occurrence_and_bound_the_exact_distance(self) -> None:
        boxes = self.report["boxes"]
        self.assertEqual(boxes["posed"], boxes["occurrences"] * boxes["poses"], boxes)
        self.assertEqual(boxes["violations"], [], boxes)
        self.assertGreater(boxes["compared"], 50, boxes)


if __name__ == "__main__":
    unittest.main()
