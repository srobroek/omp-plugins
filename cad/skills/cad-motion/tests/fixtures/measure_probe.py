# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0", "numpy>=1.26", "python-fcl==0.7.0.11"]
# ///
"""Probe pair_measure.py's bounds, broad phase and session on real fixture geometry; print the findings as JSON.

Default: for every ordered pair of definitions of each fixture set (two of one PN included), at
the definition placement and at seeded random rigid placements of b around a:
- the box gap, and the motion bound from each other placement's distance, are at most the
  measured distance (`bound_violations`);
- where the gap exceeds pose.SOLID_GAP_MM, `interference` given the gap (b measured as a one-member
  compound, no containment test) returns the very same distance and volume (`mismatches`);
- `interference` on OCCT's thread pool returns the very same distance and volume (`thread_mismatches`).
The nest compound container must still hold its buried cube at distance 0 (`buried`).

Then each ordered pair of the box sets is swept along a seeded path, one group per pair, with the
group's median distance as its minimum, through PairMeasurer in exact mode, once without and once
with the broad phase: every request the pruned run measured equals the full run's bitwise, and
every pruned one is farther than its group minimum, the gate and its minimum (`prune_violations`).

With --session, the v2 session and cache instead:
- `identity`: load_definitions' geometry ids are the STEP DATA hashes of their files; a copy with
  another header hashes the same, one with a changed DATA entity differently;
- `warm`: a fast-mode run in 2 worker processes with mesh bounds over a fresh cache, then a warm
  rerun in a fresh session: its kernel and FCL counts, and whether its outcomes equal the cold ones;
- `queue`: one request list measured with jobs 1 and jobs 4 (outcomes `same`), and one jobs-4
  session measuring 3 calls: the worker processes it started (`worker_pids`);
- `boxes`: a rigid train of every set's definitions at seeded poses: posed boxes computed once per
  occurrence per pose (`posed`), and each pair's mesh_bound.box_gap at most its exact distance
  (`violations`).

Usage: uv run --script measure_probe.py FIXTURE_DIR [--session]  (build_fixtures.py's OUT_DIR)
"""

from __future__ import annotations

import importlib.util
import itertools
import json
import math
import random
import re
import shutil
import statistics
import sys
import tempfile
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
TRAIN_POSES = 3


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
    low, high = pose.box_corners(shape)
    return max(h - lo for lo, h in zip(low, high))


def parts_of(folder: Path) -> dict:
    return pose.load_definitions(folder, folder)


def measurer(parts: dict, **options):
    mesh = options.pop("mesh", None)
    return pair_measure.PairMeasurer({pn: part.shape for pn, part in parts.items()},
                                     geometry_ids=pose.geometry_ids(parts),
                                     rule=pair_measure.RuleVersion.current(mesh), mesh=mesh, **options)


def measure(measuring, requests: list, prune: bool = False) -> list:
    with measuring.session() as session:
        return session.measure(requests, prune=prune)


def bits(outcome) -> list | str:
    """An outcome as compared across runs: a reading's IEEE bits, a bound's values; never its seconds."""
    if isinstance(outcome, pair_measure.Measured):
        return [outcome.distance_mm.hex(), outcome.overlap_mm3.hex()]
    if isinstance(outcome, pair_measure.Cleared):
        return [outcome.method, outcome.lower_mm.hex(), outcome.upper_mm.hex(), repr(outcome.mesh_mm)]
    return repr(outcome)


def bounds(report: dict, name: str, measuring, shapes: dict) -> None:
    rng = random.Random(f"bounds {name}")
    for a in sorted(shapes):
        for b in sorted(shapes):
            seen = []
            for placement in placements(rng, reach_of(shapes[a])):
                gap = measuring.box_gap(a, b, placement)
                moved = pose.placed(shapes[b], placement)
                plain = pose.interference(shapes[a], moved)
                report["compared"] += 1
                where = {"set": name, "a": a, "b": b, "placement": placement.rows(9)}
                corners = [placement.apply(c) for c in measuring.corners(b)]
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


