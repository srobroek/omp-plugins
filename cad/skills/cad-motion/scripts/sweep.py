# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0"]
# ///
"""Kinematic sweep: interference, clearance, reach envelope, and worst-case pose.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/sweep.py --hw HW
        (--version vN|latest | --step ASSEMBLY.step | --parts-dir DIR)
        [--attach REF=PARENT_REF ...] --worst-step WORST.step
        [--steps 19] [--grid 3] [--end-effector REF] [--include-pair REF:REF ...]
        [--min-clearance 0] [--pair-clearance REF:REF=MM ...] [--volume-tol 0.001]
        [--max-poses 5000] [--time-limit 600] [--jobs 1|N|auto] [--cache DIR | --no-cache]
        [--worst-criterion max_horizontal_reach|minimum_clearance|maximum_interference]

Inputs and kinematics are pose.py's (same options, same occurrence chain): the
geometry is at the zero pose, so pass a cad-model version with `--version`, not
its nominal-pose assembly.step. A REF is a PN placed once or `@id` for one
occurrence; a PN placed several times is ambiguous and refused.

Poses: only independent joints are sampled; a coupled (dependent) joint is
derived from them at every sample (pose.py `Chain.complete`) before any
placement. For every independent joint, `--steps` values evenly spaced through
its [min, max], unwrapped (a four-stroke crank declared 0..720 is sampled over
720 degrees), with the other independent joints at nominal; plus a combined
grid of `--grid` evenly spaced values per independent joint (`--grid 0` turns
it off). Samples with identical independent values are evaluated once. A sample
whose derived value leaves its joint's [min, max] is a joint_limit finding and
is not measured. A pass proves the sampled poses, not continuous freedom from
collision.

Pairs: every pair of chain occurrences, including two occurrences of one PN,
except joint-connected parent/child pairs (fixed joints and --attach included);
`--include-pair A:B` puts an excluded pair back. Per pose and pair: pose.py's
`interference`, the one interference rule cad-model `check` uses too: the
minimum distance (BRepExtrema_DistShapeShape; 0 when one part lies inside a
solid of the other, a solid of a compound part included) and, when it is within
1e-6 mm, the overlap volume (non-destructive BRepAlgoAPI_Common, measured with
pose.py's adaptive `volume_properties`). Centres of mass use `volume_properties`
as well.
Every pair request of every sample is planned first, then measured by
pair_measure.py, then reduced in sample order. A pair's placement is b's
definition in the frame of a's, composed from the joints below the pair's
lowest common ancestor only, and a measurement is reused within the run on the
two definitions and the exact bits of that placement: a joint sweep measures
only the pairs that joint moves, two same-PN pairs in the same relative
placement share one measurement, and every value is the one an unshared
measurement gives. A request is not measured at all when an
exact lower bound on its distance (the gap between the placed bounding boxes,
or a measured distance at a nearby sample minus how far b's box moves between
the two) exceeds the pair's smallest distance so far, 1e-6 mm and each
threshold of the pair: no reported value or verdict can depend on it (`pruned`
in `timings_s`).

Checks: a collision is an overlap volume above `--volume-tol` mm^3 (default
pose.py's INTERFERENCE_MM3, 1e-3) on a pair whose overlap hw/interfaces.yaml
does not declare (pair_policy.py: an interference press fit or a heat-set
insert on exactly that occurrence pair); a clearance finding is a minimum
distance below `--min-clearance` mm (off at 0), compared before the output
rounds it to 4 decimals, on a checked pair that hw/interfaces.yaml does not
declare fitted. A fitted pair (a press fit, running fit or heat-set insert on
exactly that occurrence pair, `pairs.declared_fit`) is fitted or contacting by
design and inherits no global running clearance, joint-connected or not.

Pair requirements: each clearance requirement of hw/interfaces.yaml (an
interface `type: clearance` with `pair: [REF, REF]` and `min_clearance_mm`;
pair_policy.py) and each `--pair-clearance REF:REF=MM`, which adds a
requirement for this run or overrides the record's on that pair. Every
requirement is measured at every evaluated sample, whatever joins its pair: a
joint-connected, fitted or declared-overlap pair is held to it like any other,
because the requirement is explicit, not the global `--min-clearance`. It fails
when a measured distance is below it, compared unrounded. `pair_clearance`
reports per requirement the pair, `required_mm`, the smallest `clearance_mm`
with its sample and pose (the larger overlap breaks a tie at distance 0),
`samples_below`, and the record `source` or the option that set it.

Reach envelope: the union of the end-effector's posed bounding boxes.
End effector: `--end-effector`, else the occurrence with the most movable
joints between it and the ground (first in joint order on a tie).

Worst case, by `--worst-criterion`; ties go to the earliest sample:
    max_horizontal_reach (default): among collision-free poses, the largest
        horizontal (XY, gravity along -Z) distance from the first joint origin
        on the end effector's path to the end effector's centre of mass: the
        largest cantilever moment arm, the static FEA load case.
    minimum_clearance: the smallest clearance margin, a pair's minimum
        distance minus its tightest applicable requirement: its explicit
        clearance requirement, and `--min-clearance` on a checked pair that is
        not fitted; a larger undeclared overlap breaks a tie.
    maximum_interference: the largest undeclared overlap volume above
        `--volume-tol`; none when nothing collides.
These are geometric criteria; none of them is a stress load case by itself.
The worst pose is written with pose.py's posed-STEP writer to `--worst-step`
(one product per PN, one `<PN> <title> [@id]` component per occurrence) and
its evidence to `<WORST.step>.json`: criterion and metric, sample, pair,
independent and complete pose, units, input provenance, the STEP's SHA-256,
the occurrence -> PN and component-name map, and a replay command that sets
the independent joints only. Both files are removed when the run starts, so
an incomplete run, an error, or a sweep with no eligible pose (`worst_case`
null) leaves none behind.

Runtime is bounded: more than `--max-poses` poses is refused up front, and a
sweep that passes `--time-limit` seconds stops measuring and reports
`incomplete`, with the findings of the leading samples it measured in full
(`poses.evaluated`; requests are measured out of sample order, so these can be
few).

Measurements persist across runs in the pair cache (pair_measure.PairCache,
`--cache DIR`, default `$XDG_CACHE_HOME/cad-motion`, else `~/.cache/cad-motion`),
keyed by both definitions' geometry, the exact placement and the measuring
code, kernel and platform, so a repeat measures only what changed and reports
the same bits (`disk_hits` in `timings_s`). `--no-cache` reads and writes none.

stdout: JSON summary with timings; pairs and parts are reported as references
(`@id`, or the PN of a singleton). stderr: diagnostics.
Exit 0 = no collision, clearance, pair-requirement or joint-limit finding,
1 = a collision, clearance, pair-requirement or joint-limit finding, 2 = usage
or infrastructure error, or an incomplete sweep.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import itertools
import json
import math
import shutil
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _load(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


pose = sys.modules.get("cad_motion_pose") or _load("cad_motion_pose", Path(__file__).with_name("pose.py"))
pair_policy = sys.modules.get("cad_motion_pair_policy") or _load("cad_motion_pair_policy",
                                                                  Path(__file__).with_name("pair_policy.py"))
pair_measure = sys.modules.get("cad_motion_pair_measure") or _load("cad_motion_pair_measure",
                                                                    Path(__file__).with_name("pair_measure.py"))

CRITERIA = {
    "max_horizontal_reach": "horizontal (XY) distance from the {joint} origin to the {effector} centre of mass; "
                            "gravity along -Z; collision-free poses only",
    "minimum_clearance": "smallest minimum distance minus the pair's tightest requirement: its clearance "
                         "requirement, and the required {required} mm on a checked pair that is not fitted; "
                         "a larger undeclared overlap breaks a tie",
    "maximum_interference": "largest undeclared overlap volume above {volume_tol} mm^3",
}
MAX_LISTED = 50
EVIDENCE_SCHEMA = 1


def linspace(low: float, high: float, count: int) -> list[float]:
    if count == 1 or low == high:
        return [low]
    return [low + (high - low) * k / (count - 1) for k in range(count)]


@dataclass(frozen=True)
class Sample:
    index: int
    source: str  # sweep:<joint id> or grid
    settings: dict[str, float]  # the independent joints' values
    values: dict[str, float]  # the complete coordinate map, dependents derived


def generate_poses(chain: Any, steps: int, grid: int) -> list[Sample]:
    """The per-joint sweeps then the grid over the independent joints, each completed with its derived
    coordinates; samples with the same independent values are dropped."""
    independent = chain.independent
    nominal = {j.id: j.nominal for j in independent}
    samples: list[Sample] = []
    seen: set[tuple[float, ...]] = set()

    def add(source: str, settings: dict[str, float]) -> None:
        key = tuple(round(settings[j.id], 9) for j in independent)
        if key not in seen:
            seen.add(key)
            samples.append(Sample(len(samples), source, settings, chain.complete(settings)))

    for joint in independent:
        for value in linspace(joint.min, joint.max, steps):
            add(f"sweep:{joint.id}", {**nominal, joint.id: value})
    if grid:
        for combo in itertools.product(*(linspace(j.min, j.max, grid) for j in independent)):
            add("grid", dict(zip((j.id for j in independent), combo)))
    return samples


def pose_count_bound(chain: Any, steps: int, grid: int) -> int:
    count = steps * len(chain.independent)
    return count + (grid ** len(chain.independent) if grid else 0)


def pairs_to_check(chain: Any, include: list[str]) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """(checked pairs, excluded adjacent pairs) of occurrence ids, each pair in chain order."""
    adjacent = chain.adjacent_pairs()
    wanted: set[frozenset[str]] = set()
    for spec in include:
        a, sep, b = spec.partition(":")
        if not sep or not pose.is_ref(a) or not pose.is_ref(b):
            raise pose.MotionError(f"--include-pair expects REF:REF of two chain occurrences, got {spec!r}")
        ids = (chain.resolve(a, f"--include-pair {spec}: "), chain.resolve(b, f"--include-pair {spec}: "))
        if ids[0] == ids[1]:
            raise pose.MotionError(f"--include-pair {spec}: both ends are one occurrence")
        wanted.add(frozenset(ids))
    checked, excluded = [], []
    for a, b in itertools.combinations(chain.ids, 2):
        key = frozenset((a, b))
        (excluded if key in adjacent and key not in wanted else checked).append((a, b))
    return checked, excluded


class Geometry:
    """OCP queries on PN definition shapes, placed per occurrence: centres of mass and posed
    bounding boxes. Pair measurements are pair_measure.py's."""

    def __init__(self, chain: Any, definitions: dict[str, Any]) -> None:
        self.chain = chain
        self.definitions = definitions
        self.centres = {pn: self._centre(part.shape) for pn, part in definitions.items()}

    @staticmethod
    def _centre(shape: Any) -> tuple[float, float, float]:
        point = pose.volume_properties(shape).CentreOfMass()
        return (point.X(), point.Y(), point.Z())

    def centre(self, occurrence_id: str, rigid: Any) -> tuple[float, float, float]:
        return rigid.apply(self.centres[self.chain.pn(occurrence_id)])

    def bounds(self, occurrence_id: str, rigid: Any) -> tuple[list[float], list[float]]:
        return pair_measure.box_corners(pose.placed(self.definitions[self.chain.pn(occurrence_id)].shape, rigid))


