# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Probe pair_measure.py's box gap on real fixture geometry and print the findings as JSON.

For every ordered pair of definitions of each fixture set (two of one PN included), at the
definition placement and at seeded random rigid placements of b around a: the box gap must be at
most the measured distance, and where it exceeds pose.SOLID_GAP_MM, `interference` given the gap
(b measured as a one-member compound, no containment test) must return the very same distance and
volume as without it. The nest compound container must still hold its buried cube at distance 0.

Usage: uv run --script measure_probe.py FIXTURE_DIR  (build_fixtures.py's OUT_DIR)
stdout: {"compared", "wrapped", "gap_violations", "mismatches", "buried"}
"""

from __future__ import annotations

import importlib.util
import json
import math
import random
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
POSES = 2  # random placements per ordered pair, besides the definition placement


def placements(rng: random.Random, reach: float) -> list:
    out = [pose.Rigid.identity()]
    for _ in range(POSES):
        axis = [rng.gauss(0.0, 1.0) for _ in range(3)]
        norm = math.sqrt(sum(v * v for v in axis))
        turn = pose.Rigid.rotation(tuple(v / norm for v in axis), rng.uniform(0.0, 360.0), (0.0, 0.0, 0.0))
        out.append(pose.Rigid(turn.rot, tuple(rng.uniform(-reach, reach) for _ in range(3))))
    return out


def main(root: Path) -> dict:
    rng = random.Random(20261028)
    report = {"compared": 0, "wrapped": 0, "gap_violations": [], "mismatches": []}
    with pose.stdout_to_stderr():
        for name in SETS:
            shapes = {pn: part.shape for pn, part in pose.load_definitions(root / name, root / name).items()}
            measurer = pair_measure.PairMeasurer(shapes)
            for a in sorted(shapes):
                for b in sorted(shapes):
                    low, high = pair_measure.box_corners(shapes[a])
                    reach = max(h - lo for lo, h in zip(low, high))
                    for placement in placements(rng, reach):
                        request = pair_measure.Request(a, b, placement)
                        gap = measurer.box_gap(request)
                        moved = pose.placed(shapes[b], placement)
                        plain = pose.interference(shapes[a], moved)
                        report["compared"] += 1
                        where = {"set": name, "a": a, "b": b, "placement": placement.rows(9)}
                        if gap > plain[0]:
                            report["gap_violations"].append({**where, "gap": gap, "distance": plain[0]})
                        if gap > pose.SOLID_GAP_MM:
                            report["wrapped"] += 1
                            given = pose.interference(shapes[a], moved, box_gap=gap)
                            if [v.hex() for v in given] != [v.hex() for v in plain]:
                                report["mismatches"].append({**where, "plain": plain, "given_gap": given})
        folder = root / "nest" / "compound"
        nest = {pn: part.shape for pn, part in pose.load_definitions(folder, folder).items()}
        request = pair_measure.Request("TST-0301", "TST-0302", pose.Rigid.identity())
        gap = pair_measure.PairMeasurer(nest).box_gap(request)
        buried = pose.interference(nest["TST-0301"], pose.placed(nest["TST-0302"], request.placement), box_gap=gap)
        report["buried"] = {"gap": gap, "result": buried}
    return report


if __name__ == "__main__":
    print(json.dumps(main(Path(sys.argv[1]))))
