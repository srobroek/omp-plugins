# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Kinematic sweep: interference, clearance, reach envelope, and worst-case pose.

Usage:
    uv run --script sweep.py --hw HW (--step ASSEMBLY.step | --parts-dir DIR)
        [--attach PN=PARENT_PN ...] --worst-step WORST.step
        [--steps 19] [--grid 3] [--end-effector PN] [--include-pair PN:PN ...]
        [--min-clearance 0] [--volume-tol 0.001] [--max-poses 5000] [--time-limit 600]

Inputs and kinematics are pose.py's (same options, same chain).

Poses: for every movable joint, `--steps` values evenly spaced through
[min, max] with the other joints at nominal; plus a combined grid of
`--grid` evenly spaced values per movable joint (`--grid 0` turns it off).
Identical poses are evaluated once.

Pairs: every pair of chain parts except joint-connected parent/child pairs
(fixed joints and --attach included); `--include-pair A:B` puts an excluded
pair back. Per pose and pair: the minimum distance (BRepExtrema_DistShapeShape)
and, when it is within 1e-6 mm, the overlap volume (BRepAlgoAPI_Common).
A pair evaluation is cached on the pair's relative transform, so a joint
sweep recomputes only the pairs that joint moves.

Checks: a collision is an overlap volume above `--volume-tol` mm^3; a
clearance finding is a minimum distance below `--min-clearance` mm (off at 0).

Reach envelope: the union of the end-effector's posed bounding boxes.
End effector: `--end-effector`, else the part with the most movable joints
between it and the ground (first in joint order on a tie).

Worst case (criterion `max_horizontal_reach`): among collision-free poses, the
one with the largest horizontal (XY, gravity along -Z) distance from the first
joint origin on the end effector's path to the end effector's centre of mass:
the largest cantilever moment arm, the static FEA load case. It is written
with pose.py's posed-STEP writer to `--worst-step`.

Runtime is bounded: more than `--max-poses` poses is refused up front, and a
sweep that passes `--time-limit` seconds stops and reports `incomplete`.

stdout: JSON summary with timings. stderr: diagnostics.
Exit 0 = no collision and no clearance finding, 1 = a collision or clearance
finding, 2 = usage or infrastructure error, or an incomplete sweep.
"""

from __future__ import annotations

import argparse
import importlib.util
import itertools
import json
import math
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

POSE_PATH = Path(__file__).with_name("pose.py")
_spec = importlib.util.spec_from_file_location("cad_motion_pose", POSE_PATH)
assert _spec and _spec.loader
pose = importlib.util.module_from_spec(_spec)
sys.modules["cad_motion_pose"] = pose
_spec.loader.exec_module(pose)

CONTACT_MM = 1e-6
CRITERION = "max_horizontal_reach"
MAX_LISTED = 50


def linspace(low: float, high: float, count: int) -> list[float]:
    if count == 1 or low == high:
        return [low]
    return [low + (high - low) * k / (count - 1) for k in range(count)]


def generate_poses(chain: Any, steps: int, grid: int) -> list[tuple[str, dict[str, float]]]:
    """(source, values) for the per-joint sweeps then the grid; duplicates dropped."""
    movable = chain.movable
    nominal = {j.id: j.nominal for j in movable}
    poses: list[tuple[str, dict[str, float]]] = []
    seen: set[tuple[float, ...]] = set()

    def add(source: str, values: dict[str, float]) -> None:
        key = tuple(round(values[j.id], 9) for j in movable)
        if key not in seen:
            seen.add(key)
            poses.append((source, values))

    for joint in movable:
        for value in linspace(joint.min, joint.max, steps):
            add(f"sweep:{joint.id}", {**nominal, joint.id: value})
    if grid:
        for combo in itertools.product(*(linspace(j.min, j.max, grid) for j in movable)):
            add("grid", dict(zip((j.id for j in movable), combo)))
    return poses


def pose_count_bound(chain: Any, steps: int, grid: int) -> int:
    count = steps * len(chain.movable)
    return count + (grid ** len(chain.movable) if grid else 0)


def pairs_to_check(chain: Any, include: list[str]) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """(checked pairs, excluded adjacent pairs), each pair in chain order."""
    adjacent = chain.adjacent_pairs()
    wanted: set[frozenset[str]] = set()
    for spec in include:
        a, sep, b = spec.partition(":")
        if not sep or a not in chain.parts or b not in chain.parts or a == b:
            raise pose.MotionError(f"--include-pair expects PN:PN of two chain parts, got {spec!r}")
        wanted.add(frozenset((a, b)))
    checked, excluded = [], []
    for a, b in itertools.combinations(chain.parts, 2):
        key = frozenset((a, b))
        (excluded if key in adjacent and key not in wanted else checked).append((a, b))
    return checked, excluded


class Geometry:
    """OCP queries on zero-pose part shapes, cached by relative placement."""

    def __init__(self, parts: dict[str, Any]) -> None:
        self.parts = parts
        self.cache: dict[tuple[Any, ...], tuple[float, float]] = {}
        self.evaluations = 0
        self.cache_hits = 0
        self.centres = {pn: self._centre(part.shape) for pn, part in parts.items()}

    @staticmethod
    def _centre(shape: Any) -> tuple[float, float, float]:
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps

        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape, props)
        point = props.CentreOfMass()
        return (point.X(), point.Y(), point.Z())

    def pair(self, a: str, b: str, relative: Any) -> tuple[float, float]:
        """(min distance mm, overlap volume mm^3) of b placed by `relative` in a's frame."""
        key = (a, b, *(round(v, 6) for row in relative.rows(9) for v in row))
        cached = self.cache.get(key)
        if cached is not None:
            self.cache_hits += 1
            return cached
        from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
        from OCP.BRepExtrema import BRepExtrema_DistShapeShape
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps

        self.evaluations += 1
        shape_a = self.parts[a].shape
        shape_b = pose.placed(self.parts[b].shape, relative)
        extrema = BRepExtrema_DistShapeShape(shape_a, shape_b)
        if not extrema.IsDone():
            raise pose.MotionError(f"distance computation failed for {a} / {b}")
        distance = extrema.Value()
        volume = 0.0
        if distance <= CONTACT_MM:
            common = BRepAlgoAPI_Common(shape_a, shape_b)
            if not common.IsDone():
                raise pose.MotionError(f"interference computation failed for {a} / {b}")
            props = GProp_GProps()
            BRepGProp.VolumeProperties_s(common.Shape(), props)
            volume = max(0.0, props.Mass())
        self.cache[key] = (distance, volume)
        return distance, volume

    def bounds(self, pn: str, rigid: Any) -> tuple[list[float], list[float]]:
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib

        box = Bnd_Box()
        BRepBndLib.AddOptimal_s(pose.placed(self.parts[pn].shape, rigid), box, False, False)
        low, high = box.CornerMin(), box.CornerMax()
        return [low.X(), low.Y(), low.Z()], [high.X(), high.Y(), high.Z()]


