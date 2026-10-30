#!/usr/bin/env python3
"""Tests for incremental.py: which pairs a changed-only check selects between two versions, and which
smoke samples a chain gets. Kernel-free: chains come from the V6-like record and a planar arm, and
the sealed versions are small kernel-free folders whose part STEP files hold one DATA entity each."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

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
incremental = load("cad_motion_incremental", SCRIPTS / "incremental.py")
coupling = pose.coupling


def v6_chain(data: dict):
    frames = {pn: frame for pn, (_, frame) in v6_record.PARTS.items()}
    inventory = pose.assembly_data.normalize(data, frames)
    assembly = pose.Assembly(inventory, (), frames)
    joints = [pose.make_joint(raw, assembly.attachable) for raw in data["joints"]]
    return pose.build_chain(joints, inventory.occurrences, couplings=coupling.parse(data))


def joint(data: dict, jid: str) -> dict:
    return next(j for j in data["joints"] if j["id"] == jid)


def arm(ratio: float = -0.5, limit: float = 60.0) -> dict:
    """A planar arm: TST-0002 about the base, TST-0003 about TST-0002, TST-0004 following J-002."""
    return {"joints": [
        {"id": "J-001", "type": "revolute", "parent": "TST-0001", "child": "TST-0002", "axis": [0, 0, 1],
         "origin": [0, 0, 0], "min": -90, "max": 90, "nominal": 30},
        {"id": "J-002", "type": "revolute", "parent": "TST-0002", "child": "TST-0003", "axis": [0, 0, 1],
         "origin": [100, 0, 0], "min": -limit, "max": limit, "nominal": 0},
        {"id": "J-003", "type": "revolute", "parent": "TST-0003", "child": "TST-0004", "axis": [0, 0, 1],
         "origin": [180, 0, 0], "min": -60, "max": 60,
         "coupling": {"type": "linear", "driver": "J-002", "ratio": ratio}}]}


def chain_of(data: dict, displaced=None):
    """The chain of a joints-only record; `displaced` (a pose.Rigid) moves the whole product."""
    joints = [pose.make_joint(raw) for raw in data["joints"]]
    rests = None
    if displaced is not None:
        rot = displaced.rot
        joints = [pose.Joint(j.id, j.type, j.parent, j.child, pose._mat_vec(rot, j.axis), displaced.apply(j.origin),
                             j.min, j.max, j.nominal) for j in joints]
        rests = {pn: displaced for pn in ("TST-0001", "TST-0002", "TST-0003", "TST-0004")}
    return pose.build_chain(joints, (), rests, coupling.parse(data))


def state(label: str, chain, geometry=None, policies=None, placements=None):
    values = chain.complete({})
    return incremental.VersionState(
        label, geometry or {pn: pn.encode() for pn in chain.ids}, {oid: chain.pn(oid) for oid in chain.ids},
        placements or chain.transforms(values), policies or {}, chain)


def pairs_of(ids) -> list[tuple[str, str]]:
    ids = sorted(ids)
    return [(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]]


class SelectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.chain = chain_of(arm())
        self.base = state("v1", self.chain)
        self.pairs = pairs_of(self.chain.ids)

    def test_a_geometry_change_selects_only_the_incident_pairs(self) -> None:
        changed = state("v2", self.chain, geometry={**self.base.geometry, "TST-0003": b"new"})
        selection = incremental.select_pairs(self.pairs, changed, self.base)
        self.assertEqual(sorted(selection.selected), [p for p in self.pairs if "TST-0003" in p])
        self.assertTrue(all(reasons == ("geometry",) for reasons in selection.selected.values()))
        self.assertEqual(selection.unchanged, {p for p in self.pairs if "TST-0003" not in p})
        scope = selection.scope()
        self.assertEqual((scope["kind"], scope["complete"], scope["baseline"]), ("changed_pairs", False, "v1"))
        self.assertEqual(scope["reasons"], {"geometry": 3})

    def test_a_moved_occurrence_selects_its_pairs_and_a_moved_product_only_rounding(self) -> None:
        for distance in (0.5, 5e-6):  # 5e-6 mm: under any tolerance a selection could have had
            with self.subTest(distance=distance):
                shift = pose.Rigid.translation((1.0, 0.0, 0.0), distance)
                placements = dict(self.base.placements)
                placements["TST-0004"] = shift @ placements["TST-0004"]
                moved = incremental.select_pairs(self.pairs, state("v2", self.chain, placements=placements), self.base)
                self.assertEqual(sorted(moved.selected), [p for p in self.pairs if "TST-0004" in p])
                self.assertEqual(set(moved.selected.values()), {("placement",)})
        whole = pose.Rigid.rotation((0.3, 0.4, math.sqrt(0.75)), 37.0, (12.0, -40.0, 7.0))
        everything = {oid: whole @ placement for oid, placement in self.base.placements.items()}
        product = incremental.select_pairs(self.pairs, state("v2", self.chain, placements=everything), self.base)
        self.assertLessEqual(set(product.selected.values()), {("placement",)})
        for a, b in product.selected:  # remeasured, so the pair cache's rounded bucket meets them
            now = everything[a].inverse() @ everything[b]
            then = self.base.placements[a].inverse() @ self.base.placements[b]
            self.assertLess(max(abs(x - y) for x, y in zip(rows(now), rows(then))), 1e-9)

    def test_a_policy_change_selects_that_pair_alone(self) -> None:
        policies = {("TST-0002", "TST-0004"): '{"kind": "clearance", "min_clearance_mm": 0.5}'}
        selection = incremental.select_pairs(self.pairs, state("v2", self.chain, policies=policies), self.base)
        self.assertEqual(selection.selected, {("TST-0002", "TST-0004"): ("policy",)})

    def test_added_and_removed_occurrences(self) -> None:
        geometry = {k: v for k, v in self.base.geometry.items() if k != "TST-0004"}
        smaller = incremental.VersionState("v0", geometry, {o: o for o in geometry},
                                           {o: self.base.placements[o] for o in geometry}, {}, None)
        grown = incremental.select_pairs(self.pairs, self.base, smaller)
        self.assertEqual({p for p, r in grown.selected.items() if r == ("added",)}, {p for p in self.pairs if "TST-0004" in p})
        shrunk = incremental.select_pairs(pairs_of(geometry), smaller, self.base)
        self.assertEqual(shrunk.selected, {})
        self.assertEqual(shrunk.removed, tuple(p for p in self.pairs if "TST-0004" in p))

    def test_without_a_baseline_every_pair_is_selected_with_the_reason(self) -> None:
        selection = incremental.select_pairs(self.pairs, self.base, None, reason="no built version before v1")
        self.assertEqual(set(selection.selected), set(self.pairs))
        scope = selection.scope()
        self.assertEqual((scope["complete"], scope["full_selection"]), (False, "no built version before v1"))

    def test_moving_selection_follows_coupling_and_range_changes(self) -> None:
        geared = state("v2", chain_of(arm(ratio=-0.6)))
        static = incremental.select_pairs(self.pairs, geared, self.base)
        self.assertEqual(static.selected, {})  # J-002 is 0 at nominal, so nothing moved there
        moving = incremental.select_pairs(self.pairs, geared, self.base, moving=True)
        self.assertEqual(sorted(moving.selected), sorted(p for p in self.pairs if "TST-0004" in p))
        self.assertEqual(set(moving.selected.values()), {("motion",)})
        wider = incremental.select_pairs(self.pairs, state("v2", chain_of(arm(limit=70.0))), self.base, moving=True)
        self.assertEqual(sorted(wider.selected), sorted(p for p in self.pairs if "TST-0003" in p or "TST-0004" in p))

    def test_a_displaced_product_moves_pairs_through_its_motion_by_rounding_only(self) -> None:
        whole = pose.Rigid.rotation((0.0, 0.6, 0.8), 25.0, (5.0, 6.0, 7.0))
        displaced = state("v2", chain_of(arm(), whole))
        selection = incremental.select_pairs(self.pairs, displaced, self.base, moving=True)
        self.assertLessEqual(set(selection.selected.values()), {("motion",), ("placement", "motion")})
        now, then = incremental._Motion(displaced.chain), incremental._Motion(self.base.chain)
        now.measure(self.pairs)
        then.measure(self.pairs)
        for pair in selection.selected:
            for x, y in zip(now.relative[pair], then.relative[pair]):
                self.assertLess(max(abs(u - v) for u, v in zip(rows(x), rows(y))), 1e-9)


def rows(rigid) -> list[float]:
    return [v for row in rigid.rot for v in row] + list(rigid.trans)


def custom_v6(**changes) -> dict:
    data = v6_record.record()
    for key, value in changes.items():
        data[key] = value
    return data


class SmokeTests(unittest.TestCase):
    def test_an_engine_gets_twelve_base_angles_and_its_events_on_top(self) -> None:
        plan = incremental.smoke_samples(v6_chain(v6_record.record()))
        base = sorted(s.value for s in plan.samples if any(label in ("base", "endpoint") for label in s.labels))
        self.assertEqual(base, [60.0 * k for k in range(12)])  # 720 poses the engine as 0 does
        zero = next(s for s in plan.samples if s.value == 0.0)
        self.assertIn("endpoint at J-001 = 720", zero.labels)
        self.assertGreater(len(plan.samples), 12)
        tdc = sorted({e.value for e in plan.events if e.kind == "tdc"})
        self.assertEqual(tdc, [0.0, 120.0, 240.0, 360.0, 480.0, 600.0, 720.0])
        self.assertEqual(len({s.value for s in plan.samples}), len(plan.samples))
        coverage = plan.coverage()
        self.assertEqual((coverage["kind"], coverage["complete"], coverage["samples"]), ("smoke", False, len(plan.samples)))
        self.assertIn("full sweep is still required", coverage["limitation"])

    def test_an_off_grid_tdc_and_a_narrow_dwell_catch_what_the_base_grid_misses(self) -> None:
        data = v6_record.record()
        data["profiles"]["narrow"] = {"input_unit": "deg", "output_unit": "mm", "period_deg": 360,
                                      "interpolation": "linear",
                                      "samples": [[0, 0], [64, 0], [64.5, 3], [65.5, 3], [66, 0], [360, 0]]}
        next(m for m in data["mechanisms"] if m["id"] == "cylinder-3")["phase_deg"] = 105.0  # TDC at 255 and 615
        joint(data, "J-043")["coupling"].update(profile="narrow", phase_deg=65.0 - 255.0 / 2.0)  # peak at that TDC
        chain = v6_chain(data)
        plan = incremental.smoke_samples(chain)

        def collides(value: float) -> bool:
            values = chain.complete({"J-001": value})
            return values["J-043"] > v6_record.VALVE_GAP + abs(values["J-013"])

        base = [s for s in plan.samples if "base" in s.labels]
        self.assertEqual([s.value for s in base], [60.0 * k for k in range(12)])
        self.assertFalse(any(collides(s.value) for s in base))
        tdc = sorted(e.value for e in plan.events if e.kind == "tdc" and e.source.startswith("cylinder-3"))
        self.assertEqual(tdc, [255.0, 615.0])
        midpoints = [e.value for e in plan.events if e.kind == "dwell_midpoint" and e.source == "J-043 narrow"]
        self.assertIn(255.0, midpoints)  # cam 127.5 -> crank 255: the 1:2 cam inverted to the crank
        hits = sorted(s.value for s in plan.samples if collides(s.value))
        self.assertTrue(hits and all(abs(v - 255.0) <= 2.0 for v in hits), hits)
        self.assertFalse(plan.coverage()["complete"])

    def test_events_invert_a_chain_of_linear_couplings_with_offsets(self) -> None:
        data = {"profiles": {"step": {"input_unit": "deg", "output_unit": "mm", "period_deg": 360,
                                      "interpolation": "linear", "samples": [[0, 0], [90, 0], [100, 5], [360, 0]]}},
                "joints": [
                    {"id": "J-001", "type": "revolute", "parent": "TST-0001", "child": "TST-0002", "axis": [0, 0, 1],
                     "origin": [0, 0, 0], "min": 0, "max": 360, "nominal": 0},
                    {"id": "J-002", "type": "revolute", "parent": "TST-0001", "child": "TST-0003", "axis": [0, 0, 1],
                     "origin": [50, 0, 0], "min": -1000, "max": 1000,
                     "coupling": {"type": "linear", "driver": "J-001", "ratio": 2.0, "offset": 30.0}},
                    {"id": "J-003", "type": "revolute", "parent": "TST-0001", "child": "TST-0004", "axis": [0, 0, 1],
                     "origin": [90, 0, 0], "min": -1000, "max": 1000,
                     "coupling": {"type": "linear", "driver": "J-002", "ratio": -0.5, "offset": 5.0}},
                    {"id": "J-004", "type": "prismatic", "parent": "TST-0001", "child": "TST-0005", "axis": [0, 0, 1],
                     "origin": [0, 0, 0], "min": 0, "max": 5,
                     "coupling": {"type": "periodic_table", "driver": "J-003", "profile": "step", "phase_deg": 20.0}}]}
        chain = chain_of(data)
        found, unsupported = incremental.events(chain)
        self.assertEqual(unsupported, ())
        # q3 = -0.5 (2 q1 + 30) + 5 = -q1 - 10; profile input x = q3 + 20, so q1 = 10 - x + 360 k
        kinds = {kind: sorted(e.value for e in found if e.kind == kind)
                 for kind in ("dwell_boundary", "extremum", "dwell_midpoint")}
        self.assertEqual(kinds, {"dwell_boundary": [10.0, 280.0], "extremum": [270.0], "dwell_midpoint": [325.0]})
        for event in found:  # each lands on its profile input exactly
            values = chain.complete({"J-001": event.value})
            x = (values["J-003"] + 20.0) % 360.0
            expected = {"dwell_boundary": (0.0, 90.0), "extremum": (100.0,), "dwell_midpoint": (45.0,)}[event.kind]
            self.assertTrue(any(math.isclose(x, k, abs_tol=1e-9) for k in expected), (event, x))

    def test_a_non_linear_mapping_is_reported_and_its_events_sampled(self) -> None:
        data = v6_record.record()
        joint(data, "J-041")["coupling"] = {"type": "periodic_table", "driver": "J-021", "profile": "lift", "phase_deg": 65.0}
        plan = incremental.smoke_samples(v6_chain(data))
        self.assertEqual(len(plan.unsupported), 1)
        self.assertIn("J-041 lift: reached from J-001 through a non-linear coupling", plan.unsupported[0])
        sampled = [e for e in plan.events if e.source == "J-041 lift"]
        self.assertTrue(sampled and all(e.method == "sampled" for e in sampled))
        peaks = sorted(e.value for e in sampled if e.kind == "extremum")
        for expected in (0.0, 180.0, 360.0, 540.0, 720.0):  # the rod angle, and with it the lift, turns at TDC and BDC
            if 0.0 < expected < 720.0:
                self.assertTrue(any(abs(v - expected) <= incremental.FINE_STEP for v in peaks), (expected, peaks))

    def test_a_prismatic_joint_gets_its_endpoints_and_midpoint(self) -> None:
        data = {"joints": [{"id": "J-001", "type": "prismatic", "parent": "TST-0001", "child": "TST-0002",
                            "axis": [1, 0, 0], "origin": [0, 0, 0], "min": -10, "max": 30, "nominal": 0}]}
        plan = incremental.smoke_samples(chain_of(data))
        self.assertEqual([(s.value, s.unit) for s in plan.samples], [(-10.0, "mm"), (10.0, "mm"), (30.0, "mm")])

    def test_breakpoints_hold_every_knot_and_tdc(self) -> None:
        points = incremental.breakpoints(v6_chain(v6_record.record()))["J-001"]
        self.assertEqual(list(points), sorted(points))
        phase = v6_record.valve_phase(0.0, False)  # cylinder 1's valve on the right cam
        for x, _ in v6_record.LIFT[:-1]:
            crank = 2.0 * (x - phase)
            crank = crank % 720.0
            self.assertTrue(any(abs(p - crank) <= 1e-9 for p in points), crank)


STEP = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('{pn}','{stamp}',(''),(''),'fixture','fixture','');
FILE_SCHEMA(('AP242'));
ENDSEC;
DATA;
#1=CARTESIAN_POINT('{pn}',({data}));
ENDSEC;
END-ISO-10303-21;
"""