@dataclass
class SweepState:
    collisions: list[dict[str, Any]] = field(default_factory=list)
    limits: list[dict[str, Any]] = field(default_factory=list)  # samples a derived value puts outside a limit
    clearance: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    pair_clearance: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)  # per requirement pair
    envelope_min: list[float] = field(default_factory=lambda: [math.inf] * 3)
    envelope_max: list[float] = field(default_factory=lambda: [-math.inf] * 3)
    worst: dict[str, Any] | None = None  # sample, rank (lower is worse), metric, pair
    evaluated: int = 0


def end_effector(chain: Any, explicit: str | None) -> str:
    if explicit:
        return chain.resolve(explicit, "--end-effector: ")
    depth = {oid: sum(1 for j in chain.path(oid) if j.movable) for oid in chain.ids}
    return max(chain.ids, key=lambda oid: depth[oid])  # max keeps the first on a tie


def rounded(values: dict[str, float]) -> dict[str, float]:
    return {k: round(v, 6) + 0.0 for k, v in values.items()}


@dataclass(frozen=True)
class PlannedSample:
    """One sample of the plan: its joint-limit findings (then nothing is measured), or its transforms
    and its requests, `requests[start:start + len(measured)]` of the plan."""

    sample: Sample
    limits: list[dict[str, Any]]
    transforms: dict[str, Any] | None
    start: int


