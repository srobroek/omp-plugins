# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["cadquery-ocp-novtk==8.0.1.1.0", "pyyaml>=6.0", "numpy>=1.26", "python-fcl==0.7.0.11"]
# ///
"""Kinematic sweep: interference, clearance, reach envelope, and worst-case pose.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/sweep.py --hw HW
        (--version vN|latest | --step ASSEMBLY.step | --parts-dir DIR)
        [--attach REF=PARENT_REF ...] --worst-step WORST.step
        [--steps 19] [--grid 3] [--end-effector REF] [--include-pair REF:REF ...]
        [--min-clearance 0] [--pair-clearance REF:REF=MM ...] [--volume-tol 0.001]
        [--max-poses 5000] [--time-limit 600] [--jobs 1|N|auto] [--cache DIR | --no-cache]
        [--exact | --mesh-band 2 [--spot-check | --no-spot-check]] [--subsystem NAME ...]
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

Planning, in this process, from transforms only: each sample's occurrence
transforms are computed once, each occurrence's mesh-vertex box is posed once
per sample (mesh_bound.MeshAssets.posed_boxes), and every pair request carries
the gap between its two boxes less sqrt(3) x both mesh deviations, a lower bound
on its distance that no BRep is posed for. A request is b's definition placed
in the frame of a's, composed from the joints below the pair's lowest common
ancestor only, so a joint sweep measures only the pairs that joint moves; a
revolute angle and a slider-crank's crank angle are reduced exactly to
(-180, 180] before their sine and cosine, so periodic repeats place the very
same bits. pair_measure.py then answers each request (see there): cache hits,
the box and mesh gates, one evaluation per distinct exact key, workers on
chunks of at most 24 requests of one sample, costliest first, each chunk's
results committed to the cache as it finishes. Outcomes are reduced in sample
and pair order, never in completion order.

Fast mode, the default (`--exact` turns it off): a request is not measured when
its own lower bound exceeds 1e-6 mm and the pair's clearing threshold (its
greatest applicable requirement plus that requirement's margin) by more than
`--mesh-band` mm (default 2): the corrected box gap, or the conservative mesh
bound of mesh_bound.py. Such a request is `cleared`: it has no overlap and is
more than the band clear of every threshold. Every measured value stays exact;
a pair whose minimum may lie at a cleared request is reported by its bounds,
`method` "mesh", "box" or "cache-bound" with `clearance_mm` the proved lower
bound and `bound_mm` [lower, upper] (upper null when only a box gap is known),
where an exact pair reads `method` "exact". So collisions, findings, margin
warnings, every `exact` row, the worst case whenever its margin is within the
band, and every verdict are identical to `--exact`'s; a bounded row is not, by
design. Every measurement is checked against the mesh (pair_measure.Suspect): a
suspect value answers nothing, is re-measured with every independent joint
moved +-0.1 and with the two parts swapped, and is listed in
`suspect_measurements`; one its re-measurements do not resolve fails the sweep.
With `--spot-check` (the default in fast mode; `--no-spot-check` skips it),
each pair with a mesh-cleared request has its closest one measured exactly
after the sweep: it must lie within its own bounds, above its threshold plus
the band less 2 x the mesh deflection, without overlap (spot_check.py audits
every mesh-cleared pose of a published sweep).

Margins: a requirement's margin (cad-record design_rules.py: interfaces.yaml
`margin_mm`, else product.yaml `design.clearance_margin_mm`, default 0.1 mm)
turns a measured minimum at or above the requirement but below requirement +
margin into a `margin` row of `warnings`, never a failure; a pair failing any
requirement gets none. Explicit requirements use their interface's margin, the
global `--min-clearance` the default margin.

Subsystems (subsystems.py): the record's subassemblies own the pairs, each
moving occurrence belonging to exactly one; moving/static pairs belong to the
moving body's subassembly, pairs of two owners to `interface`, static pairs to
`static`. `subsystems` reports each subassembly's moving members, its pair and
finding counts and its period per independent joint, detected from the
transforms over a whole verified cycle (a 5.5:1 starter pinion is 720 degrees).
`--subsystem NAME` (repeatable; `interface` and `static` too) measures only the
pairs those owners own, over the very same samples; merge_sweeps.py merges the
bundles of runs covering every owner into exactly the whole sweep's result. A
record whose subassemblies do not partition its moving occurrences is reported
(`subsystems.problems`) and refuses `--subsystem`.

Process groups: a sweep claims a run record under hw/.cad/runs/
(cad-flow process_lifecycle.py) and refuses to start while another sweep, or a
run that left processes behind, is recorded for the hw tree, printing the
command that stops it. Workers die with the sweep, inside a measurement too.
Stop a sweep with that printed command, or Ctrl-C in its terminal.

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
        `--volume-tol`.
These are geometric criteria; none of them is a stress load case by itself.
`worst_case.found` says whether a pose qualified; when none does (nothing
interferes, every pose collides, or no pair has a requirement) the sweep still
passes or fails on its checks, and `worst_case.reason` says why there is no
worst pose. The worst pose is written with pose.py's posed-STEP writer to
`--worst-step`, or the versioned bundle's worst.step (one product per PN, one
`<PN> <title> [@id]` component per occurrence), and its evidence beside it as
`worst.step.json` (`worst_case.evidence`): criterion and metric, sample, pair,
independent and complete pose, units, input provenance, the STEP's SHA-256,
the occurrence -> PN and component-name map, and a replay command that sets
the independent joints only. Both files are removed when the run starts, so
an incomplete run, an error, or a sweep with no worst pose leaves none behind.

Runtime is bounded: more than `--max-poses` poses is refused up front, and a
sweep that passes `--time-limit` seconds stops measuring and reports
`incomplete`, with the findings of the leading samples it measured in full
(`poses.evaluated`).

Measurements persist across runs and tools in the pair cache
(pair_measure.PairCache, `--cache DIR`, default hw/.cad/pairs-v2.sqlite, a
disposable git-ignored file), keyed by both definitions' STEP DATA, the pair's
relative placement and the measuring rule, so a repeat measures only what
changed, and a stopped sweep resumes from the chunks it committed. `--no-cache`
reads and writes none. A versioned bundle is reused only for the same version,
options, rule and producing code.

Versioned bundles also keep, under evidence/, the untruncated statistics a
merge or an audit needs: partition.json (provenance: rule, partition, version
manifest, options, selected pairs, coverage), pair-results.json,
sample-results.json, mesh-cleared.jsonl and spot-check.json.

stdout: JSON summary with timings; pairs and parts are reported as references
(`@id`, or the PN of a singleton). stderr: diagnostics.
Exit 0 = no collision, clearance, pair-requirement or joint-limit finding,
suspect measurement or spot-check failure, 1 = any of those, 2 = usage or
infrastructure error, or an incomplete sweep.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib.util
import itertools
import json
import math
import shutil
import sys
import time
import traceback
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _load(name: str, path: Path) -> Any:
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


HERE = Path(__file__).resolve().parent
SKILLS = HERE.parents[1]
pose = _load("cad_motion_pose", HERE / "pose.py")
pair_policy = _load("cad_motion_pair_policy", HERE / "pair_policy.py")
pair_measure = _load("cad_motion_pair_measure", HERE / "pair_measure.py")
subsystems = _load("cad_motion_subsystems", HERE / "subsystems.py")
continuous = _load("cad_motion_continuous", HERE / "continuous.py")
incremental = _load("cad_motion_incremental", HERE / "incremental.py")
spot_check = _load("cad_motion_spot_check", HERE / "spot_check.py")
design_rules = _load("cad_record_design_rules", SKILLS / "cad-record" / "scripts" / "design_rules.py")
lifecycle = _load("cad_flow_process_lifecycle", SKILLS / "cad-flow" / "scripts" / "process_lifecycle.py")

CRITERIA = {
    "max_horizontal_reach": "horizontal (XY) distance from the {joint} origin to the {effector} centre of mass; "
                            "gravity along -Z; collision-free poses only",
    "minimum_clearance": "smallest minimum distance minus the pair's tightest requirement: its clearance "
                         "requirement, and the required {required} mm on a checked pair that is not fitted; "
                         "a larger undeclared overlap breaks a tie",
    "maximum_interference": "largest undeclared overlap volume above {volume_tol} mm^3",
}
NO_WORST = {  # why a complete sweep has no worst pose under each criterion: `worst_case.reason`, `found` false
    "max_horizontal_reach": "no collision-free sample: every evaluated pose collides",
    "minimum_clearance": "no measured pair has an applicable clearance requirement",
    "maximum_interference": "no interference: no undeclared overlap above {volume_tol} mm^3 at any evaluated sample",
}
MAX_LISTED = 50
EVIDENCE_SCHEMA = 1
RESULT_SCHEMA = 2  # the evidence/ statistics and partition provenance that merge_sweeps.py and spot_check.py read
DEFAULT_BAND_MM = 2.0  # fast mode: how far beyond its clearing threshold a request's proved bound must lie
REEVALUATE_STEP = 0.1  # deg or mm: how far a suspect's re-evaluations move every independent joint
# The code a published bundle depends on: a change to any of them makes an old bundle unreusable.
PRODUCERS = (HERE / "sweep.py", HERE / "subsystems.py", HERE / "continuous.py", HERE / "incremental.py",
             HERE / "spot_check.py", HERE / "pose.py", HERE / "coupling.py", HERE / "pair_policy.py",
             HERE / "pair_measure.py", HERE / "mesh_bound.py", SKILLS / "cad-record" / "scripts" / "design_rules.py")


def claim_run(hw: Path) -> Any:
    """This sweep's run record under hw/.cad/runs/ (process_lifecycle.claim_run), or None where the
    platform has no process groups; a sweep or a stray recorded for `hw` refuses it."""
    try:
        return lifecycle.claim_run(hw, "sweep")
    except lifecycle.RunRefused as error:
        raise pose.MotionError(str(error)) from None
    except lifecycle.Unsupported as error:
        print(f"sweep: no run record: {error}", file=sys.stderr)
        return None


def mesh_bounds(shapes: dict[str, Any]) -> tuple[Any, Any, str]:
    """(mesh_bound module, MeshBounds over `shapes`, a description), or (None, None, why not)
    without numpy or python-fcl: then the BRep box gap alone clears."""
    name = "cad_motion_mesh_bound"
    try:
        module = sys.modules.get(name) or _load(name, HERE / "mesh_bound.py")
    except ImportError as error:
        sys.modules.pop(name, None)
        print(f"sweep: mesh bounds unavailable, the box gap alone clears: {error}", file=sys.stderr)
        return None, None, f"unavailable: {error}"
    return module, module.MeshBounds(shapes), (
        f"{module.version()}; deflection {module.LINEAR_DEFLECTION_MM} mm linear, {module.ANGULAR_DEFLECTION_RAD} rad "
        f"angular; deviation {module.DEVIATION_FACTOR:g} x linear + the part's largest tolerance")


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
        key = sample_key(chain, settings)
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


def sample_key(chain: Any, settings: Mapping[str, float]) -> tuple[float, ...]:
    """The key generate_poses deduplicates samples by."""
    return tuple(round(settings[j.id], 9) for j in chain.independent)


def sweep_paths(chain: Any, samples: list[Sample], steps: int, grid: int) -> list[Any]:
    """The one-dimensional paths of the sweep (continuous.SweepPath), built as generate_poses builds
    its samples but before they are deduplicated, each sample by its global index: every
    independent joint across its range with the others at nominal (`sweep:<joint>`), and every grid
    axis edge with the other grid values held (`grid:<joint>|<settings>`), except a grid line that
    lies on a sweep path through no other values. No path joins two different lines."""
    index = {sample_key(chain, sample.settings): sample.index for sample in samples}
    independent = chain.independent
    nominal = {j.id: j.nominal for j in independent}

    def path(path_id: str, joint: Any, fixed: dict[str, float], values: list[float]) -> Any:
        return continuous.SweepPath(path_id, joint.id, joint.unit, tuple(values),
                                    tuple(index.get(sample_key(chain, {**fixed, joint.id: q})) for q in values),
                                    {jid: value for jid, value in fixed.items() if jid != joint.id})

    paths = [path(f"sweep:{joint.id}", joint, nominal, linspace(joint.min, joint.max, steps)) for joint in independent]
    if grid:
        axes = {j.id: linspace(j.min, j.max, grid) for j in independent}
        swept = {joint.id: set(path.coordinates) for joint, path in zip(independent, paths)}
        for joint in independent:
            others = [j for j in independent if j.id != joint.id]
            for combo in itertools.product(*(axes[j.id] for j in others)):
                fixed = dict(zip((j.id for j in others), combo))
                if fixed == {j.id: nominal[j.id] for j in others} and set(axes[joint.id]) <= swept[joint.id]:
                    continue
                label = ",".join(f"{jid}={value!r}" for jid, value in fixed.items())
                paths.append(path(f"grid:{joint.id}|{label}", joint, fixed, axes[joint.id]))
    return paths


def smoke_poses(chain: Any, smoke: Any) -> list[Sample]:
    """incremental.SmokePlan's samples as sweep samples, the other independent joints at nominal."""
    nominal = {j.id: j.nominal for j in chain.independent}
    samples = []
    for item in smoke.samples:
        settings = {**nominal, **item.settings}
        samples.append(Sample(len(samples), f"smoke:{item.joint}:{'+'.join(item.labels)}", settings,
                              chain.complete(settings)))
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
    """The end effector's exact geometry, placed per sample: its centre of mass and its posed BRep
    bounding box (the reach envelope). Pairs are pair_measure.py's."""

    def __init__(self, chain: Any, definitions: dict[str, Any], effector: str) -> None:
        self.chain = chain
        self.effector = effector
        self.shape = definitions[chain.pn(effector)].shape
        point = pose.volume_properties(self.shape).CentreOfMass()
        self.centre = (point.X(), point.Y(), point.Z())

    def effector_row(self, rigid: Any) -> dict[str, list[float]]:
        """{low, high, centre} of the effector placed by `rigid`."""
        from OCP.Bnd import Bnd_Box
        from OCP.BRepBndLib import BRepBndLib

        box = Bnd_Box()
        BRepBndLib.Add_s(pose.placed(self.shape, rigid), box)
        x0, y0, z0, x1, y1, z1 = box.Get()
        return {"low": [x0, y0, z0], "high": [x1, y1, z1], "centre": list(rigid.apply(self.centre))}