@dataclass
class SweepState:
    collisions: list[dict[str, Any]] = field(default_factory=list)
    clearance: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    envelope_min: list[float] = field(default_factory=lambda: [math.inf] * 3)
    envelope_max: list[float] = field(default_factory=lambda: [-math.inf] * 3)
    worst: dict[str, Any] | None = None
    evaluated: int = 0


def end_effector(chain: Any, explicit: str | None) -> str:
    if explicit:
        if explicit not in chain.parts:
            raise pose.MotionError(f"--end-effector {explicit} is not a chain part")
        return explicit
    depth = {pn: sum(1 for j in chain.path(pn) if j.movable) for pn in chain.parts}
    return max(chain.parts, key=lambda pn: depth[pn])  # max keeps the first on a tie


def rounded(values: dict[str, float]) -> dict[str, float]:
    return {k: round(v, 6) + 0.0 for k, v in values.items()}


def sweep(chain: Any, geometry: Geometry, poses: list[tuple[str, dict[str, float]]], pairs: list[tuple[str, str]],
          effector: str, reference: tuple[float, float, float], volume_tol: float, deadline: float) -> SweepState:
    state = SweepState()
    for source, values in poses:
        if time.monotonic() > deadline:
            break
        transforms = chain.transforms(values)
        hits = []
        for a, b in pairs:
            distance, volume = geometry.pair(a, b, transforms[a].inverse() @ transforms[b])
            best = state.clearance.get((a, b))
            if best is None or distance < best["clearance_mm"]:
                state.clearance[(a, b)] = {"pair": [a, b], "clearance_mm": distance, "pose": rounded(values)}
            if volume > volume_tol:
                hits.append({"pair": [a, b], "volume_mm3": round(volume, 4)})
        low, high = geometry.bounds(effector, transforms[effector])
        state.envelope_min = [min(m, v) for m, v in zip(state.envelope_min, low)]
        state.envelope_max = [max(m, v) for m, v in zip(state.envelope_max, high)]
        if hits:
            state.collisions.append({"source": source, "pose": rounded(values), "pairs": hits})
        else:
            centre = transforms[effector].apply(geometry.centres[effector])
            reach = math.hypot(centre[0] - reference[0], centre[1] - reference[1])
            if state.worst is None or reach > state.worst["reach_mm"]:
                state.worst = {"source": source, "values": dict(values), "reach_mm": reach,
                               "centre_of_mass": [round(v, 4) for v in centre]}
        state.evaluated += 1
    return state