@dataclass(frozen=True)
class Plan:
    """Every pair request of a sweep, in evaluation order: per sample, one request per pair in
    `measured` (the `checked` pairs, then the requirement pairs that are not checked)."""

    checked: set[tuple[str, str]]
    measured: list[tuple[str, str]]
    thresholds: dict[tuple[str, str], tuple[float, ...]]  # positive clearance thresholds per pair
    tightest: dict[tuple[str, str], tuple[float, str]]  # (required mm, source) of the tightest requirement
    samples: list[PlannedSample]
    requests: list[Any]  # pair_measure.Request


def plan(chain: Any, samples: list[Sample], pairs: list[tuple[str, str]], fitted: set[tuple[str, str]],
         requirements: dict[tuple[str, str], dict[str, Any]], required: float) -> Plan:
    """The requests of every sample: occurrence b's definition placed by T_a^-1 T_b in the frame of
    a's, composed from the pair's lowest common ancestor (Chain.relative_transforms). `requirements`
    (pair_requirements) are measured on their pairs at every sample whether or
    not the pairs are checked; `fitted` pairs (sorted occurrence ids) are not held to `required`
    (--min-clearance)."""
    checked = set(pairs)
    measured = [*pairs, *(pair for pair in requirements if pair not in checked)]
    applicable: dict[tuple[str, str], list[tuple[float, str]]] = {}  # (required mm, source), explicit first
    for pair in measured:
        applicable[pair] = [(requirements[pair]["required_mm"], requirements[pair]["source"])] if pair in requirements else []
        if pair in checked and tuple(sorted(pair)) not in fitted:
            applicable[pair].append((required, "--min-clearance"))
    thresholds = {pair: tuple(value for value, _ in options if value > 0) for pair, options in applicable.items()}
    tightest = {pair: max(options, key=lambda option: option[0]) for pair, options in applicable.items() if options}
    planned, requests = [], []
    for sample in samples:
        limits = chain.limit_findings(sample.values)
        if limits:
            planned.append(PlannedSample(sample, limits, None, len(requests)))
            continue
        transforms = chain.transforms(sample.values)
        planned.append(PlannedSample(sample, [], transforms, len(requests)))
        relative = chain.relative_transforms(sample.values, measured)
        requests += [pair_measure.Request(chain.pn(a), chain.pn(b), relative[(a, b)],
                                          thresholds=thresholds[(a, b)], group=(a, b)) for a, b in measured]
    return Plan(checked, measured, thresholds, tightest, planned, requests)