@dataclass
class SweepState:
    collisions: list[dict[str, Any]] = field(default_factory=list)
    limits: list[dict[str, Any]] = field(default_factory=list)  # samples a derived value puts outside a limit
    clearance: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    pair_clearance: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)  # per requirement pair
    # per measured pair with a cleared request (fast mode): the smallest cleared lower bound with its
    # sample and what proved it, and the smallest cleared upper bound
    bounds: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
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
    and its requests, `requests[start:start + len(selected)]` of the plan."""

    sample: Sample
    limits: list[dict[str, Any]]
    transforms: dict[str, Any] | None
    start: int


@dataclass(frozen=True)
class Plan:
    """Every pair request of a sweep, in evaluation order: per sample, one request per `selected`
    pair index into `measured` (the `checked` pairs, then the requirement pairs that are not
    checked). `measured` is the whole sweep's, so its indices name the same pairs in every
    subsystem run of it."""

    checked: set[tuple[str, str]]
    measured: list[tuple[str, str]]
    selected: list[int]
    clearing: dict[tuple[str, str], float]  # greatest requirement + margin per pair: Request.minimum_mm
    applicable: dict[tuple[str, str], list[tuple[float, str, float]]]  # (required mm, source, margin mm)
    tightest: dict[tuple[str, str], tuple[float, str]]  # (required mm, source) of the tightest requirement
    samples: list[PlannedSample]
    requests: list[Any]  # pair_measure.Request
    boxes: int = 0  # occurrence boxes the planner posed


def applicable_requirements(pairs: list[tuple[str, str]], fitted: set[tuple[str, str]],
                            requirements: dict[tuple[str, str], dict[str, Any]], required: float,
                            margins: Any) -> tuple[list[tuple[str, str]], dict[tuple[str, str], list[tuple[float, str, float]]]]:
    """(measured pairs: the checked ones, then the requirement pairs that are not checked; per
    pair its (required mm, source, margin mm) options, the explicit requirement first). `fitted`
    pairs (sorted occurrence ids) are not held to `required` (--min-clearance)."""
    checked = set(pairs)
    measured = [*pairs, *(pair for pair in requirements if pair not in checked)]
    applicable: dict[tuple[str, str], list[tuple[float, str, float]]] = {}
    for pair in measured:
        options = []
        if pair in requirements:
            requirement = requirements[pair]
            options.append((requirement["required_mm"], requirement["source"],
                            margins.for_interface(requirement.get("interface"))))
        if pair in checked and tuple(sorted(pair)) not in fitted:
            options.append((required, "--min-clearance", margins.for_interface(None)))
        applicable[pair] = options
    return measured, applicable


def plan(chain: Any, samples: list[Sample], pairs: list[tuple[str, str]], fitted: set[tuple[str, str]],
         requirements: dict[tuple[str, str], dict[str, Any]], required: float, margins: Any,
         selection: set[tuple[str, str]] | None = None, mode: str = "sample", boxes: Any = None,
         gap: Any = None) -> Plan:
    """The requests of every sample: occurrence b's definition placed by T_a^-1 T_b in the frame of
    a's, composed from the pair's lowest common ancestor (Chain.relative_transforms), for the pairs
    in `selection` (None: every pair). `requirements` (pair_requirements) are measured on their
    pairs at every sample whether or not the pairs are checked. With `boxes` (a
    mesh_bound.MeshAssets) each occurrence's box is posed once per sample and each request
    carries `gap` (mesh_bound.box_gap) of its two boxes; without, pair_measure bounds it itself."""
    checked = set(pairs)
    measured, applicable = applicable_requirements(pairs, fitted, requirements, required, margins)
    clearing = {pair: max((value + margin for value, _, margin in options if value > 0), default=0.0)
                for pair, options in applicable.items()}
    tightest = {pair: max(((value, source) for value, source, _ in options), key=lambda option: option[0])
                for pair, options in applicable.items() if options}
    selected = [index for index, pair in enumerate(measured) if selection is None or pair in selection]
    chosen = [measured[index] for index in selected]
    planned, requests, posed = [], [], 0
    for sample in samples:
        limits = chain.limit_findings(sample.values)
        if limits:
            planned.append(PlannedSample(sample, limits, None, len(requests)))
            continue
        transforms = chain.transforms(sample.values)
        planned.append(PlannedSample(sample, [], transforms, len(requests)))
        if not chosen:
            continue
        posed_boxes = None
        if boxes is not None:
            posed_boxes = boxes.posed_boxes(transforms, chain.pn)
            posed += len(posed_boxes)
        relative = chain.relative_transforms(sample.values, chosen)
        for a, b in chosen:
            requests.append(pair_measure.Request(
                chain.pn(a), chain.pn(b), relative[(a, b)], group=(a, b), sample_id=sample.index, mode=mode,
                box_gap_mm=None if posed_boxes is None else gap(posed_boxes[a], posed_boxes[b]),
                minimum_mm=clearing[(a, b)]))
    return Plan(checked, measured, selected, clearing, applicable, tightest, planned, requests, posed)


def measured_prefix(chain: Any, plan: Plan, outcomes: list[Any], unresolved: set[int] = frozenset()) -> int:
    """How many leading samples the reduction can take: every request answered, and every pruned
    one proved by a request inside them, so it is above the minimum of those samples too (a run
    the deadline stopped measured out of sample order). A kernel failure is an error; a request of
    an unresolved suspect (`unresolved`) is not: the suspect fails the sweep."""
    width = len(plan.selected)
    for index, outcome in enumerate(outcomes):
        if isinstance(outcome, pair_measure.Failure) and index not in unresolved:
            a, b = plan.measured[plan.selected[index % width]]
            raise pose.MotionError(f"{chain.ref(a)} / {chain.ref(b)}: {outcome.message}")
    count, proof = 0, -1  # proof: the last request a pruned request so far relies on
    for taken, planned in enumerate(plan.samples, start=1):
        block = outcomes[planned.start:planned.start + width] if planned.transforms is not None else []
        if None in block:
            break
        proof = max([proof, *(outcome.witness_request for outcome in block if isinstance(outcome, pair_measure.Pruned))])
        if proof < planned.start + len(block):
            count = taken
    return count


# --- sufficient statistics -----------------------------------------------------------------------------------------
#
# A sweep's outcomes reduce, pair by pair and sample by sample, to statistics that the results are computed
# from. Each pair's are its own, and each sample's keep, for the selected pairs only, what a reduction over
# all pairs needs: the collisions, and the closest margin and largest overlap with the pair index that breaks
# their ties. The statistics of disjoint pair selections over the same samples therefore combine into those of
# the whole sweep exactly (combine_statistics), and every result derives from them (finalize).

def _number(value: float) -> float | None:
    """JSON for a bound: inf as null."""
    return None if math.isinf(value) else value


def _bound(value: float | None) -> float:
    return math.inf if value is None else value


def accumulate(plan: Plan, outcomes: list[Any], evaluated: int, allowed: set[tuple[str, str]],
               requirements: dict[tuple[str, str], dict[str, Any]], volume_tol: float,
               effectors: Mapping[int, dict[str, list[float]]], unresolved: set[int] = frozenset()) -> dict[str, Any]:
    """The statistics of the first `evaluated` samples of `plan` from their request `outcomes`:
    {pairs: {pair index: ...}, samples: [...], mesh_cleared: [...]}, JSON-ready. `allowed` holds
    the sorted occurrence pairs whose overlap is declared; `effectors` the end effector's row per
    sample index (Geometry.effector_row); `unresolved` the requests of unresolved suspects, which
    answer nothing."""
    width = len(plan.selected)
    pairs: dict[int, dict[str, Any]] = {index: {"clearance": None, "bound": None, "observed": None}
                                        for index in plan.selected}
    samples, mesh_cleared = [], []
    for planned in plan.samples[:evaluated]:
        sample = planned.sample
        row: dict[str, Any] = {"index": sample.index, "source": sample.source, "settings": sample.settings,
                               "values": sample.values}
        samples.append(row)
        if planned.limits:
            row["limits"] = planned.limits
            continue
        row["effector"] = effectors[sample.index]
        hits, closest, overlap = [], None, None
        for k, index in enumerate(plan.selected):
            request = planned.start + k
            if request in unresolved:
                continue
            outcome = outcomes[request]
            a, b = pair = plan.measured[index]
            stats = pairs[index]
            distance, volume = pair_measure.reading(outcome)
            if isinstance(outcome, pair_measure.Cleared):
                bound = stats["bound"] or {"lower": math.inf, "upper": None, "by": None, "sample": None, "mesh": None}
                stats["bound"] = bound
                bound["upper"] = _number(min(_bound(bound["upper"]), outcome.upper_mm))
                if outcome.lower_mm < bound["lower"]:
                    bound.update(lower=outcome.lower_mm, by=outcome.method, sample=sample.index)
                if outcome.method == "mesh":
                    mesh_cleared.append({"pair": index, "sample": sample.index, "lower": outcome.lower_mm,
                                         "upper": _number(outcome.upper_mm), "mesh_mm": outcome.mesh_mm})
                    if bound["mesh"] is None or outcome.lower_mm < bound["mesh"]["lower"]:
                        bound["mesh"] = {"sample": sample.index, "lower": outcome.lower_mm,
                                         "upper": _number(outcome.upper_mm)}
            if pair in requirements:
                seen = stats["observed"] or {"clearance_mm": None, "overlap_mm3": 0.0, "sample": None, "samples_below": 0}
                stats["observed"] = seen
                seen["samples_below"] += distance < requirements[pair]["required_mm"]
                if (distance, -volume) < (_bound(seen["clearance_mm"]), -seen["overlap_mm3"]):
                    seen.update(clearance_mm=distance, overlap_mm3=volume, sample=sample.index)
            undeclared = 0.0
            if pair in plan.checked:
                best = stats["clearance"]
                if math.isfinite(distance) and (best is None or distance < best["distance"]):
                    stats["clearance"] = {"distance": distance, "sample": sample.index}
                if tuple(sorted(pair)) not in allowed and volume > volume_tol:
                    undeclared = volume
                    hits.append([index, volume])
                    if overlap is None or volume > overlap[0]:
                        overlap = [volume, index]
            limit = plan.tightest.get(pair)
            if limit is not None and math.isfinite(distance):
                key = [distance - limit[0], -undeclared, index, distance]
                if closest is None or key[:3] < closest[:3]:
                    closest = key
        row.update(hits=hits, closest=closest, overlap=overlap)
    return {"schema": RESULT_SCHEMA, "pairs": {str(index): stats for index, stats in pairs.items()},
            "samples": samples, "mesh_cleared": mesh_cleared}


def combine_statistics(parts: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """The statistics of disjoint pair selections over the same samples, as one sweep's: pairs
    united, and per sample the collisions united in pair order, the closest margin and largest
    overlap kept with their pair-order tie-break. Raises ValueError when the selections overlap
    or the sample domains differ."""
    pairs: dict[str, Any] = {}
    for part in parts:
        shared = pairs.keys() & part["pairs"].keys()
        if shared:
            raise ValueError(f"pair {min(shared, key=int)} is in two inputs")
        pairs.update(part["pairs"])
    domains = [[{k: row.get(k) for k in ("index", "source", "settings", "values", "limits", "effector")}
                for row in part["samples"]] for part in parts]
    if any(domain != domains[0] for domain in domains[1:]):
        raise ValueError("the inputs did not evaluate the same samples")
    samples = []
    for rows in zip(*(part["samples"] for part in parts)):
        row = {k: v for k, v in rows[0].items() if k not in ("hits", "closest", "overlap")}
        if "limits" not in row:
            closest = [r["closest"] for r in rows if r["closest"] is not None]
            overlap = [r["overlap"] for r in rows if r["overlap"] is not None]
            row.update(hits=sorted((hit for r in rows for hit in r["hits"]), key=lambda hit: hit[0]),
                       closest=min(closest, key=lambda key: key[:3]) if closest else None,
                       overlap=min(overlap, key=lambda key: (-key[0], key[1])) if overlap else None)
        samples.append(row)
    mesh_cleared = sorted((row for part in parts for row in part["mesh_cleared"]),
                          key=lambda row: (row["sample"], row["pair"]))
    return {"schema": RESULT_SCHEMA, "pairs": pairs, "samples": samples, "mesh_cleared": mesh_cleared}


def sample_of(row: Mapping[str, Any]) -> Sample:
    return Sample(row["index"], row["source"], dict(row["settings"]), dict(row["values"]))


def finalize(chain: Any, plan: Plan, statistics: Mapping[str, Any], reference: tuple[float, float, float],
             criterion: str) -> SweepState:
    """The findings of the samples in `statistics`, the same whichever pair selections they were
    combined from. A pair's margin is its distance minus its tightest applicable requirement; the
    worst sample under `criterion` has the smallest rank, the earliest winning a tie."""
    state = SweepState(evaluated=len(statistics["samples"]))
    by_index = {row["index"]: sample_of(row) for row in statistics["samples"]}

    def refs(index: int) -> list[str]:
        a, b = plan.measured[index]
        return [chain.ref(a), chain.ref(b)]

    for key, stats in statistics["pairs"].items():
        pair = plan.measured[int(key)]
        exact = stats["clearance"]
        if exact is not None:
            sample = by_index[exact["sample"]]
            state.clearance[pair] = {"pair": refs(int(key)), "clearance_mm": exact["distance"],
                                     "pose": rounded(sample.values), "independent_pose": rounded(sample.settings)}
        bound = stats["bound"]
        if bound is not None:
            state.bounds[pair] = {"pair": refs(int(key)), "lower": bound["lower"], "upper": _bound(bound["upper"]),
                                  "by": bound["by"], "sample": by_index[bound["sample"]]}
            if bound["mesh"] is not None:
                state.bounds[pair]["mesh"] = {"ids": pair, "sample": by_index[bound["mesh"]["sample"]],
                                              "lower": bound["mesh"]["lower"], "upper": _bound(bound["mesh"]["upper"])}
        seen = stats["observed"]
        if seen is not None:
            state.pair_clearance[pair] = {"clearance_mm": _bound(seen["clearance_mm"]), "overlap_mm3": seen["overlap_mm3"],
                                          "sample": None if seen["sample"] is None else by_index[seen["sample"]],
                                          "samples_below": seen["samples_below"]}
    for row in statistics["samples"]:
        sample = by_index[row["index"]]
        if "limits" in row:
            state.limits.append({"sample": sample.index, "source": sample.source,
                                 "independent_pose": rounded(sample.settings), "findings": row["limits"]})
            continue
        effector = row["effector"]
        state.envelope_min = [min(m, v) for m, v in zip(state.envelope_min, effector["low"])]
        state.envelope_max = [max(m, v) for m, v in zip(state.envelope_max, effector["high"])]
        hits = row["hits"]
        if hits:
            state.collisions.append({"sample": sample.index, "source": sample.source,
                                     "independent_pose": rounded(sample.settings), "pose": rounded(sample.values),
                                     "pairs": [{"pair": refs(index), "volume_mm3": round(volume, 4)}
                                               for index, volume in hits]})
        largest = row["overlap"][0] if row["overlap"] else 0.0
        if criterion == "max_horizontal_reach":
            if hits:
                continue
            centre = effector["centre"]
            reach = math.hypot(centre[0] - reference[0], centre[1] - reference[1])
            rank, metric, pair = (-reach,), {"reach_mm": round(reach, 3),
                                             "centre_of_mass": [round(v, 4) for v in centre]}, None
        elif criterion == "minimum_clearance":
            if row["closest"] is None:
                continue
            margin, _, index, distance = row["closest"]
            limit = plan.tightest[plan.measured[index]]
            rank = (margin, -largest)
            metric = {"clearance_mm": round(distance, 4), "required_mm": limit[0], "requirement": limit[1],
                      "margin_mm": round(margin, 4), "overlap_mm3": round(largest, 4)}
            pair = refs(index)
        else:  # maximum_interference
            if not hits:
                continue
            rank, metric, pair = (-largest,), {"volume_mm3": round(largest, 4)}, refs(row["overlap"][1])
        if state.worst is None or rank < state.worst["rank"]:
            state.worst = {"sample": sample, "rank": rank, "metric": metric, "pair": pair}
    return state


def neighbours(chain: Any, plan: Plan) -> Any:
    """pair_measure's re-evaluation placements of a suspect request: its pair at its sample with
    every independent joint moved +-REEVALUATE_STEP (deg or mm), couplings derived."""
    places = request_places(plan)

    def shifted(index: int) -> list[tuple[str, Any]]:
        sample, pair = places[index]
        moved = []
        for step in (REEVALUATE_STEP, -REEVALUATE_STEP):
            values = chain.complete({jid: value + step for jid, value in sample.settings.items()})
            moved.append((f"independent {step:+g}", chain.relative_transforms(values, [pair])[pair]))
        return moved

    return shifted


def request_places(plan: Plan) -> dict[int, tuple[Sample, tuple[str, str]]]:
    """Request index -> (its sample, its occurrence pair)."""
    return {planned.start + k: (planned.sample, plan.measured[index]) for planned in plan.samples
            if planned.transforms is not None for k, index in enumerate(plan.selected)}


def suspect_report(chain: Any, plan: Plan, suspects: list[Any]) -> list[dict[str, Any]]:
    """Each measurement its own bounds contradict (pair_measure.Suspect): the kernel's value, which
    answers nothing, the bounds, the requests it was for, its re-evaluations, and whether they
    resolved it (its requests then read as `mesh (exact suspect)` bounds); an unresolved one fails.
    Sorted by sample, then pair order, as every subsystem run of one sweep sorts them."""
    places = request_places(plan)
    order = {pair: index for index, pair in enumerate(plan.measured)}
    rows = []
    for suspect in suspects:
        sample, (a, b) = places[suspect.requests[0]]
        reevaluated = []
        for label, outcome, query in suspect.reevaluated:
            row = {"at": label, **({"error": outcome.message} if isinstance(outcome, pair_measure.Failure)
                                   else {"distance_mm": outcome.distance_mm, "overlap_mm3": outcome.overlap_mm3})}
            if query is not None and query.available:
                row["bound_mm"] = [query.lower_mm, _number(query.upper_mm)]
            reevaluated.append(row)
        rows.append(((sample.index, order[(a, b)]), {
            "pair": [chain.ref(a), chain.ref(b)], "sample": sample.index, "independent_pose": rounded(sample.settings),
            "distance_mm": suspect.distance_mm, "overlap_mm3": suspect.overlap_mm3,
            "bound_mm": [suspect.lower_mm, _number(suspect.upper_mm)],
            "requests": [{"pair": [chain.ref(places[i][1][0]), chain.ref(places[i][1][1])], "sample": places[i][0].index}
                         for i in suspect.requests],
            "reevaluated": sorted(reevaluated, key=lambda row: row["at"]), "resolved": bool(suspect.resolved),
        }))
    return [row for _, row in sorted(rows, key=lambda item: item[0])]


def unresolved_requests(suspects: list[Any]) -> set[int]:
    return {index for suspect in suspects if not suspect.resolved for index in suspect.requests}


def bounded_minimum(exact: float | None, bound: dict[str, Any] | None) -> tuple[float, float] | None:
    """Fast mode: (lower, upper) bounds on a pair's minimum distance when it may lie at a cleared
    request, whose smallest lower bound is not above the exact minimum of the measured ones; None
    when the exact minimum, smaller than every cleared request's distance, stands."""
    if bound is None or (exact is not None and exact < bound["lower"]):
        return None
    return bound["lower"], min(bound["upper"], math.inf if exact is None else exact)