def pose_command(args: argparse.Namespace, values: dict[str, float]) -> str:
    parts = ["uv run --script pose.py", f"--hw {args.hw}"]
    parts.append(f"--step {args.step}" if args.step else f"--parts-dir {args.parts_dir}")
    parts += [f"--attach {spec}" for spec in args.attach]
    parts += [f"--set {jid}={value!r}" for jid, value in values.items()]
    parts.append(f"--out {args.worst_step}")
    return " ".join(parts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Kinematic sweep with interference and clearance checks")
    pose.add_geometry_arguments(parser)
    parser.add_argument("--worst-step", type=Path, required=True, help="posed STEP AP242 of the worst-case pose")
    parser.add_argument("--steps", type=int, default=19, help="values per joint in the per-joint sweeps (>= 2)")
    parser.add_argument("--grid", type=int, default=3, help="values per joint in the combined grid (0 = off, else >= 2)")
    parser.add_argument("--end-effector", help="part for the reach envelope and worst case")
    parser.add_argument("--include-pair", action="append", default=[], metavar="PN:PN",
                        help="check a joint-connected pair as well (repeatable)")
    parser.add_argument("--min-clearance", type=float, default=0.0, help="required clearance in mm (0 = report only)")
    parser.add_argument("--volume-tol", type=float, default=1e-3, help="overlap volume in mm^3 that counts as a collision")
    parser.add_argument("--max-poses", type=int, default=5000, help="refuse sweeps with more poses than this")
    parser.add_argument("--time-limit", type=float, default=600.0, help="seconds before the sweep stops as incomplete")
    args = parser.parse_args(argv)
    if args.steps < 2 or args.grid == 1 or args.grid < 0:
        print("sweep: --steps must be >= 2 and --grid 0 or >= 2", file=sys.stderr)
        return 2
    started = time.monotonic()
    try:
        _, chain, parts = pose.load_inputs(args)
        if not chain.movable:
            raise pose.MotionError("the chain has no movable joint to sweep")
        bound = pose_count_bound(chain, args.steps, args.grid)
        if bound > args.max_poses:
            raise pose.MotionError(f"{bound} poses exceed --max-poses {args.max_poses}; lower --steps or --grid")
        pairs, excluded = pairs_to_check(chain, args.include_pair)
        effector = end_effector(chain, args.end_effector)
        path = [j for j in chain.path(effector) if j.movable]
        if not path:
            raise pose.MotionError(f"no movable joint moves the end effector {effector}")
        geometry = Geometry({pn: parts[pn] for pn in chain.parts})
        loaded = time.monotonic()
        poses = generate_poses(chain, args.steps, args.grid)
        state = sweep(chain, geometry, poses, pairs, effector, path[0].origin, args.volume_tol,
                      loaded + args.time_limit)
        swept = time.monotonic()
        complete = state.evaluated == len(poses)
        worst = None
        if complete and state.worst is not None:
            pose.write_posed(args.worst_step, args.hw, chain, parts, state.worst["values"])
            worst = {
                "criterion": CRITERION,
                "definition": (f"horizontal (XY) distance from the {path[0].id} origin to the {effector} "
                               "centre of mass; gravity along -Z; collision-free poses only"),
                "source": state.worst["source"],
                "pose": rounded(state.worst["values"]),
                "reach_mm": round(state.worst["reach_mm"], 3),
                "centre_of_mass": state.worst["centre_of_mass"],
                "step": str(args.worst_step),
                "command": pose_command(args, state.worst["values"]),
            }
        exported = time.monotonic()
    except (pose.MotionError, OSError) as error:
        print(f"sweep: {error}", file=sys.stderr)
        return 2
    clearance = sorted(state.clearance.values(), key=lambda item: item["clearance_mm"])
    for item in clearance:
        item["clearance_mm"] = round(item["clearance_mm"], 4)
    findings = [
        {"check": "min_clearance", "pair": item["pair"], "clearance_mm": item["clearance_mm"],
         "required_mm": args.min_clearance, "pose": item["pose"]}
        for item in clearance if item["clearance_mm"] < args.min_clearance
    ]
    failed = bool(state.collisions or findings)
    status = "incomplete" if not complete else ("fail" if failed else "pass")
    per_pose = (swept - loaded) / state.evaluated if state.evaluated else 0.0
    print(json.dumps({
        "status": status,
        "poses": {"evaluated": state.evaluated, "planned": len(poses), "steps_per_joint": args.steps,
                  "grid_per_joint": args.grid, "movable_joints": [j.id for j in chain.movable]},
        "pairs": {"checked": [list(p) for p in pairs], "excluded_adjacent": [list(p) for p in excluded]},
        "collision_pose_count": len(state.collisions),
        "collisions": state.collisions[:MAX_LISTED],
        "min_clearance": clearance,
        "clearance_findings": findings,
        "reach_envelope": {"part": effector, "min": [round(v, 3) for v in state.envelope_min],
                           "max": [round(v, 3) for v in state.envelope_max], "units": "mm"},
        "worst_case": worst,
        "timings_s": {"load": round(loaded - started, 2), "sweep": round(swept - loaded, 2),
                      "export": round(exported - swept, 2), "total": round(time.monotonic() - started, 2),
                      "per_pose_ms": round(per_pose * 1000, 1),
                      "pair_evaluations": geometry.evaluations, "cache_hits": geometry.cache_hits},
    }, indent=2))
    if not complete:
        print(f"sweep: stopped after {state.evaluated} of {len(poses)} poses at --time-limit {args.time_limit} s",
              file=sys.stderr)
        return 2
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # an OCCT or FreeCAD failure is infrastructure, never a check result
        traceback.print_exc()
        sys.exit(2)