def measured_prefix(chain: Any, plan: Plan, outcomes: list[Any]) -> int:
    """How many leading samples the reduction can take: every request answered, and every pruned
    one proved by a request inside them, so it is above the minimum of those samples too (a run
    the deadline stopped measured out of sample order). A kernel failure is an error."""
    width = len(plan.measured)
    for index, outcome in enumerate(outcomes):
        if isinstance(outcome, pair_measure.Failure):
            a, b = plan.measured[index % width]
            raise pose.MotionError(f"{chain.ref(a)} / {chain.ref(b)}: {outcome.message}")
    count, proof = 0, -1  # proof: the last request a pruned request so far relies on
    for taken, planned in enumerate(plan.samples, start=1):
        block = outcomes[planned.start:planned.start + width] if planned.transforms is not None else []
        if None in block:
            break
        proof = max([proof, *(outcome.witness for outcome in block if isinstance(outcome, pair_measure.Pruned))])
        if proof < planned.start + len(block):
            count = taken
    return count


def reduce(chain: Any, geometry: Geometry, plan: Plan, outcomes: list[Any], evaluated: int,
           allowed: set[tuple[str, str]], requirements: dict[tuple[str, str], dict[str, Any]], effector: str,
           reference: tuple[float, float, float], volume_tol: float, criterion: str) -> SweepState:
    """The findings of the first `evaluated` samples of `plan` from their request `outcomes`.
    `allowed` holds the sorted occurrence pairs whose overlap is declared.

    A pair's margin is its distance minus its tightest applicable requirement. The worst sample
    under `criterion` has the smallest rank; a strict comparison keeps the earliest on a tie.
    """
    state = SweepState(evaluated=evaluated)
    width = len(plan.measured)
    for planned in plan.samples[:evaluated]:
        sample = planned.sample
        if planned.limits:
            state.limits.append({"sample": sample.index, "source": sample.source,
                                 "independent_pose": rounded(sample.settings), "findings": planned.limits})
            continue
        transforms = planned.transforms
        hits = []
        # ((margin, -undeclared overlap), distance, pair, (required mm, source)) of the smallest margin
        closest: tuple[tuple[float, float], float, list[str] | None, tuple[float, str] | None] = \
            ((math.inf, 0.0), math.inf, None, None)
        overlap: tuple[float, list[str] | None] = (0.0, None)  # largest undeclared volume above volume_tol
        for (a, b), outcome in zip(plan.measured, outcomes[planned.start:planned.start + width]):
            distance, volume = pair_measure.reading(outcome)
            requirement = requirements.get((a, b))
            if requirement is not None:
                seen = state.pair_clearance.setdefault((a, b), {"clearance_mm": math.inf, "overlap_mm3": 0.0,
                                                                "sample": None, "samples_below": 0})
                seen["samples_below"] += distance < requirement["required_mm"]
                if (distance, -volume) < (seen["clearance_mm"], -seen["overlap_mm3"]):
                    seen.update(clearance_mm=distance, overlap_mm3=volume, sample=sample)
            refs = [chain.ref(a), chain.ref(b)]
            undeclared = 0.0
            if (a, b) in plan.checked:
                best = state.clearance.get((a, b))
                if best is None or distance < best["clearance_mm"]:
                    state.clearance[(a, b)] = {"pair": refs, "clearance_mm": distance, "pose": rounded(sample.values),
                                               "independent_pose": rounded(sample.settings)}
                if tuple(sorted((a, b))) not in allowed and volume > volume_tol:
                    undeclared = volume
                    hits.append({"pair": refs, "volume_mm3": round(volume, 4)})
                    if volume > overlap[0]:
                        overlap = (volume, refs)
            limit = plan.tightest.get((a, b))
            if limit is not None and (distance - limit[0], -undeclared) < closest[0]:
                closest = ((distance - limit[0], -undeclared), distance, refs, limit)
        low, high = geometry.bounds(effector, transforms[effector])
        state.envelope_min = [min(m, v) for m, v in zip(state.envelope_min, low)]
        state.envelope_max = [max(m, v) for m, v in zip(state.envelope_max, high)]
        if hits:
            state.collisions.append({"sample": sample.index, "source": sample.source,
                                     "independent_pose": rounded(sample.settings), "pose": rounded(sample.values),
                                     "pairs": hits})
        if criterion == "max_horizontal_reach":
            if hits:
                continue
            centre = geometry.centre(effector, transforms[effector])
            reach = math.hypot(centre[0] - reference[0], centre[1] - reference[1])
            rank, metric, pair = (-reach,), {"reach_mm": round(reach, 3),
                                             "centre_of_mass": [round(v, 4) for v in centre]}, None
        elif criterion == "minimum_clearance":
            if closest[3] is None:
                continue
            margin = closest[0][0]
            rank = (margin, -overlap[0])
            metric = {"clearance_mm": round(closest[1], 4), "required_mm": closest[3][0],
                      "requirement": closest[3][1], "margin_mm": round(margin, 4), "overlap_mm3": round(overlap[0], 4)}
            pair = closest[2]
        else:  # maximum_interference
            if not hits:
                continue
            rank, metric, pair = (-overlap[0],), {"volume_mm3": round(overlap[0], 4)}, overlap[1]
        if state.worst is None or rank < state.worst["rank"]:
            state.worst = {"sample": sample, "rank": rank, "metric": metric, "pair": pair}
    return state


