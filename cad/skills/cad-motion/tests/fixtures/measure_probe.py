# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Probe pair_measure.py's bounds and broad phase on real fixture geometry; print the findings as JSON.

For every ordered pair of definitions of each fixture set (two of one PN included), at the
definition placement and at seeded random rigid placements of b around a:
- the box gap, and the motion bound from each other placement's distance, are at most the
  measured distance (`bound_violations`);
- where the gap exceeds pose.SOLID_GAP_MM, `interference` given the gap (b measured as a one-member
  compound, no containment test) returns the very same distance and volume (`mismatches`);
- `interference` on OCCT's thread pool returns the very same distance and volume (`thread_mismatches`).
The nest compound container must still hold its buried cube at distance 0 (`buried`).

Then each ordered pair of the box sets is swept along a seeded path, one group per pair, with the
group's median distance as a threshold, through PairMeasurer, once without and once with
the broad phase: every request the pruned run measured equals the full run's bitwise, and every
pruned one is farther than its group minimum, the gate and its threshold (`prune_violations`).

Usage: uv run --script measure_probe.py FIXTURE_DIR  (build_fixtures.py's OUT_DIR)
stdout: {"compared", "wrapped", "bound_violations", "mismatches", "thread_mismatches", "buried", "requests",
"pruned", "prune_violations"}
"""

from __future__ import annotations

import importlib.util
import json
import math
import random
import statistics
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pose = load("cad_motion_pose", SCRIPTS / "pose.py")
pair_measure = load("cad_motion_pair_measure", SCRIPTS / "pair_measure.py")
SETS = ("v6", "planar", "twins", "lamp", "nest/solid", "nest/compound")
PATH_SETS = ("v6", "planar", "twins")
POSES = 2  # random placements per ordered pair, besides the definition placement
PATH_STEPS = 8


def turn(rng: random.Random) -> tuple[tuple[float, float, float], float]:
    axis = [rng.gauss(0.0, 1.0) for _ in range(3)]
    norm = math.sqrt(sum(v * v for v in axis))
    return tuple(v / norm for v in axis), rng.uniform(0.0, 360.0)


def placements(rng: random.Random, reach: float) -> list:
    out = [pose.Rigid.identity()]
    for _ in range(POSES):
        rotation = pose.Rigid.rotation(*turn(rng), (0.0, 0.0, 0.0))
        out.append(pose.Rigid(rotation.rot, tuple(rng.uniform(-reach, reach) for _ in range(3))))
    return out


def path(rng: random.Random, reach: float) -> list:
    """PATH_STEPS placements turning about one axis and sliding along one line."""
    axis, sweep = turn(rng)
    start = [rng.uniform(-reach, reach) for _ in range(3)]
    end = [rng.uniform(-reach, reach) for _ in range(3)]
    out = []
    for k in range(PATH_STEPS):
        t = k / (PATH_STEPS - 1)
        rotation = pose.Rigid.rotation(axis, sweep * t, (0.0, 0.0, 0.0))
        out.append(pose.Rigid(rotation.rot, tuple(s + (e - s) * t for s, e in zip(start, end))))
    return out


def reach_of(shape) -> float:
    low, high = pair_measure.box_corners(shape)
    return max(h - lo for lo, h in zip(low, high))


def bounds(report: dict, name: str, measurer, shapes: dict) -> None:
    rng = random.Random(f"bounds {name}")
    for a in sorted(shapes):
        for b in sorted(shapes):
            seen = []
            for placement in placements(rng, reach_of(shapes[a])):
                request = pair_measure.Request(a, b, placement)
                gap = measurer.box_gap(request)
                moved = pose.placed(shapes[b], placement)
                plain = pose.interference(shapes[a], moved)
                report["compared"] += 1
                where = {"set": name, "a": a, "b": b, "placement": placement.rows(9)}
                corners = measurer.moved_corners(request)[1]
                motion = [d - max(math.dist(p, q) for p, q in zip(c, corners)) for d, c in seen]
                if max([gap, *motion]) > plain[0]:
                    report["bound_violations"].append({**where, "gap": gap, "motion": motion, "distance": plain[0]})
                seen.append((plain[0], corners))
                threaded = pose.interference(shapes[a], moved, threads=True)
                if [v.hex() for v in threaded] != [v.hex() for v in plain]:
                    report["thread_mismatches"].append({**where, "plain": plain, "threads": threaded})
                if gap > pose.SOLID_GAP_MM:
                    report["wrapped"] += 1
                    given = pose.interference(shapes[a], moved, box_gap=gap)
                    if [v.hex() for v in given] != [v.hex() for v in plain]:
                        report["mismatches"].append({**where, "plain": plain, "given_gap": given})


def broad_phase(report: dict, name: str, shapes: dict) -> None:
    rng = random.Random(f"paths {name}")
    plain = pair_measure.PairMeasurer(shapes)
    requests = []
    for a in sorted(shapes):
        for b in sorted(shapes):
            requests += [pair_measure.Request(a, b, placement, group=(a, b)) for placement in path(rng, reach_of(shapes[a]))]
    first = plain.measure(requests)
    median = {group: statistics.median(o[0] for r, o in zip(requests, first) if r.group == group)
              for group in {r.group for r in requests}}
    requests = [pair_measure.Request(r.a, r.b, r.placement, thresholds=(median[r.group],), group=r.group) for r in requests]
    full = pair_measure.PairMeasurer(shapes).measure(requests)
    pruned = pair_measure.PairMeasurer(shapes).measure(requests, prune=True)
    minimum = {group: min(o[0] for r, o in zip(requests, full) if r.group == group) for group in median}
    for index, (request, got, want) in enumerate(zip(requests, pruned, full)):
        report["requests"] += 1
        if isinstance(got, pair_measure.Pruned):
            report["pruned"] += 1
            sound = (want[0] > max(minimum[request.group], pose.OVERLAP_GATE_MM, *request.thresholds)
                     and isinstance(pruned[got.witness], tuple) and requests[got.witness].group == request.group)
        else:
            sound = [v.hex() for v in got] == [v.hex() for v in want]
        if not sound:
            report["prune_violations"].append({"set": name, "index": index, "pair": [request.a, request.b],
                                               "pruned": repr(got), "full": want})


def main(root: Path) -> dict:
    report = {"compared": 0, "wrapped": 0, "bound_violations": [], "mismatches": [], "thread_mismatches": [],
              "requests": 0, "pruned": 0, "prune_violations": []}
    with pose.stdout_to_stderr():
        for name in SETS:
            shapes = {pn: part.shape for pn, part in pose.load_definitions(root / name, root / name).items()}
            bounds(report, name, pair_measure.PairMeasurer(shapes), shapes)
            if name in PATH_SETS:
                broad_phase(report, name, shapes)
        folder = root / "nest" / "compound"
        nest = {pn: part.shape for pn, part in pose.load_definitions(folder, folder).items()}
        request = pair_measure.Request("TST-0301", "TST-0302", pose.Rigid.identity())
        gap = pair_measure.PairMeasurer(nest).box_gap(request)
        buried = pose.interference(nest["TST-0301"], pose.placed(nest["TST-0302"], request.placement), box_gap=gap)
        report["buried"] = {"gap": gap, "result": buried}
    return report


if __name__ == "__main__":
    print(json.dumps(main(Path(sys.argv[1]))))