def seal(hw: Path, label: str, *, data: dict[str, str], stamp: str = "2026-10-30T00:00:00", sources=None,
         interfaces=None, record: dict | None = None) -> Path:
    """A kernel-free sealed version `label` of the planar arm: one STEP per PN with `data` as its one entity."""
    record = record or arm()
    interfaces = interfaces or {"interfaces": []}
    folder = hw / "versions" / label
    (folder / "record" / "parts").mkdir(parents=True)
    (folder / "parts").mkdir()
    (folder / "record" / "product.yaml").write_text("id: arm\n", encoding="utf-8")
    (folder / "record" / "assembly.yaml").write_text(yaml.safe_dump(record), encoding="utf-8")
    (folder / "record" / "interfaces.yaml").write_text(yaml.safe_dump(interfaces), encoding="utf-8")
    for pn in data:
        (folder / "record" / "parts" / pn).mkdir()
        (folder / "record" / "parts" / pn / "part.yaml").write_text(f"PN: {pn}\ntitle: {pn}\nmodel_frame: assembly_zero\n",
                                                                     encoding="utf-8")
        (folder / "parts" / f"{pn}.step").write_text(STEP.format(pn=pn, stamp=stamp, data=data[pn]), encoding="utf-8")
    loaded = pose.load_assembly(folder / "record", folder / "record")
    chain = pose.assembly_chain(loaded, dict.fromkeys(data))
    placed = chain.transforms(chain.complete({}))
    rows = lambda rigid: [[*rigid.rot[i], rigid.trans[i]] for i in range(3)]  # noqa: E731
    files = {p.relative_to(folder).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in sorted(folder.rglob("*")) if p.is_file()}
    manifest = {
        "schema_version": 2, "label": label, "attach": [],
        "occurrences": {oid: {"PN": chain.pn(oid), "rest": rows(chain.rests[oid])} for oid in chain.ids},
        "pose": {"values": chain.complete({}), "transforms": {oid: rows(placed[oid]) for oid in chain.ids}},
        "joint_pairs": sorted(({"pair": sorted([j.parent, j.child]), "joint": j.id, "type": j.type}
                               for j in chain.joints), key=lambda e: (e["pair"], e["joint"])),
        "parts": {pn: {"step": f"parts/{pn}.step", "source_sha256": (sources or {}).get(pn, "s")} for pn in data},
        "files": files}
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return folder