def path_requests(name: str, parts: dict) -> list:
    rng = random.Random(f"paths {name}")
    requests = []
    for a in sorted(parts):
        for b in sorted(parts):
            requests += [pair_measure.Request(a, b, placement, group=(a, b), mode="exact")
                         for placement in path(rng, reach_of(parts[a].shape))]
    return requests


def broad_phase(report: dict, name: str, parts: dict) -> None:
    requests = path_requests(name, parts)
    first = measure(measurer(parts), requests)
    median = {group: statistics.median(o.distance_mm for r, o in zip(requests, first) if r.group == group)
              for group in {r.group for r in requests}}
    requests = [pair_measure.Request(r.a, r.b, r.placement, group=r.group, mode="exact", minimum_mm=median[r.group])
                for r in requests]
    full = measure(measurer(parts), requests)
    pruned = measure(measurer(parts), requests, prune=True)
    minimum = {group: min(o.distance_mm for r, o in zip(requests, full) if r.group == group) for group in median}
    for index, (request, got, want) in enumerate(zip(requests, pruned, full)):
        report["requests"] += 1
        if isinstance(got, pair_measure.Pruned):
            report["pruned"] += 1
            sound = (want.distance_mm > max(minimum[request.group], pose.OVERLAP_GATE_MM, request.minimum_mm)
                     and got.lower_mm <= want.distance_mm
                     and isinstance(pruned[got.witness_request], pair_measure.Measured)
                     and requests[got.witness_request].group == request.group)
        else:
            sound = bits(got) == bits(want)
        if not sound:
            report["prune_violations"].append({"set": name, "index": index, "pair": [request.a, request.b],
                                               "pruned": repr(got), "full": repr(want)})


def default(root: Path) -> dict:
    report = {"compared": 0, "wrapped": 0, "bound_violations": [], "mismatches": [], "thread_mismatches": [],
              "requests": 0, "pruned": 0, "prune_violations": []}
    for name in SETS:
        parts = parts_of(root / name)
        shapes = {pn: part.shape for pn, part in parts.items()}
        bounds(report, name, measurer(parts), shapes)
        if name in PATH_SETS:
            broad_phase(report, name, parts)
    nest = parts_of(root / "nest" / "compound")
    gap = measurer(nest).box_gap("TST-0301", "TST-0302", pose.Rigid.identity())
    buried = pose.interference(nest["TST-0301"].shape, pose.placed(nest["TST-0302"].shape, pose.Rigid.identity()),
                               box_gap=gap)
    report["buried"] = {"gap": gap, "result": buried}
    return report


def identity(root: Path, scratch: Path) -> dict:
    folder = root / "v6"
    parts = parts_of(folder)
    files = {pose.PN_PREFIX.match(p.stem).group(1): p for p in sorted(folder.iterdir())
             if p.suffix.lower() in pose.STEP_SUFFIXES and pose.PN_PREFIX.match(p.stem)}
    loaded = all(part.geometry_id == pose.step_data_hash(files[pn]) for pn, part in parts.items())
    source = files[sorted(files)[0]]
    text = source.read_text(encoding="utf-8")
    header = scratch / "header.step"
    header.write_text(re.sub(r"FILE_NAME\('[^']*'", "FILE_NAME('rebuilt-elsewhere.step'", text, count=1)
                      .replace("FILE_NAME(", "FILE_NAME( ", 1), encoding="utf-8")
    data = scratch / "data.step"
    data.write_text(text.replace("PRODUCT('", "PRODUCT('changed ", 1), encoding="utf-8")
    return {"loaded_equals_hash": loaded, "header_changed": header.read_text(encoding="utf-8") != text,
            "header_only_equal": pose.step_data_hash(header) == pose.step_data_hash(source),
            "data_change_differs": pose.step_data_hash(data) != pose.step_data_hash(source)}