def sweep(chain: Any, geometry: Geometry, measurer: Any, samples: list[Sample], pairs: list[tuple[str, str]],
          allowed: set[tuple[str, str]], fitted: set[tuple[str, str]],
          requirements: dict[tuple[str, str], dict[str, Any]], effector: str, reference: tuple[float, float, float],
          volume_tol: float, criterion: str, required: float, deadline: float) -> SweepState:
    """Plan every sample's requests, measure them with `measurer` (pair_measure.PairMeasurer) until
    `deadline`, and reduce the samples measured in full. `fitted` pairs are declared as a fit or
    insert, which `required` (--min-clearance) does not bind."""
    planned = plan(chain, samples, pairs, fitted, requirements, required)
    outcomes = measurer.measure(planned.requests, deadline, stop_on_failure=True, prune=True)
    return reduce(chain, geometry, planned, outcomes, measured_prefix(chain, planned, outcomes), allowed,
                  requirements, effector, reference, volume_tol, criterion)


def clearance_report(clearance: dict[tuple[str, str], dict[str, Any]], required: float,
                     fitted: set[tuple[str, str]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(per-pair minimum clearance smallest first, findings for the pairs below `required` mm).

    A fitted pair (sorted occurrence ids in `fitted`) is listed but never a finding. The comparison
    uses the measured distance; only the output rounds it to 4 decimals.
    """
    ordered = sorted(clearance.items(), key=lambda item: item[1]["clearance_mm"])
    rows = [{**item, "clearance_mm": round(item["clearance_mm"], 4)} for _, item in ordered]
    findings = [{"check": "min_clearance", "pair": row["pair"], "clearance_mm": row["clearance_mm"],
                 "required_mm": required, "pose": row["pose"]}
                for (pair, item), row in zip(ordered, rows)
                if item["clearance_mm"] < required and tuple(sorted(pair)) not in fitted]
    return rows, findings


def pair_clearance_report(chain: Any, requirements: dict[tuple[str, str], dict[str, Any]],
                          observed: dict[tuple[str, str], dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per requirement, smallest margin first: pair, required_mm, the smallest measured
    clearance_mm with its overlap, sample and pose, samples_below, status, and its source.

    The verdict uses the measured distances; only the output rounds them to 4 decimals. A
    requirement no sample measured (every one a joint_limit finding) fails.
    """
    rows = []
    for (a, b), requirement in requirements.items():
        seen = observed.get((a, b))
        row: dict[str, Any] = {"pair": [chain.ref(a), chain.ref(b)], "required_mm": requirement["required_mm"],
                               "status": "fail", "clearance_mm": None, "overlap_mm3": None, "samples_below": 0,
                               "sample": None, "independent_pose": None, "pose": None}
        margin = -math.inf
        if seen is not None:
            sample = seen["sample"]
            margin = seen["clearance_mm"] - requirement["required_mm"]
            row.update(status="fail" if seen["samples_below"] else "pass", clearance_mm=round(seen["clearance_mm"], 4),
                       overlap_mm3=round(seen["overlap_mm3"], 4), samples_below=seen["samples_below"],
                       sample={"index": sample.index, "source": sample.source},
                       independent_pose=rounded(sample.settings), pose=rounded(sample.values))
        row.update({key: requirement[key] for key in ("interface", "source", "overrides") if key in requirement})
        rows.append((margin, row))
    return [row for _, row in sorted(rows, key=lambda item: item[0])]


def pair_requirements(chain: Any, declared: list[dict[str, Any]],
                      options: list[str]) -> dict[tuple[str, str], dict[str, Any]]:
    """Clearance requirements keyed by occurrence pair in chain order, as {required_mm, source[,
    interface][, overrides]}: the record's (pair_policy.declared_clearances), then each `--pair-clearance
    REF:REF=MM`, which adds a requirement for this run or overrides the one already on that pair."""
    order = {oid: index for index, oid in enumerate(chain.ids)}

    def in_order(ids: list[str] | tuple[str, str]) -> tuple[str, str]:
        a, b = sorted(ids, key=order.__getitem__)
        return a, b

    requirements: dict[tuple[str, str], dict[str, Any]] = {}
    for item in declared:
        missing = [oid for oid in item["pair"] if oid not in order]
        if missing:
            raise pose.MotionError(f"{item['source']}: occurrence {missing[0]} is not in the swept chain "
                                   "(no geometry and no joint)")
        requirements[in_order(item["pair"])] = {"required_mm": item["min_clearance_mm"],
                                                "interface": item["interface"], "source": item["source"]}
    for spec in options:
        refs, sep, text = spec.rpartition("=")
        a, colon, b = refs.partition(":")
        try:
            required = float(text)
        except ValueError:
            required = math.nan
        if not (sep and colon and pose.is_ref(a) and pose.is_ref(b) and math.isfinite(required) and required > 0):
            raise pose.MotionError(f"--pair-clearance expects REF:REF=MM with MM > 0, got {spec!r}")
        where = f"--pair-clearance {spec}: "
        ids = (chain.resolve(a, where), chain.resolve(b, where))
        if ids[0] == ids[1]:
            raise pose.MotionError(f"{where}both ends are one occurrence")
        previous = requirements.get(in_order(ids))
        requirements[in_order(ids)] = {"required_mm": required, "source": f"--pair-clearance {spec}",
                                       **({"overrides": previous["source"]} if previous else {})}
    return requirements


def pose_command(args: argparse.Namespace, settings: dict[str, float]) -> str:
    """The pose.py command that replays a sample, into this case or scratch output."""
    parts = ["uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/pose.py", f"--hw {args.hw}",
             geometry_option(args)]
    parts += [f"--attach {spec}" for spec in args.attach]
    parts += [f"--set {jid}={value!r}" for jid, value in settings.items()]
    if args.version:
        parts.extend(("--case", args.case))
    else:
        parts.extend(("--out", str(args.worst_step)))
    return " ".join(parts)


def geometry_option(args: argparse.Namespace) -> str:
    if args.version:
        return f"--version {args.version}"
    return f"--step {args.step}" if args.step else f"--parts-dir {args.parts_dir}"


def evidence_path_for(step: Path) -> Path:
    """`worst.step` -> `worst.step.json`."""
    return step.with_name(step.name + ".json")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write_evidence(args: argparse.Namespace, chain: Any, definitions: dict[str, Any], worst: dict[str, Any],
                   description: dict[str, Any], digest: str, path: Path | None = None,
                   record_hw: Path | None = None) -> Path:
    """Write the replayable evidence beside `worst.step` or inside its staged bundle."""
    sample = worst["sample"]
    occurrences = {}
    for oid in chain.ids:
        part = definitions[chain.pn(oid)]
        occurrences[oid] = {"PN": chain.pn(oid), "ref": chain.ref(oid),
                            "component": pose.component_name(part, chain.inventory.get(oid)) or part.name}
    path = path or evidence_path_for(args.worst_step)
    record_hw = record_hw or args.hw
    path.write_text(json.dumps({
        "schema_version": EVIDENCE_SCHEMA, "producer": "cad-motion sweep.py", **description,
        "metric": worst["metric"], "pair": worst["pair"],
        "sample": {"index": sample.index, "source": sample.source},
        "independent_pose": sample.settings, "pose": sample.values,
        "units": {joint.id: joint.unit for joint in chain.movable},
        "inputs": {"assembly_yaml_sha256": sha256(record_hw / "assembly.yaml"),
                   "geometry": geometry_option(args), "attach": list(args.attach),
                   "pair_clearance": list(args.pair_clearance)},
        "step": {"path": str(args.worst_step), "sha256": digest},
        "occurrences": occurrences, "command": pose_command(args, sample.settings),
    }, indent=2) + "\n", encoding="utf-8")
    return path


def declared_policy(hw: Path, assembly: Any) -> tuple[set[tuple[str, str]], set[tuple[str, str]], list[dict[str, Any]]]:
    """(the sorted occurrence pairs hw/interfaces.yaml allows to overlap, those it declares fitted, its
    clearance requirements), all from pair_policy.py."""
    try:
        interfaces = pair_policy.read_interfaces(hw)
        press_fits = pair_policy.declared_press_fits(hw, interfaces, assembly)
        heat_sets = pair_policy.declared_heat_sets(hw, interfaces, assembly)
        fitted = pair_policy.fitted_pairs(press_fits, pair_policy.declared_running_fits(hw, interfaces, assembly),
                                          heat_sets)
        return (pair_policy.allowed_pairs(press_fits, heat_sets), fitted,
                pair_policy.declared_clearances(hw, interfaces, assembly))
    except pair_policy.PolicyError as error:
        raise pose.MotionError(str(error)) from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Kinematic sweep with interference and clearance checks")
    pose.add_geometry_arguments(parser)
    parser.add_argument("--case", default="sweep", help="versioned motion bundle case ID")
    parser.add_argument("--replace", action="store_true", help="retain and replace a different recipe")
    parser.add_argument("--worst-criterion", choices=sorted(CRITERIA), default="max_horizontal_reach",
                        help="how the worst-case pose is selected")
    parser.add_argument("--steps", type=int, default=19,
                        help="values per independent joint in the per-joint sweeps (>= 2)")
    parser.add_argument("--grid", type=int, default=3,
                        help="values per independent joint in the combined grid (0 = off, else >= 2)")
    parser.add_argument("--end-effector", metavar="REF", help="occurrence for the reach envelope and worst case")
    parser.add_argument("--include-pair", action="append", default=[], metavar="REF:REF",
                        help="check a joint-connected pair as well (repeatable)")
    parser.add_argument("--min-clearance", type=float, default=0.0, help="required clearance in mm (0 = report only)")
    parser.add_argument("--pair-clearance", action="append", default=[], metavar="REF:REF=MM",
                        help="require at least MM between two occurrences at every sample; adds a requirement "
                             "or overrides interfaces.yaml's on that pair (repeatable)")
    parser.add_argument("--volume-tol", type=float, default=pose.INTERFERENCE_MM3,
                        help="overlap volume in mm^3 that counts as a collision")
    parser.add_argument("--max-poses", type=int, default=5000, help="refuse sweeps with more poses than this")
    parser.add_argument("--time-limit", type=float, default=600.0, help="seconds before the sweep stops as incomplete")
    parser.add_argument("--jobs", type=pair_measure.jobs_argument, default="1", metavar="N|auto",
                        help=f"worker processes measuring pairs (1, the default: this process, on OCCT's thread "
                             f"pool; auto: the CPU count, at most {pair_measure.AUTO_JOBS_MAX})")
    caching = parser.add_mutually_exclusive_group()
    caching.add_argument("--cache", type=Path, metavar="DIR",
                         help="pair measurement cache directory (default: $XDG_CACHE_HOME/cad-motion, else "
                              "~/.cache/cad-motion)")
    caching.add_argument("--no-cache", action="store_true", help="measure every pair, reading and writing no cache")
    parser.add_argument("--worst-step", type=Path, help="STEP path for scratch; versioned sweeps publish to hw/motion")
    args = parser.parse_args(argv)
    if args.steps < 2 or args.grid == 1 or args.grid < 0:
        print("sweep: --steps must be >= 2, and --grid 0 or >= 2", file=sys.stderr)
        return 2
    started = time.monotonic()
    try:
        version, record_hw, version_dir = None, args.hw, None
        recipe = None
        if args.version:
            version, version_dir, record_hw = pose.LAYOUT.built_version(args.hw, args.version)
            args.version, args.version_dir, args.record_hw = version, version_dir, record_hw
            pose.LAYOUT.resolve(args.hw, "bundle.motion", V=version, S=args.case)
            recipe = {"operation": "sweep", "case": args.case,
                      "options": {"steps": args.steps, "grid": args.grid, "worst_criterion": args.worst_criterion,
                                  "end_effector": args.end_effector, "include_pair": list(args.include_pair),
                                  "min_clearance": args.min_clearance, "pair_clearance": list(args.pair_clearance),
                                  "volume_tol": args.volume_tol, "max_poses": args.max_poses,
                                  "time_limit": args.time_limit, "jobs": args.jobs, "no_cache": args.no_cache},
                      "attach": list(args.attach),
                      "inputs_sha256": pose.input_sha256(version_dir)}
            reused = pose.LAYOUT.reusable(args.hw, "bundle.motion", {"V": version, "S": args.case}, recipe,
                                          replace=args.replace)
            if reused is not None:
                result = json.loads((reused / "result.json").read_text(encoding="utf-8"))
                result.update(bundle=str(reused), reused=True)
                print(json.dumps(result, indent=2))
                return 1 if result.get("status") == "fail" else 0
        else:
            if args.worst_step is None:
                raise pose.MotionError("--worst-step is required for scratch geometry")
            args.worst_step = pose.LAYOUT.scratch_path(args.hw, args.worst_step, "--worst-step")
            if args.worst_step.exists() or evidence_path_for(args.worst_step).exists():
                raise pose.MotionError(f"--worst-step or its evidence already exists; refusing to overwrite: {args.worst_step}")
        assembly, chain, definitions = pose.load_inputs(args)
        if not chain.independent:
            raise pose.MotionError("the chain has no independent movable joint to sweep")
        bound = pose_count_bound(chain, args.steps, args.grid)
        if bound > args.max_poses:
            raise pose.MotionError(f"{bound} poses exceed --max-poses {args.max_poses}; lower --steps or --grid")
        pairs, excluded = pairs_to_check(chain, args.include_pair)
        allowed, fitted, declared = declared_policy(record_hw, assembly)
        requirements = pair_requirements(chain, declared, args.pair_clearance)
        effector = end_effector(chain, args.end_effector)
        path = [joint for joint in chain.path(effector) if joint.movable]
        if not path:
            raise pose.MotionError(f"no movable joint moves the end effector {chain.ref(effector)}")
        used = {pn: definitions[pn] for pn in {chain.pn(oid) for oid in chain.ids}}
        geometry = Geometry(chain, used)
        cache = None if args.no_cache else pair_measure.PairCache(args.cache or pair_measure.default_cache_dir())
        measurer = pair_measure.PairMeasurer({pn: part.shape for pn, part in used.items()}, jobs=args.jobs, cache=cache)
        loaded = time.monotonic()
        samples = generate_poses(chain, args.steps, args.grid)
        try:
            state = sweep(chain, geometry, measurer, samples, pairs, allowed, fitted, requirements, effector,
                          path[0].origin, args.volume_tol, args.worst_criterion, args.min_clearance,
                          loaded + args.time_limit)
        finally:
            if cache is not None:
                cache.close()
        swept = time.monotonic()
        complete = state.evaluated == len(samples)
        clearance, findings = clearance_report(state.clearance, args.min_clearance, fitted)
        requirement_rows = pair_clearance_report(chain, requirements, state.pair_clearance)
        failed = bool(state.collisions or findings or state.limits or any(row["status"] == "fail" for row in requirement_rows))
        status = "incomplete" if not complete else ("fail" if failed else "pass")
        refs = [[chain.ref(a), chain.ref(b)] for a, b in pairs]
        result: dict[str, Any] = {
            "status": status,
            "poses": {"evaluated": state.evaluated, "planned": len(samples), "steps_per_joint": args.steps,
                      "grid_per_joint": args.grid, "movable_joints": [joint.id for joint in chain.movable],
                      "independent_joints": [joint.id for joint in chain.independent],
                      "dependent_joints": [joint.id for joint in chain.dependent],
                      "spacing": {joint.id: (joint.max - joint.min) / (args.steps - 1) for joint in chain.independent}},
            "pairs": {"checked": refs, "excluded_adjacent": [[chain.ref(a), chain.ref(b)] for a, b in excluded],
                      "declared_overlap": [[chain.ref(a), chain.ref(b)] for a, b in pairs if tuple(sorted((a, b))) in allowed],
                      "declared_fit": [[chain.ref(a), chain.ref(b)] for a, b in pairs if tuple(sorted((a, b))) in fitted]},
            "occurrences": {oid: chain.pn(oid) for oid in chain.ids},
            "collision_pose_count": len(state.collisions), "collisions": state.collisions[:MAX_LISTED],
            "limit_pose_count": len(state.limits), "limit_findings": state.limits[:MAX_LISTED],
            "min_clearance": clearance, "clearance_findings": findings, "pair_clearance": requirement_rows,
            "reach_envelope": {"part": chain.ref(effector), "min": [round(v, 3) for v in state.envelope_min],
                               "max": [round(v, 3) for v in state.envelope_max], "units": "mm"},
            "worst_case": None,
            "timings_s": {"load": round(loaded - started, 2), "sweep": round(swept - loaded, 2),
                          "export": 0.0, "total": round(time.monotonic() - started, 2),
                          "per_pose_ms": round((swept - loaded) / state.evaluated * 1000, 1) if state.evaluated else 0.0,
                          "pair_requests": measurer.requested, "pair_evaluations": measurer.measured,
                          "cache_hits": measurer.reused, "disk_hits": measurer.disk_hits, "pruned": measurer.pruned},
        }
        if complete and state.worst is not None:
            sample = state.worst["sample"]
            description = {"criterion": args.worst_criterion, "definition": CRITERIA[args.worst_criterion].format(
                joint=path[0].id, effector=chain.ref(effector), required=args.min_clearance, volume_tol=args.volume_tol)}
            stage = pose.LAYOUT.staging(args.hw, "bundle.motion") if version else None
            worst_step = stage / "worst.step" if stage else args.worst_step
            try:
                args.worst_step = (pose.LAYOUT.bundle_dir(args.hw, "motion", version, args.case) / "worst.step"
                                   if version else worst_step)
                pose.write_posed(worst_step, record_hw, chain, definitions, sample.values)
                digest = sha256(worst_step)
                evidence_path = (stage / "worst.step.json") if stage else evidence_path_for(worst_step)
                write_evidence(args, chain, definitions, state.worst, description, digest, evidence_path, record_hw)
                result["worst_case"] = {**description, **state.worst["metric"], "pair": state.worst["pair"],
                                         "sample": sample.index, "source": sample.source,
                                         "independent_pose": rounded(sample.settings), "pose": rounded(sample.values),
                                         "step": str(worst_step), "step_sha256": digest,
                                         "evidence": str(evidence_path), "command": pose_command(args, sample.settings)}
                if version:
                    result["worst_case"]["step"] = str(pose.LAYOUT.bundle_dir(args.hw, "motion", version, args.case)
                                                         / "worst.step")
            except Exception:
                if stage is not None:
                    import shutil
                    shutil.rmtree(stage, ignore_errors=True)
                raise
        if version:
            if status == "incomplete":
                raise pose.MotionError(f"sweep incomplete; no bundle published ({state.evaluated}/{len(samples)} poses)")
            stage = stage or pose.LAYOUT.staging(args.hw, "bundle.motion")
            try:
                (stage / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
                published = pose.LAYOUT.publish(args.hw, "bundle.motion", {"V": version, "S": args.case}, stage,
                                                recipe=recipe, producer="cad-motion sweep.py", status=status,
                                                replace=args.replace)
                result["bundle"] = str(published.path)
                result["reused"] = published.reused
            except Exception:
                shutil.rmtree(stage, ignore_errors=True)
                raise
        else:
            result["timings_s"]["export"] = round(time.monotonic() - swept, 2)
            result["timings_s"]["total"] = round(time.monotonic() - started, 2)
        print(json.dumps(result, indent=2))
        if not complete:
            print(f"sweep: stopped after {state.evaluated} of {len(samples)} poses at --time-limit {args.time_limit} s",
                  file=sys.stderr)
            return 2
        return 1 if failed else 0
    except (pose.MotionError, OSError, pose.LAYOUT.LayoutError, pose.LAYOUT.PublishConflict) as error:
        print(f"sweep: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # an OCCT or FreeCAD failure is infrastructure, never a check result
        traceback.print_exc()
        sys.exit(2)