def floor4(value: float) -> float:
    """`value` rounded down to 4 decimals; within 1e-10 mm of a 4-decimal value, that value (2.6 * 1e4
    reads 26000.000000000004)."""
    return math.floor(round(value * 1e4, 6)) / 1e4


def ceil4(value: float) -> float | None:
    """`value` rounded up to 4 decimals as `floor4` rounds down; None for inf."""
    return None if math.isinf(value) else math.ceil(round(value * 1e4, 6)) / 1e4


def bound_fields(bound: dict[str, Any], span: tuple[float, float]) -> dict[str, Any]:
    """A bounded row's own fields: what proved its lower bound, and both bounds outward rounded."""
    return {"method": bound["by"], "bound_mm": [floor4(span[0]), ceil4(span[1])]}


def clearance_report(clearance: dict[tuple[str, str], dict[str, Any]], required: float,
                     fitted: set[tuple[str, str]], bounds: dict[tuple[str, str], dict[str, Any]] | None = None,
                     ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(per-pair minimum clearance smallest first, findings for the pairs below `required` mm).

    A pair's row is its exact minimum (`method` "exact"), or, in fast mode where that minimum may lie
    at a cleared request (`bounds`, SweepState.bounds of the checked pairs), its bounded minimum:
    `clearance_mm` its proved lower bound, `bound_mm` [lower, upper] rounded outward, `method` what
    proved the lower bound. A bounded pair is more than the band clear of `required`, so never a
    finding; nor is a fitted pair (sorted occurrence ids in `fitted`), though it is listed. The
    comparison uses the measured distance; only the output rounds it to 4 decimals.
    """
    bounds = bounds or {}
    entries = []  # (sort key, pair, row, exact minimum or None)
    for pair in [*clearance, *(pair for pair in bounds if pair not in clearance)]:
        exact = clearance.get(pair)
        span = bounded_minimum(exact["clearance_mm"] if exact else None, bounds.get(pair))
        if span is None:
            entries.append((exact["clearance_mm"], pair,
                            {**exact, "clearance_mm": round(exact["clearance_mm"], 4), "method": "exact"},
                            exact["clearance_mm"]))
            continue
        bound = bounds[pair]
        entries.append((span[0], pair, {"pair": bound["pair"], "clearance_mm": floor4(span[0]),
                                        "pose": rounded(bound["sample"].values),
                                        "independent_pose": rounded(bound["sample"].settings),
                                        **bound_fields(bound, span)}, None))
    entries.sort(key=lambda entry: entry[0])
    findings = [{"check": "min_clearance", "pair": row["pair"], "clearance_mm": row["clearance_mm"],
                 "required_mm": required, "pose": row["pose"]}
                for _, pair, row, exact in entries
                if exact is not None and exact < required and tuple(sorted(pair)) not in fitted]
    return [row for _, _, row, _ in entries], findings


def pair_clearance_report(chain: Any, requirements: dict[tuple[str, str], dict[str, Any]],
                          observed: dict[tuple[str, str], dict[str, Any]],
                          bounds: dict[tuple[str, str], dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """One row per requirement, smallest margin first: pair, required_mm, the smallest measured
    clearance_mm with its overlap, sample and pose, samples_below, status, `method` and its source;
    in fast mode a bounded minimum as clearance_report gives it (`bounds`, SweepState.bounds).

    The verdict uses the measured distances; only the output rounds them to 4 decimals. A
    requirement no sample measured (every one a joint_limit finding) fails.
    """
    bounds = bounds or {}
    rows = []
    for (a, b), requirement in requirements.items():
        seen = observed.get((a, b))
        row: dict[str, Any] = {"pair": [chain.ref(a), chain.ref(b)], "required_mm": requirement["required_mm"],
                               "status": "fail", "clearance_mm": None, "overlap_mm3": None, "samples_below": 0,
                               "sample": None, "independent_pose": None, "pose": None}
        margin = -math.inf
        exact = seen["clearance_mm"] if seen is not None and seen["sample"] is not None else None
        span = bounded_minimum(exact, bounds.get((a, b)))
        if span is not None:
            bound, below = bounds[(a, b)], seen["samples_below"] if seen is not None else 0
            sample = bound["sample"]
            margin = span[0] - requirement["required_mm"]
            row.update(status="fail" if below else "pass", clearance_mm=floor4(span[0]), overlap_mm3=0.0,
                       samples_below=below, sample={"index": sample.index, "source": sample.source},
                       independent_pose=rounded(sample.settings), pose=rounded(sample.values),
                       **bound_fields(bound, span))
        elif exact is not None:
            sample = seen["sample"]
            margin = exact - requirement["required_mm"]
            row.update(status="fail" if seen["samples_below"] else "pass", clearance_mm=round(exact, 4),
                       overlap_mm3=round(seen["overlap_mm3"], 4), samples_below=seen["samples_below"],
                       sample={"index": sample.index, "source": sample.source},
                       independent_pose=rounded(sample.settings), pose=rounded(sample.values), method="exact")
        row.update({key: requirement[key] for key in ("interface", "source", "overrides") if key in requirement})
        rows.append((margin, row))
    return [row for _, row in sorted(rows, key=lambda item: item[0])]


def margin_warnings(chain: Any, plan: Plan, state: SweepState) -> list[dict[str, Any]]:
    """A `margin` row for each requirement a pair's exact minimum meets by less than its margin, in
    pair order; none on a pair whose minimum may lie at a cleared request (it clears requirement +
    margin + band), and none on a pair failing any of its requirements, which already fails."""
    rows = []
    for pair in plan.measured:
        options = [(value, source, margin) for value, source, margin in plan.applicable[pair] if value > 0]
        if not options:
            continue
        exact = state.clearance.get(pair, {}).get("clearance_mm")
        observed = state.pair_clearance.get(pair)
        if observed is not None and observed["sample"] is not None:
            exact = observed["clearance_mm"] if exact is None else min(exact, observed["clearance_mm"])
        if exact is None or bounded_minimum(exact, state.bounds.get(pair)) is not None:
            continue
        if any(exact < value for value, _, _ in options):
            continue
        for value, source, margin in options:
            if exact < value + margin:
                rows.append({"check": "margin", "severity": "warning", "pair": [chain.ref(pair[0]), chain.ref(pair[1])],
                             "clearance_mm": round(exact, 4), "required_mm": value, "margin_mm": margin,
                             "source": source,
                             "message": f"{round(exact, 4)} mm meets {value} mm by less than its {margin} mm margin"})
    return rows


def pair_requirements(chain: Any, declared: list[dict[str, Any]],
                      options: list[str]) -> dict[tuple[str, str], dict[str, Any]]:
    """Clearance requirements keyed by occurrence pair in chain order, as {required_mm, source[,
    interface][, overrides]}: the record's (pair_policy.declared_clearances), then each `--pair-clearance
    REF:REF=MM`, which adds a requirement for this run or overrides the one already on that pair (an
    override keeps the record interface, whose margin it inherits)."""
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
                                       **({"overrides": previous["source"], "interface": previous["interface"]}
                                          if previous else {})}
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


def load_margins(record_hw: Path) -> Any:
    try:
        return design_rules.load_clearance_margins(record_hw)
    except (ValueError, KeyError) as error:
        raise pose.MotionError(f"clearance margins: {error}") from error


# --- the run ---------------------------------------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
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
    parser.add_argument("--time-limit", type=float, default=600.0,
                        help="seconds for every phase together before the sweep stops as incomplete")
    parser.add_argument("--jobs", type=pair_measure.jobs_argument, default="1", metavar="N|auto",
                        help=f"worker processes measuring pairs (1, the default: this process, on OCCT's thread "
                             f"pool; auto: the CPU count, at most {pair_measure.AUTO_JOBS_MAX})")
    caching = parser.add_mutually_exclusive_group()
    caching.add_argument("--cache", type=Path, metavar="DIR",
                         help="pair cache directory (default: hw/.cad, the file pairs-v2.sqlite)")
    caching.add_argument("--no-cache", action="store_true", help="measure every pair, reading and writing no cache")
    filtering = parser.add_mutually_exclusive_group()
    filtering.add_argument("--exact", action="store_true",
                           help="measure every request that could set a pair's minimum: no band, no mesh clearing")
    filtering.add_argument("--mesh-band", type=float, default=DEFAULT_BAND_MM, metavar="MM",
                           help=f"fast mode: leave unmeasured a request whose proved lower bound is more than MM "
                                f"beyond 1e-6 mm and its pair's clearing threshold (default {DEFAULT_BAND_MM})")
    auditing = parser.add_mutually_exclusive_group()
    auditing.add_argument("--spot-check", dest="spot_check", action="store_true", default=True,
                          help="fast mode (the default): measure each pair's closest mesh-cleared request exactly")
    auditing.add_argument("--no-spot-check", dest="spot_check", action="store_false", help="skip the spot check")
    parser.add_argument("--subsystem", action="append", default=[], metavar="NAME",
                        help="measure only the pairs this subassembly owns, or interface or static (repeatable)")
    parser.add_argument("--no-continuous", dest="continuous", action="store_false",
                        help="skip the between-sample check: the sampled poses only")
    parser.add_argument("--continuous-grid-deg", type=float, default=continuous.GRID_DEG, metavar="DEG",
                        help=f"between-sample check: fine rate cells of a revolute path (default {continuous.GRID_DEG})")
    parser.add_argument("--continuous-grid-mm", type=float, default=continuous.GRID_MM, metavar="MM",
                        help=f"between-sample check: fine rate cells of a prismatic path (default {continuous.GRID_MM})")
    parser.add_argument("--continuous-safety", type=float, default=continuous.SAFETY, metavar="FACTOR",
                        help=f"between-sample check: factor over the sampled rate, >= 1 (default {continuous.SAFETY})")
    parser.add_argument("--continuous-depth", type=int, default=continuous.MAX_DEPTH, metavar="N",
                        help=f"between-sample check: bisections per sample interval, 0..{continuous.MAX_DEPTH} "
                             f"(default {continuous.MAX_DEPTH})")
    parser.add_argument("--smoke", action="store_true",
                        help="sample each revolute every 60 degrees and at its TDC and dwell events only: an early "
                             "check that never replaces the full sweep (no between-sample check)")
    parser.add_argument("--changed-only", action="store_true",
                        help="versioned: measure only the pairs whose geometry, placement, policy or motion "
                             "changed since the baseline; partial evidence")
    parser.add_argument("--since-version", metavar="vN",
                        help="--changed-only baseline (default: the newest built version before this one)")
    parser.add_argument("--worst-step", type=Path, help="STEP path for scratch; versioned sweeps publish to hw/motion")
    return parser


def usage_problem(args: argparse.Namespace) -> str | None:
    if args.steps < 2 or args.grid == 1 or args.grid < 0:
        return "--steps must be >= 2, and --grid 0 or >= 2"
    if not (math.isfinite(args.mesh_band) and args.mesh_band > 0):
        return "--mesh-band must be a finite number > 0"
    if not (math.isfinite(args.time_limit) and args.time_limit > 0):
        return "--time-limit must be a finite number > 0"
    for option, value in (("--continuous-grid-deg", args.continuous_grid_deg),
                          ("--continuous-grid-mm", args.continuous_grid_mm)):
        if not (math.isfinite(value) and value > 0):
            return f"{option} must be a finite number > 0"
    if not (math.isfinite(args.continuous_safety) and args.continuous_safety >= 1):
        return "--continuous-safety must be a finite number >= 1"
    if not 0 <= args.continuous_depth <= continuous.MAX_DEPTH:
        return f"--continuous-depth must be 0..{continuous.MAX_DEPTH}"
    if args.changed_only and not args.version:
        return "--changed-only compares built versions; it needs --version"
    if args.since_version and not args.changed_only:
        return "--since-version names the baseline of --changed-only"
    return None


def spot_checking(args: argparse.Namespace) -> bool:
    return bool(args.spot_check and not args.exact)


def continuous_settings(args: argparse.Namespace) -> dict[str, Any] | None:
    """The between-sample check's settings, or None when it is off (--no-continuous, --smoke)."""
    if not args.continuous or args.smoke:
        return None
    return {"grid_deg": args.continuous_grid_deg, "grid_mm": args.continuous_grid_mm,
            "safety": args.continuous_safety, "depth": args.continuous_depth}


def recipe_options(args: argparse.Namespace, baseline: str | None = None) -> dict[str, Any]:
    """The options that decide a sweep's result; jobs, cache, output and time limit do not."""
    return {"steps": args.steps, "grid": args.grid, "worst_criterion": args.worst_criterion,
            "end_effector": args.end_effector, "include_pair": list(args.include_pair),
            "min_clearance": args.min_clearance, "pair_clearance": list(args.pair_clearance),
            "volume_tol": args.volume_tol, "max_poses": args.max_poses, "exact": args.exact,
            "mesh_band": None if args.exact else args.mesh_band, "spot_check": spot_checking(args),
            "continuous": continuous_settings(args), "smoke": args.smoke,
            "changed_only": {"baseline": baseline} if args.changed_only else None}


def option_argv(options: Mapping[str, Any], attach: Sequence[str]) -> list[str]:
    """Command-line options that parse back into `options` (recipe_options) and `attach`."""
    argv = ["--steps", str(options["steps"]), "--grid", str(options["grid"]),
            "--worst-criterion", options["worst_criterion"], "--min-clearance", repr(options["min_clearance"]),
            "--volume-tol", repr(options["volume_tol"]), "--max-poses", str(options["max_poses"])]
    if options["end_effector"]:
        argv += ["--end-effector", options["end_effector"]]
    for spec in options["include_pair"]:
        argv += ["--include-pair", spec]
    for spec in options["pair_clearance"]:
        argv += ["--pair-clearance", spec]
    argv += ["--exact"] if options["exact"] else ["--mesh-band", repr(options["mesh_band"])]
    argv += ["--spot-check"] if options["spot_check"] else ["--no-spot-check"]
    settings = options["continuous"]
    if settings is None:
        argv += ["--no-continuous"]
    else:
        argv += ["--continuous-grid-deg", repr(settings["grid_deg"]), "--continuous-grid-mm", repr(settings["grid_mm"]),
                 "--continuous-safety", repr(settings["safety"]), "--continuous-depth", str(settings["depth"])]
    if options["smoke"]:
        argv += ["--smoke"]
    if options["changed_only"] is not None:
        argv += ["--changed-only"]
        if options["changed_only"]["baseline"]:
            argv += ["--since-version", options["changed_only"]["baseline"]]
    for spec in attach:
        argv += ["--attach", spec]
    return argv


def producer_hashes() -> dict[str, str]:
    return {path.name: sha256(path) for path in PRODUCERS}


def recipe_of(run: Run, rule: Any) -> dict[str, Any]:
    """The published bundle's recipe: what a reuse must match, the producing code and the measuring
    rule included, so a result of other code is never returned for this one."""
    args = run.args
    baseline = run.change.baseline if run.change is not None else None
    return {"operation": "sweep", "case": args.case, "options": recipe_options(args, baseline),
            "attach": list(args.attach), "subsystem": sorted(args.subsystem) or None,
            "inputs_sha256": pose.input_sha256(run.version_dir), "rule_sha256": rule.digest.hex(),
            "producers": producer_hashes()}


def equivalence_of(recipe: Mapping[str, Any]) -> dict[str, Any]:
    """The recipe without its case and pair selection: equal for every subsystem run of one sweep."""
    return {key: value for key, value in recipe.items() if key not in ("case", "subsystem")}


@dataclass
class Run:
    """One sweep's inputs, loaded once: the chain, its pairs and policies, the partition, the
    samples and the paths between them."""

    args: argparse.Namespace
    version: str | None
    version_dir: Path | None
    record_hw: Path
    assembly: Any
    chain: Any
    definitions: dict[str, Any]
    pairs: list[tuple[str, str]]
    excluded: list[tuple[str, str]]
    allowed: set[tuple[str, str]]
    fitted: set[tuple[str, str]]
    requirements: dict[tuple[str, str], dict[str, Any]]
    margins: Any
    effector: str
    path: list[Any]
    samples: list[Sample]
    paths: list[Any]  # continuous.SweepPath
    partition: Any  # subsystems.PairPartition, or None with `partition_problems`
    partition_problems: list[str]
    selection: set[tuple[str, str]] | None
    smoke: Any = None  # incremental.SmokePlan of a --smoke run
    change: Any = None  # incremental.PairSelection of a --changed-only run

    @property
    def complete_scope(self) -> bool:
        """Whether the run covers every pair over the whole sample domain."""
        return self.selection is None and self.smoke is None and self.change is None


def prepare(args: argparse.Namespace, version: str | None, version_dir: Path | None, record_hw: Path) -> Run:
    """Load the inputs, check them, and resolve the pair selection; raises MotionError."""
    assembly, chain, definitions = pose.load_inputs(args)
    if not chain.independent:
        raise pose.MotionError("the chain has no independent movable joint to sweep")
    if not args.smoke:
        bound = pose_count_bound(chain, args.steps, args.grid)
        if bound > args.max_poses:
            raise pose.MotionError(f"{bound} poses exceed --max-poses {args.max_poses}; lower --steps or --grid")
    pairs, excluded = pairs_to_check(chain, args.include_pair)
    allowed, fitted, declared = declared_policy(record_hw, assembly)
    requirements = pair_requirements(chain, declared, args.pair_clearance)
    margins = load_margins(record_hw)
    effector = end_effector(chain, args.end_effector)
    path = [joint for joint in chain.path(effector) if joint.movable]
    if not path:
        raise pose.MotionError(f"no movable joint moves the end effector {chain.ref(effector)}")
    measured, _ = applicable_requirements(pairs, fitted, requirements, args.min_clearance, margins)
    split, problems, selection = None, [], None
    try:
        split = subsystems.partition(chain, assembly.groups, measured)
    except subsystems.SubsystemError as error:
        problems = error.problems
    if args.subsystem:
        if split is None:
            raise pose.MotionError("--subsystem needs subassemblies that partition the moving occurrences: "
                                   + "; ".join(problems))
        try:
            selection = split.select(args.subsystem)
        except subsystems.SubsystemError as error:
            raise pose.MotionError("; ".join(error.problems)) from None
    change = None
    if args.changed_only:
        change = incremental.compare_versions(args.hw, version, args.since_version).select(measured, moving=True)
        changed = {pair for pair in measured if tuple(sorted(pair)) in change.selected}
        selection = changed if selection is None else selection & changed
    smoke = incremental.smoke_samples(chain) if args.smoke else None
    samples = smoke_poses(chain, smoke) if smoke is not None else generate_poses(chain, args.steps, args.grid)
    paths = [] if smoke is not None else sweep_paths(chain, samples, args.steps, args.grid)
    used = {pn: definitions[pn] for pn in {chain.pn(oid) for oid in chain.ids}}
    return Run(args, version, version_dir, record_hw, assembly, chain, used, pairs, excluded, allowed, fitted,
               requirements, margins, effector, path, samples, paths, split, problems, selection, smoke, change)


def detect_periods(run: Run) -> dict[str, dict[str, Any]]:
    """PeriodEvidence (as JSON) per subassembly per independent joint, the others at nominal, on the
    between-sample check's grid."""
    if run.partition is None or not run.partition.members:
        return {}
    chain, args = run.chain, run.args
    grid = {"deg": args.continuous_grid_deg, "mm": args.continuous_grid_mm}
    nominal = {joint.id: joint.nominal for joint in chain.independent}
    found: dict[str, dict[str, Any]] = {name: {} for name in run.partition.members}
    for joint in chain.independent:
        def at(value: float, joint: Any = joint) -> Mapping[str, Any]:
            return chain.transforms(chain.complete({**nominal, joint.id: value}))

        evidence = subsystems.detect_periods(joint, joint.min, joint.max, run.partition.members, at, grid[joint.unit])
        for name, item in evidence.items():
            found[name][joint.id] = item.as_json()
    return found


def prove_continuous(run: Run, plan: Plan, outcomes: list[Any], session: Any, assets: Any, gap: Any,
                     deadline: float) -> dict[str, Any]:
    """The between-sample check (continuous.prove_between) of the selected pairs along the sweep's
    paths: endpoint readings are the sampled outcomes, rates come from the definitions' mesh
    envelopes, and midpoints are measured in pair_measure's bound mode in `session`. Pairs and
    findings are named by their references."""
    args, chain = run.args, run.chain
    if continuous_settings(args) is None:
        return continuous.disabled().as_json()
    if assets is None:
        return {**continuous.disabled().as_json(), "reason": "mesh bounds unavailable: no envelope bounds the motion"}
    ref_of = {oid: chain.ref(oid) for oid in chain.ids}
    oid_of = {ref: oid for oid, ref in ref_of.items()}
    adjacent = chain.adjacent_pairs()
    specs = []
    for index in plan.selected:
        a, b = pair = plan.measured[index]
        minimum = max((value for value, _, _ in plan.applicable[pair] if value > 0), default=0.0)
        specs.append(continuous.PairSpec((ref_of[a], ref_of[b]), (chain.pn(a), chain.pn(b)), minimum,
                                         contact_declared=tuple(sorted(pair)) in run.fitted or frozenset(pair) in adjacent,
                                         overlap_allowed=tuple(sorted(pair)) in run.allowed))
    starts = {item.sample.index: item.start for item in plan.samples if item.transforms is not None}
    paths = [dataclasses.replace(path, sample_ids=tuple(s if s in starts else None for s in path.sample_ids))
             for path in run.paths]
    endpoint = {(path.id, spec.ids, sample): outcomes[starts[sample] + k]
                for path in paths for sample in path.sample_ids if sample is not None
                for k, spec in enumerate(specs)}
    envelopes = assets.posed_boxes({ref: pose.Rigid.identity() for ref in oid_of}, lambda ref: chain.pn(oid_of[ref]))
    breakpoints = incremental.breakpoints(chain)
    grid = {"deg": args.continuous_grid_deg, "mm": args.continuous_grid_mm}

    def placements(path: Any) -> Any:
        def at(coordinate: float) -> dict[str, Any] | None:
            values = chain.complete(path.settings(coordinate))
            if chain.limit_findings(values):
                return None
            return {ref_of[oid]: rigid for oid, rigid in chain.transforms(values).items()}
        return at

    rates = {path.id: continuous.sample_rates(path, at=placements(path), boxes=envelopes, pairs=specs,
                                              grid=grid[path.unit], safety=args.continuous_safety,
                                              breakpoints=breakpoints.get(path.driver_joint, ()))
             for path in paths}

    def evaluate(batch: Sequence[Any]) -> dict[int, Any]:
        poses: dict[tuple[str, float], Any] = {}
        requests, ids = [], []
        for item in batch:
            key = (item.path.id, item.coordinate)
            if key not in poses:
                values = chain.complete(item.settings)
                poses[key] = None if chain.limit_findings(values) else (values, chain.transforms(values))
            if poses[key] is None:
                continue  # a midpoint outside a joint's limits: left uncovered
            values, transforms = poses[key]
            a, b = oid_of[item.pair.ids[0]], oid_of[item.pair.ids[1]]
            boxes = assets.posed_boxes({a: transforms[a], b: transforms[b]}, chain.pn)
            requests.append(pair_measure.Request(
                chain.pn(a), chain.pn(b), chain.relative_transforms(values, [(a, b)])[(a, b)],
                sample_id=f"{item.path.id}@{item.coordinate!r}", mode="bound", box_gap_mm=gap(boxes[a], boxes[b]),
                minimum_mm=item.pair.minimum_mm))
            ids.append(item.id)
        return dict(zip(ids, session.measure(requests, deadline=deadline)))

    return continuous.prove_between(paths, pairs=specs, endpoint=endpoint, rates=rates, evaluate_midpoints=evaluate,
                                    volume_tol=args.volume_tol, max_depth=args.continuous_depth, deadline=deadline,
                                    complete=chain.complete).as_json()


def subsystem_report(run: Run, periods: dict[str, dict[str, Any]], state: SweepState,
                     findings: list[dict[str, Any]], requirement_rows: list[dict[str, Any]],
                     warnings: list[dict[str, Any]], between: Mapping[str, Any]) -> dict[str, Any]:
    """Per owner: members, pair count, whether this run measured it, its findings, its
    between-sample findings and unproved intervals, and its periods."""
    if run.partition is None:
        return {"valid": False, "problems": run.partition_problems, "selected": None}
    chain = run.chain
    owner_of = {tuple(chain.ref(oid) for oid in pair): owner for pair, owner in run.partition.pair_owner.items()}

    def count(rows: Sequence[Mapping[str, Any]], owner: str) -> int:
        return sum(1 for row in rows if owner_of.get(tuple(row["pair"])) == owner)

    colliding = {tuple(item["pair"]) for collision in state.collisions for item in collision["pairs"]}
    failing = [row for row in requirement_rows if row["status"] == "fail"]
    owners = []
    for owner in run.partition.owners:
        owned = [pair for pair, name in run.partition.pair_owner.items() if name == owner]
        row = {"name": owner, "pairs": len(owned),
               "measured": run.selection is None or all(pair in run.selection for pair in owned),
               "colliding_pairs": sum(1 for pair in colliding if owner_of.get(pair) == owner),
               "clearance_findings": count(findings, owner), "requirement_failures": count(failing, owner),
               "margin_warnings": count(warnings, owner),
               "between_sample_findings": count(between.get("between_sample_findings", []), owner),
               "unproved_intervals": count(between.get("collision_free_unproved_intervals", []), owner)}
        if owner in run.partition.members:
            row["members"] = [chain.ref(oid) for oid in run.partition.members[owner]]
            row["period"] = periods.get(owner, {})
        owners.append(row)
    return {"valid": True, "selected": sorted(run.args.subsystem) or None, "partition_sha256": run.partition.digest(),
            "owners": owners}


def provenance(run: Run, plan: Plan, recipe: Mapping[str, Any], complete: bool, rule: Any) -> dict[str, Any]:
    """evidence/partition.json: what a merge must find equal across its inputs, and what this run covered."""
    equivalence = equivalence_of(recipe)
    return {"schema": RESULT_SCHEMA, "rule_sha256": rule.digest.hex(), "rule": rule.as_json(),
            "partition_sha256": None if run.partition is None else run.partition.digest(),
            "source_version_manifest_sha256": recipe["inputs_sha256"],
            "equivalence": equivalence, "equivalence_sha256": pose.LAYOUT.recipe_sha256(equivalence),
            "argv": option_argv(recipe["options"], recipe["attach"]),
            "subsystem_filter": recipe["subsystem"],
            "all_pair_ids": [subsystems.pair_id(pair) for pair in plan.measured],
            "pair_ids": [subsystems.pair_id(plan.measured[index]) for index in plan.selected],
            "coverage": {"complete": complete, "full_domain": run.smoke is None and run.change is None,
                         "samples_planned": len(plan.samples)}}


def write_statistics(folder: Path, statistics: Mapping[str, Any], partition: Mapping[str, Any],
                     audit: Mapping[str, Any] | None) -> None:
    """The untruncated evidence a merge or an audit reads, under `folder` (the bundle's evidence/)."""
    folder.mkdir(parents=True, exist_ok=True)

    def dump(name: str, value: Any) -> None:
        (folder / name).write_text(json.dumps(value, indent=1, allow_nan=False) + "\n", encoding="utf-8")

    dump("partition.json", partition)
    dump("pair-results.json", {"schema": RESULT_SCHEMA, "pairs": statistics["pairs"]})
    dump("sample-results.json", {"schema": RESULT_SCHEMA, "samples": statistics["samples"]})
    with (folder / "mesh-cleared.jsonl").open("w", encoding="utf-8") as stream:
        for row in statistics["mesh_cleared"]:
            stream.write(json.dumps(row, allow_nan=False) + "\n")
    dump("spot-check.json", audit or {"checks": [], "failures": []})


def read_statistics(folder: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """(statistics, partition provenance, spot-check audit) from a bundle's evidence/ folder."""
    def load(name: str) -> Any:
        return json.loads((folder / name).read_text(encoding="utf-8"))

    pairs, samples = load("pair-results.json"), load("sample-results.json")
    lines = (folder / "mesh-cleared.jsonl").read_text(encoding="utf-8").splitlines()
    statistics = {"schema": samples["schema"], "pairs": pairs["pairs"], "samples": samples["samples"],
                  "mesh_cleared": [json.loads(line) for line in lines if line.strip()]}
    return statistics, load("partition.json"), load("spot-check.json")


def scope_of(run: Run, complete: bool) -> dict[str, Any]:
    """What the run covers: `complete` only for every pair over the whole sample domain."""
    scope: dict[str, Any] = {"kind": "whole", "complete": complete and run.complete_scope}
    if run.selection is not None and run.args.subsystem:
        scope.update(kind="subsystems", subsystems=sorted(run.args.subsystem))
    if run.change is not None:
        scope.update(kind="changed_pairs", changed_pairs=run.change.scope())
    if run.smoke is not None:
        scope.update(kind="smoke", smoke=run.smoke.coverage())
    return scope


def report(run: Run, plan: Plan, statistics: Mapping[str, Any], *, broad_phase: Mapping[str, Any],
           suspects: list[dict[str, Any]], audit: Mapping[str, Any] | None, between: Mapping[str, Any] | None,
           complete: bool, periods: dict[str, dict[str, Any]], timings: dict[str, Any]) -> tuple[dict[str, Any], SweepState]:
    """(result JSON without the worst case's files, the reduced state). `status` fails on any
    sampled or between-sample finding, and is incomplete when the samples were not all measured or
    an interval between them is not proved collision-free."""
    args, chain = run.args, run.chain
    state = finalize(chain, plan, statistics, run.path[0].origin, args.worst_criterion)
    measured_pairs = {plan.measured[index] for index in plan.selected}
    checked = [pair for pair in run.pairs if pair in measured_pairs]
    clearance, findings = clearance_report({p: row for p, row in state.clearance.items() if p in plan.checked},
                                           args.min_clearance, run.fitted,
                                           {pair: bound for pair, bound in state.bounds.items() if pair in plan.checked})
    requirements = {pair: item for pair, item in run.requirements.items() if pair in measured_pairs}
    requirement_rows = pair_clearance_report(chain, requirements, state.pair_clearance, state.bounds)
    warnings = margin_warnings(chain, plan, state)
    between = between if between is not None else continuous.disabled().as_json()
    failures = audit["failures"] if audit is not None else []
    failed = bool(state.collisions or findings or state.limits or any(row["status"] == "fail" for row in requirement_rows)
                  or any(not row["resolved"] for row in suspects) or failures or between["status"] == "finding")
    status = ("incomplete" if not complete else "fail" if failed
              else "incomplete" if between["status"] == "unproved" else "pass")
    refs = [[chain.ref(a), chain.ref(b)] for a, b in checked]
    result: dict[str, Any] = {
        "status": status, "scope": scope_of(run, complete),
        "poses": {"evaluated": state.evaluated, "planned": len(run.samples), "steps_per_joint": args.steps,
                  "grid_per_joint": args.grid, "movable_joints": [joint.id for joint in chain.movable],
                  "independent_joints": [joint.id for joint in chain.independent],
                  "dependent_joints": [joint.id for joint in chain.dependent],
                  "spacing": {joint.id: (joint.max - joint.min) / (args.steps - 1) for joint in chain.independent}},
        "pairs": {"checked": refs, "excluded_adjacent": [[chain.ref(a), chain.ref(b)] for a, b in run.excluded],
                  "declared_overlap": [[chain.ref(a), chain.ref(b)] for a, b in checked if tuple(sorted((a, b))) in run.allowed],
                  "declared_fit": [[chain.ref(a), chain.ref(b)] for a, b in checked if tuple(sorted((a, b))) in run.fitted]},
        "occurrences": {oid: chain.pn(oid) for oid in chain.ids},
        "collision_pose_count": len(state.collisions), "collisions": state.collisions[:MAX_LISTED],
        "limit_pose_count": len(state.limits), "limit_findings": state.limits[:MAX_LISTED],
        "min_clearance": clearance, "clearance_findings": findings, "pair_clearance": requirement_rows,
        "warnings": warnings,
        "reach_envelope": {"part": chain.ref(run.effector), "min": [round(v, 3) for v in state.envelope_min],
                           "max": [round(v, 3) for v in state.envelope_max], "units": "mm"},
        "worst_case": None, "broad_phase": dict(broad_phase), "suspect_measurements": suspects,
        "spot_check": None if audit is None else spot_check.summary(audit),
        "continuous": dict(between),
        "subsystems": subsystem_report(run, periods, state, findings, requirement_rows, warnings, between),
        "timings_s": timings,
    }
    return result, state


def exit_code(status: str) -> int:
    return {"pass": 0, "fail": 1}.get(status, 2)


def export_worst(run: Run, state: SweepState, result: dict[str, Any], stage: Path | None) -> None:
    """Write the worst pose's STEP and evidence (into `stage` for a versioned run) and fill
    `result["worst_case"]`; a sweep with no worst pose says why."""
    args, chain = run.args, run.chain
    description = {"criterion": args.worst_criterion, "definition": CRITERIA[args.worst_criterion].format(
        joint=run.path[0].id, effector=chain.ref(run.effector), required=args.min_clearance, volume_tol=args.volume_tol)}
    if state.worst is None:
        result["worst_case"] = {**description, "found": False,
                                "reason": NO_WORST[args.worst_criterion].format(volume_tol=args.volume_tol)}
        return
    sample = state.worst["sample"]
    worst_step = stage / "worst.step" if stage else args.worst_step
    args.worst_step = (pose.LAYOUT.bundle_dir(args.hw, "motion", run.version, args.case) / "worst.step"
                       if run.version else worst_step)
    pose.write_posed(worst_step, run.record_hw, chain, run.definitions, sample.values)
    digest = sha256(worst_step)
    write_evidence(args, chain, run.definitions, state.worst, description, digest,
                   (stage / "worst.step.json") if stage else evidence_path_for(worst_step), run.record_hw)
    result["worst_case"] = {**description, "found": True, **state.worst["metric"], "pair": state.worst["pair"],
                            "sample": sample.index, "source": sample.source,
                            "independent_pose": rounded(sample.settings), "pose": rounded(sample.values),
                            "step": str(args.worst_step), "step_sha256": digest,
                            "evidence": str(evidence_path_for(args.worst_step)),
                            "command": pose_command(args, sample.settings)}


def publish(run: Run, result: dict[str, Any], state: SweepState, recipe: Mapping[str, Any] | None,
            evidence: tuple[Mapping[str, Any], Mapping[str, Any], Mapping[str, Any] | None] | None,
            publishable: bool, producer: str = "cad-motion sweep.py") -> None:
    """Export the worst case and, for a versioned run, seal the bundle with its evidence/ statistics.
    A run the deadline cut short (`publishable` false) exports and publishes nothing."""
    args = run.args
    if not publishable:
        if run.version:
            raise pose.MotionError(f"sweep incomplete at --time-limit {args.time_limit} s; no bundle published "
                                   f"({state.evaluated}/{len(run.samples)} poses measured)")
        return
    if run.version is None:
        export_worst(run, state, result, None)
        return
    stage = pose.LAYOUT.staging(args.hw, "bundle.motion")
    try:
        export_worst(run, state, result, stage)
        if evidence is not None:
            write_statistics(stage / "evidence", *evidence)
        (stage / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        published = pose.LAYOUT.publish(args.hw, "bundle.motion", {"V": run.version, "S": args.case}, stage,
                                        recipe=dict(recipe or {}), producer=producer, status=result["status"],
                                        replace=args.replace)
        result["bundle"] = str(published.path)
        result["reused"] = published.reused
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def counters_of(measurer: Any) -> dict[str, Any]:
    """pair_measure.Counters as timings_s counters: operational, never part of a result's meaning."""
    counters = measurer.counters
    return {"pair_requests": counters.requested, "kernel_evaluations": counters.kernel_evaluations,
            "fcl_queries": counters.fcl_queries, "exact_hits": counters.exact_hits,
            "decision_hits": counters.decision_hits, "bucket_hits": counters.bucket_hits,
            "reused": counters.reused, "pruned": counters.pruned,
            "cleared_box": counters.cleared["box"], "cleared_mesh": counters.cleared["mesh"],
            "cleared_cache_bound": counters.cleared["cache-bound"], "reevaluations": counters.reevaluations,
            "committed_chunks": counters.committed_chunks, "mesh_s": round(counters.mesh_seconds, 2),
            "parent_s": round(counters.parent_seconds, 2)}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    problem = usage_problem(args)
    if problem:
        print(f"sweep: {problem}", file=sys.stderr)
        return 2
    started = time.monotonic()
    try:
        version, record_hw, version_dir = None, args.hw, None
        if args.version:
            version, version_dir, record_hw = pose.LAYOUT.built_version(args.hw, args.version)
            args.version, args.version_dir, args.record_hw = version, version_dir, record_hw
            pose.LAYOUT.resolve(args.hw, "bundle.motion", V=version, S=args.case)
        else:
            if args.worst_step is None:
                raise pose.MotionError("--worst-step is required for scratch geometry")
            args.worst_step = pose.LAYOUT.scratch_path(args.hw, args.worst_step, "--worst-step")
            if args.worst_step.exists() or evidence_path_for(args.worst_step).exists():
                raise pose.MotionError(f"--worst-step or its evidence already exists; refusing to overwrite: {args.worst_step}")
        guard = claim_run(args.hw)
        try:
            return sweep_run(args, version, version_dir, record_hw, started)
        finally:
            if guard is not None:
                guard.release()
    except (pose.MotionError, OSError, pose.LAYOUT.LayoutError, pose.LAYOUT.PublishConflict) as error:
        print(f"sweep: {error}", file=sys.stderr)
        return 2


def sweep_run(args: argparse.Namespace, version: str | None, version_dir: Path | None, record_hw: Path,
              started: float) -> int:
    run = prepare(args, version, version_dir, record_hw)
    chain = run.chain
    shapes = {pn: part.shape for pn, part in run.definitions.items()}
    mesh_module, mesh, description = mesh_bounds(shapes)
    rule = pair_measure.RuleVersion.current(mesh, args.mesh_band)
    recipe = recipe_of(run, rule) if version else None
    if version:
        reused = pose.LAYOUT.reusable(args.hw, "bundle.motion", {"V": version, "S": args.case}, recipe,
                                      replace=args.replace)
        if reused is not None:
            result = json.loads((reused / "result.json").read_text(encoding="utf-8"))
            result.update(bundle=str(reused), reused=True)
            print(json.dumps(result, indent=2))
            return exit_code(result.get("status", "incomplete"))
    broad_phase = ({"mode": "exact", "mesh": description} if args.exact
                   else {"mode": "fast", "band_mm": args.mesh_band, "mesh": description})
    cache = None if args.no_cache else pair_measure.PairCache(args.cache or pair_measure.default_cache_dir(args.hw))
    geometry = Geometry(chain, run.definitions, run.effector)
    measurer = pair_measure.PairMeasurer(shapes, geometry_ids=pose.geometry_ids(run.definitions), rule=rule,
                                         jobs=args.jobs, cache=cache, mesh=mesh)
    loaded = time.monotonic()
    deadline = loaded + args.time_limit  # one deadline for every phase
    gap = mesh_module.box_gap if mesh_module is not None else None
    between, audit = None, None
    try:
        assets = mesh.prepare(sorted(shapes)) if mesh is not None else None
        planned = plan(chain, run.samples, run.pairs, run.fitted, run.requirements, args.min_clearance, run.margins,
                       run.selection, "exact" if args.exact else "sample", assets, gap)
        planned_at = time.monotonic()
        with measurer.session(assets) as session:
            outcomes = session.measure(planned.requests, deadline=deadline, prune=True,
                                       neighbours=neighbours(chain, planned))
            found = list(session.suspects)
            unresolved = unresolved_requests(found)
            evaluated = measured_prefix(chain, planned, outcomes, unresolved)
            effectors = {item.sample.index: geometry.effector_row(item.transforms[run.effector])
                         for item in planned.samples[:evaluated] if item.transforms is not None}
            statistics = accumulate(planned, outcomes, evaluated, run.allowed, run.requirements, args.volume_tol,
                                    effectors, unresolved)
            swept = time.monotonic()
            complete = evaluated == len(run.samples)
            suspects = suspect_report(chain, planned, found)
            if complete:
                between = prove_continuous(run, planned, outcomes, session, assets, gap, deadline)
            proved = time.monotonic()
            if complete and spot_checking(args) and mesh is not None:
                audit = spot_check.per_pair(chain, planned, statistics, session, mesh, args.mesh_band,
                                            mesh_module.LINEAR_DEFLECTION_MM, deadline)
        counters = counters_of(measurer)
    finally:
        if cache is not None:
            cache.close()
    checking = time.monotonic()
    publishable = complete and checking <= deadline
    periods = detect_periods(run) if publishable and run.smoke is None else {}
    timings = {"load": round(loaded - started, 2), "plan": round(planned_at - loaded, 2),
               "sweep": round(swept - planned_at, 2), "continuous": round(proved - swept, 2),
               "spot_check": round(checking - proved, 2), "periods": round(time.monotonic() - checking, 2),
               "export": 0.0, "total": 0.0,
               "per_pose_ms": round((swept - loaded) / evaluated * 1000, 1) if evaluated else 0.0,
               "planned_requests": len(planned.requests), "posed_boxes": planned.boxes, **counters}
    result, state = report(run, planned, statistics, broad_phase=broad_phase, suspects=suspects, audit=audit,
                           between=between, complete=publishable, periods=periods, timings=timings)
    exporting = time.monotonic()
    evidence = (statistics, provenance(run, planned, recipe, publishable, rule), audit) if version else None
    publish(run, result, state, recipe, evidence, publishable)
    result["timings_s"]["export"] = round(time.monotonic() - exporting, 2)
    result["timings_s"]["total"] = round(time.monotonic() - started, 2)
    print(json.dumps(result, indent=2))
    if not publishable:
        print(f"sweep: stopped after {evaluated} of {len(run.samples)} poses and their checks at --time-limit "
              f"{args.time_limit} s", file=sys.stderr)
    return exit_code(result["status"])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # an OCCT or FreeCAD failure is infrastructure, never a check result
        traceback.print_exc()
        sys.exit(2)