def counts(measuring) -> dict:
    c = measuring.counters
    return {"kernel_evaluations": c.kernel_evaluations, "fcl_queries": c.fcl_queries, "exact_hits": c.exact_hits,
            "decision_hits": c.decision_hits, "cleared": dict(c.cleared), "committed_chunks": c.committed_chunks,
            "worker_pids": len(c.worker_pids)}


def warm(root: Path, scratch: Path, mesh_bound) -> dict:
    parts = parts_of(root / "v6")
    shapes = {pn: part.shape for pn, part in parts.items()}
    requests = [pair_measure.Request(r.a, r.b, r.placement, group=r.group, minimum_mm=0.5)
                for r in path_requests("warm", parts)]
    runs = []
    for _ in range(2):
        cache = pair_measure.PairCache(scratch / "cache")
        measuring = measurer(parts, mesh=mesh_bound.MeshBounds(shapes), jobs=2, cache=cache)
        outcomes = measure(measuring, requests, prune=True)
        cache.close()
        runs.append((outcomes, counts(measuring)))
    (cold, cold_counts), (again, warm_counts) = runs
    comparable = [bits(o) if not isinstance(o, pair_measure.Pruned) else "pruned" for o in cold]
    return {"cold": cold_counts, "warm": warm_counts,
            "same": comparable == [bits(o) if not isinstance(o, pair_measure.Pruned) else "pruned" for o in again]}


def queue(root: Path) -> dict:
    parts = parts_of(root / "planar")
    requests = path_requests("queue", parts)
    one = measure(measurer(parts), requests)
    four = measurer(parts, jobs=4)
    with four.session() as session:
        many = session.measure(requests)
        session.measure(requests[:30])
        session.measure(requests[30:60])
    return {"same": [bits(o) for o in one] == [bits(o) for o in many], "worker_pids": len(four.counters.worker_pids),
            "calls": 3, "requests": len(requests)}


def boxes(root: Path, mesh_bound) -> dict:
    """Every v6 and planar definition as an occurrence of one rigid train, posed TRAIN_POSES times."""
    parts = {**parts_of(root / "v6"), **parts_of(root / "planar")}
    shapes = {pn: part.shape for pn, part in parts.items()}
    mesh = mesh_bound.MeshBounds(shapes)
    assets = mesh.prepare(shapes)
    rng = random.Random("train")
    occurrences = {f"@{pn}-{k}": pn for pn in sorted(shapes) for k in range(2)}
    rests = {oid: pose.Rigid(pose.Rigid.identity().rot, tuple(rng.uniform(-40.0, 40.0) for _ in range(3)))
             for oid in occurrences}
    report = {"occurrences": len(occurrences), "poses": TRAIN_POSES, "compared": 0, "violations": []}
    for _ in range(TRAIN_POSES):
        motion = pose.Rigid.rotation(*turn(rng), (0.0, 0.0, 0.0))
        transforms = {oid: motion @ rest for oid, rest in rests.items()}
        posed = assets.posed_boxes(transforms, occurrences.__getitem__)
        for a, b in itertools.combinations(sorted(occurrences), 2):
            gap = mesh_bound.box_gap(posed[a], posed[b])
            relative = transforms[a].inverse() @ transforms[b]
            exact = pose.interference(shapes[occurrences[a]], pose.placed(shapes[occurrences[b]], relative))[0]
            report["compared"] += 1
            if gap > exact + pair_measure.SLACK_MM:
                report["violations"].append({"a": a, "b": b, "box_gap": gap, "exact": exact})
    report["posed"] = assets.posed
    return report


def session(root: Path) -> dict:
    mesh_bound = load("cad_motion_mesh_bound", SCRIPTS / "mesh_bound.py")
    scratch = Path(tempfile.mkdtemp())
    try:
        return {"identity": identity(root, scratch), "warm": warm(root, scratch, mesh_bound), "queue": queue(root),
                "boxes": boxes(root, mesh_bound)}
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def main(root: Path, mode: str) -> dict:
    with pose.stdout_to_stderr():
        return session(root) if mode == "--session" else default(root)


if __name__ == "__main__":
    print(json.dumps(main(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else "")))