PARTS = {pn: "0.,0.,0." for pn in ("TST-0001", "TST-0002", "TST-0003", "TST-0004")}


class VersionTests(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.hw = Path(folder.name).resolve() / "hw"
        self.hw.mkdir()

    def test_only_a_data_change_is_a_geometry_change(self) -> None:
        seal(self.hw, "v1", data=PARTS)
        seal(self.hw, "v2", data={**PARTS, "TST-0003": "1.,0.,0."}, stamp="2026-10-31T09:00:00",
             sources={"TST-0002": "edited", "TST-0003": "edited"})
        changes = incremental.compare_versions(self.hw, "v2")
        self.assertEqual((changes.baseline.label, changes.geometry, changes.source_only),
                         ("v1", ("TST-0003",), ("TST-0002",)))
        selection = changes.select(pairs_of(PARTS))
        self.assertEqual(sorted(selection.selected), [p for p in pairs_of(PARTS) if "TST-0003" in p])

    def test_a_snapshot_policy_change_selects_its_pair(self) -> None:
        seal(self.hw, "v1", data=PARTS)
        requirement = {"interfaces": [{"id": "IF-001", "type": "clearance", "from": "TST-0002", "to": "TST-0004",
                                       "pair": ["TST-0002", "TST-0004"], "min_clearance_mm": 0.5}]}
        seal(self.hw, "v2", data=PARTS, interfaces=requirement)
        widened = copy.deepcopy(requirement)
        widened["interfaces"][0]["margin_mm"] = 0.3
        seal(self.hw, "v3", data=PARTS, interfaces=widened)
        added = incremental.compare_versions(self.hw, "v2").select(pairs_of(PARTS))
        self.assertEqual(added.selected, {("TST-0002", "TST-0004"): ("policy",)})
        margin = incremental.compare_versions(self.hw, "v3").select(pairs_of(PARTS))
        self.assertEqual(margin.selected, {("TST-0002", "TST-0004"): ("policy",)})
        explicit = incremental.compare_versions(self.hw, "v3", "v1")
        self.assertEqual((explicit.baseline.label, explicit.reason), ("v1", "baseline v1: --since-version"))
        self.assertEqual(explicit.select(pairs_of(PARTS)).selected, {("TST-0002", "TST-0004"): ("policy",)})

    def test_the_first_version_selects_every_pair_with_the_reason(self) -> None:
        seal(self.hw, "v1", data=PARTS)
        changes = incremental.compare_versions(self.hw, "v1")
        self.assertIsNone(changes.baseline)
        selection = changes.select(pairs_of(PARTS))
        self.assertEqual(set(selection.selected), set(pairs_of(PARTS)))
        self.assertEqual(selection.scope()["full_selection"], "no built version before v1: every pair is selected")

    def test_a_bad_baseline_is_an_error_never_an_empty_selection(self) -> None:
        seal(self.hw, "v1", data=PARTS)
        seal(self.hw, "v2", data=PARTS)
        for baseline in ("v9", "v2"):
            with self.subTest(baseline=baseline), self.assertRaises(incremental.MotionError):
                incremental.compare_versions(self.hw, "v2", baseline)
        manifest = self.hw / "versions" / "v1" / "manifest.json"
        broken = json.loads(manifest.read_text())
        del broken["pose"]
        manifest.write_text(json.dumps(broken))
        with self.assertRaisesRegex(incremental.MotionError, "rebuild that version"):
            incremental.compare_versions(self.hw, "v2")


if __name__ == "__main__":
    unittest.main()
