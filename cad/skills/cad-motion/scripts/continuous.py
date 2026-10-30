"""The between-sample check of cad-motion `sweep.py`: whether a pair can collide, or come closer
than its clearance minimum, between two consecutive samples of a sweep path.

A sampled sweep proves its poses only. This check extends a pass to the one-dimensional paths
between them (`SweepPath`, built by sweep.py): each independent joint across its range with the
others at nominal, and each grid axis edge with the other grid values held. It never joins samples
of different paths, so a jump from one path to another is no motion and is never proved; the rest
of the joint space is not covered.

Rate (`sample_rates`). Along a path, the distance d(q) of a pair of solids (0 where one lies inside
the other) changes no faster than the fastest point of either body moves in the other's frame:
distance is 1-Lipschitz in each point. A rigid motion's displacement is affine in the point, so
over a box it is largest at a corner; the corners of each definition's box inflated by its per-part
error e_i (the mesh envelope, which holds the exact body) bound the body's motion. The path is cut
into fine cells, a GRID_DEG or GRID_MM grid plus the path's samples and any known profile knots, so
a narrow ramp a knot marks is never averaged away inside one cell. A cell's rate is the largest
corner displacement between its two poses over its width, for b in a's frame and for a in b's.
A proof interval takes, per direction, the largest rate of the cells it overlaps and of one more
cell either side, then the smaller direction (both bound d's change), times the safety factor.

Interval bound (`prove_between`). With lower bounds d0 and d1 at an interval's ends and a rate L,
each end's cone gives d(q) >= d0 - L (q - q0) and d(q) >= d1 - L (q1 - q); their sum bounds every
pose between: d >= (d0 + d1 - L dq) / 2, claimed at most up to the smaller end bound. An end's
lower bound by method: a validated exact distance (Measured); a Cleared lower (box, mesh, the
resolved replacement of an exact suspect, a cache-bucket hit after its displacement inflation); a
Pruned certified floor. A failed, missing or deadline-stopped reading leaves the interval uncovered,
never proved; a suspect's original reading never qualifies. An interval whose bound is above 0 is
collision-free; at or above the pair's minimum, its clearance is proved too. One that is not
collision-free is bisected, to MAX_DEPTH, through `evaluate_midpoints` in pair_measure's bound mode
(Cleared where its own bound proves no contact, else measured exactly). An exact midpoint reading
that overlaps beyond the volume tolerance is a between-sample collision, which ends its sample
interval's refinement; one below the pair's minimum is a clearance finding. Both replay at the
midpoint's pose. Bisection serves the collision proof only: a collision-free interval whose bound
is below the minimum is clearance-unproved, while the samples' exact minima stay their own evidence.

Pairs: every pair is checked except one whose contact (a fit, an insert, a joint contact) or overlap
is declared and that no explicit positive clearance minimum binds; those stay sampled-only, listed
with the reason. A zero-minimum pair without such a declaration is checked: its collision freedom
needs proof too.

Guarantee: conditional (GUARANTEE, `rigorous: false`). The rate is sampled, a finite difference
times the safety factor, not a proven maximum of the motion's speed: a body that moves faster
between fine poses than across them, as a ramp narrower than a cell that no knot marks does, can
hide a collision this check reports as proved, and the mesh envelope is mesh_bound.py's own
assumption. Rigorous motion guarantees need analytic joint-rate Jacobians or interval bounds.
Every report carries LIMITATION.

Report (`ContinuousReport.as_json`): a status (a between-sample finding exits 1; an unproved or
uncovered interval, the deadline included, leaves coverage incomplete, exit 2; clearance-unproved
alone keeps a sampled pass), the per-path coverage, sample-interval and leaf counts apart, the
findings, unproved intervals and clearance-unproved pairs, all bounds rounded outward. Each pair's
proof stands alone, so `merge` joins the blocks of disjoint pair sets (subsystem partitions) into
the block of the whole run.

Stdlib only. sweep.py supplies the paths, the transforms, the envelopes (mesh_bound's boxes at the
identity) and the evaluator (pair_measure's session), and owns the CLI, cache and processes.
"""

from __future__ import annotations

import bisect
import math
import time
from collections.abc import Callable, Hashable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

GRID_DEG = 0.25  # a revolute path's fine cells, degrees
GRID_MM = 0.25  # a prismatic path's, mm
SAFETY = 1.5  # over the sampled rate
MAX_DEPTH = 6  # bisections of one sample interval at most: 64 leaves
UNITS = ("deg", "mm")
GUARANTEE = "conditional_sampled_rate_and_mesh_envelope"
LIMITATION = (
    "Conditional, not rigorous: each motion rate is sampled, the largest displacement of a "
    "definition's mesh box (inflated by its per-part error) between fine poses over the step, times "
    "the safety factor. These finite differences are not proven maxima: a motion faster between "
    "fine poses than across them can hide a collision this check reports as proved, and every "
    "bound holds only within the mesh envelope. Analytic joint-rate Jacobians or interval bounds are "
    "needed for rigorous motion guarantees. Coverage is the sweep's one-dimensional paths between "
    "consecutive samples, not the whole joint space.")
DISABLED_LIMITATION = "The between-sample check is off: only the sampled poses are checked; nothing is proved between them."


class Placement(Protocol):
    """pose.Rigid: x -> rot @ x + trans, rot as rows."""

    @property
    def rot(self) -> Sequence[Sequence[float]]: ...

    @property
    def trans(self) -> Sequence[float]: ...


class Envelope(Protocol):
    """A definition's box in its own frame, holding its body: mesh_bound's Box at the identity
    (the mesh vertices' box, `error_mm` its deviation; an unmeshed definition's tolerance box, 0)."""

    @property
    def low(self) -> Sequence[float]: ...

    @property
    def high(self) -> Sequence[float]: ...

    @property
    def error_mm(self) -> float: ...


@dataclass(frozen=True)
class SweepPath:
    """One path of a sweep: `driver_joint` through `coordinates` (strictly increasing, in `unit`),
    the sample of global id `sample_ids[k]` at `coordinates[k]` (None: no valid sample there), every
    other independent joint at `fixed_settings`."""

    id: str
    driver_joint: str
    unit: str
    coordinates: tuple[float, ...]
    sample_ids: tuple[Hashable | None, ...]
    fixed_settings: Mapping[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        where = f"continuous path {self.id}"
        if self.unit not in UNITS:
            raise ValueError(f"{where}: unit must be one of {UNITS}, got {self.unit!r}")
        if len(self.coordinates) != len(self.sample_ids):
            raise ValueError(f"{where}: {len(self.coordinates)} coordinates but {len(self.sample_ids)} sample ids")
        if not all(math.isfinite(q) for q in self.coordinates) \
                or any(b <= a for a, b in zip(self.coordinates, self.coordinates[1:])):
            raise ValueError(f"{where}: coordinates must be finite and strictly increasing")
        if self.driver_joint in self.fixed_settings:
            raise ValueError(f"{where}: the driver {self.driver_joint} is also a fixed setting")

    def settings(self, coordinate: float) -> dict[str, float]:
        """The independent joints' values at `coordinate` of the driver."""
        return {**self.fixed_settings, self.driver_joint: coordinate}


@dataclass(frozen=True)
class PairSpec:
    """An occurrence pair (`ids`, chain order) of definitions `definition_ids`; `minimum_mm` its
    greatest applicable clearance requirement (0: none). `contact_declared`: a fit, insert or joint
    contact declares it touching; `overlap_allowed`: its shared volume is declared."""

    ids: tuple[str, str]
    definition_ids: tuple[str, str]
    minimum_mm: float = 0.0
    contact_declared: bool = False
    overlap_allowed: bool = False

    def exclusion(self) -> str | None:
        """Why the pair stays sampled-only, or None when it is checked: a declared contact or overlap
        excludes it unless an explicit positive clearance minimum binds it."""
        if self.minimum_mm > 0:
            return None
        declared = [reason for reason, flag in (("contact declared", self.contact_declared),
                                                ("overlap allowed", self.overlap_allowed)) if flag]
        return ", ".join(declared) + " without a positive clearance minimum" if declared else None


@dataclass(frozen=True)
class MidpointRequest:
    """A between-sample pose to evaluate for one pair in pair_measure's bound mode (Cleared where its
    own bound proves no contact, else Measured exactly): `pair` with the path's driver at
    `coordinate` and every other independent joint at its fixed setting."""

    id: int
    path: SweepPath
    pair: PairSpec
    coordinate: float

    @property
    def settings(self) -> dict[str, float]:
        return self.path.settings(self.coordinate)


@dataclass(frozen=True)
class PairRates:
    """A path's sampled motion rates (`sample_rates`): `cells[pair]` holds, per fine cell
    [coordinates[k], coordinates[k + 1]], the largest displacement of an inflated box corner of b in
    a's frame, and of a in b's, over the cell's width (mm per `unit`); inf next to an invalid fine
    pose or without an envelope."""

    path_id: str
    unit: str
    grid: float
    safety: float
    coordinates: tuple[float, ...]
    cells: Mapping[tuple[str, str], tuple[tuple[float, ...], tuple[float, ...]]]

    def rate(self, pair: tuple[str, str], low: float, high: float) -> float:
        """The rate of proof interval [low, high]: per direction the largest of the cells it overlaps
        and one more either side, the smaller direction, times the safety factor; inf when the
        interval leaves the fine cells or the pair has no rates."""
        directions, coordinates = self.cells.get(pair), self.coordinates
        if directions is None or len(coordinates) < 2 or low < coordinates[0] or high > coordinates[-1]:
            return math.inf
        first = max(0, bisect.bisect_right(coordinates, low) - 2)
        last = min(len(coordinates) - 2, bisect.bisect_left(coordinates, high))
        b_in_a, a_in_b = directions
        return self.safety * min(max(b_in_a[first:last + 1]), max(a_in_b[first:last + 1]))


@dataclass(frozen=True)
class Finding:
    """An exact between-sample reading that fails: `kind` "collision" (overlap beyond the volume
    tolerance) or "clearance" (below `required_mm`), replayable at `pose`."""

    kind: str
    pair: tuple[str, str]
    path: str
    coordinate: float
    unit: str
    independent_pose: Mapping[str, float]
    pose: Mapping[str, float]
    distance_mm: float
    overlap_mm3: float
    required_mm: float

    def as_json(self) -> dict[str, Any]:
        return {"kind": self.kind, "pair": list(self.pair), "path": self.path,
                "coordinate": _round6(self.coordinate), "unit": self.unit,
                "independent_pose": _rounded(self.independent_pose), "pose": _rounded(self.pose),
                "distance_mm": round(self.distance_mm, 4) + 0.0, "overlap_mm3": round(self.overlap_mm3, 4) + 0.0,
                "required_mm": self.required_mm}


@dataclass(frozen=True)
class Unproved:
    """A leaf interval [low, high] not proved collision-free: `lower_mm` its bound (None when no
    bound exists), `reason` why."""

    pair: tuple[str, str]
    path: str
    low: float
    high: float
    unit: str
    depth: int
    lower_mm: float | None
    reason: str

    def as_json(self) -> dict[str, Any]:
        return {"pair": list(self.pair), "path": self.path, "interval": [_round6(self.low), _round6(self.high)],
                "unit": self.unit, "depth": self.depth, "lower_mm": _floor4(self.lower_mm), "reason": self.reason}


@dataclass(frozen=True)
class ClearanceUnproved:
    """A pair proved collision-free on `intervals` leaves whose bound, `lower_mm` the smallest,
    stays below its minimum `required_mm`."""

    pair: tuple[str, str]
    required_mm: float
    lower_mm: float
    intervals: int

    def as_json(self) -> dict[str, Any]:
        return {"pair": list(self.pair), "required_mm": self.required_mm, "lower_mm": _floor4(self.lower_mm),
                "intervals": self.intervals}


@dataclass(frozen=True)
class Margin:
    """The smallest proved clearance margin, a leaf's bound minus its pair's minimum: least by the
    reported (rounded) margin, then pair, path and interval, so every partition order agrees."""

    pair: tuple[str, str]
    path: str
    low: float
    high: float
    unit: str
    margin_mm: float
    required_mm: float

    def as_json(self) -> dict[str, Any]:
        return {"pair": list(self.pair), "path": self.path, "interval": [_round6(self.low), _round6(self.high)],
                "unit": self.unit, "margin_mm": _floor4(self.margin_mm), "required_mm": self.required_mm}


@dataclass
class ContinuousReport:
    """The between-sample check's verdict. `status`: "finding" (a between-sample collision or
    clearance finding), else "unproved" (a leaf not proved collision-free, or uncovered), else
    "proved_collision_free"; "disabled" when the check is off. Leaf counts are the bisected
    intervals, apart from the `original_intervals` (one per path, pair and consecutive samples)."""

    status: str
    guarantee: str
    grid: dict[str, float | None]
    safety_factor: float | None
    max_depth: int
    paths: list[dict[str, Any]]
    pairs_checked: int
    contact_pairs_sampled_only: list[dict[str, Any]]
    original_intervals: int
    leaf_intervals: int
    proved_collision_free_leaf_intervals: int
    proved_clearance_leaf_intervals: int
    midpoints: dict[str, int]
    between_sample_findings: list[Finding]
    collision_free_unproved_intervals: list[Unproved]
    clearance_unproved_pairs: list[ClearanceUnproved]
    smallest_proved_clearance_margin: Margin | None
    limitation: str

    @property
    def exit_code(self) -> int:
        """1 for a between-sample finding, 2 for incomplete coverage, else 0. Clearance-unproved
        alone keeps a sampled pass, without claiming continuous clearance."""
        return {"finding": 1, "unproved": 2}.get(self.status, 0)

    def as_json(self) -> dict[str, Any]:
        """The report block: bounds outward rounded to 4 decimals, readings rounded, unbounded None;
        every list in a canonical order, so `merge` of a partition's blocks equals the whole run's."""
        margin = self.smallest_proved_clearance_margin
        return _canonical({
            "status": self.status, "guarantee": self.guarantee, "rigorous": False, "grid": dict(self.grid),
            "safety_factor": self.safety_factor, "max_depth": self.max_depth, "paths": [dict(p) for p in self.paths],
            "pairs_checked": self.pairs_checked, "contact_pairs_sampled_only": [dict(p) for p in self.contact_pairs_sampled_only],
            "original_intervals": self.original_intervals, "leaf_intervals": self.leaf_intervals,
            "proved_collision_free_leaf_intervals": self.proved_collision_free_leaf_intervals,
            "proved_clearance_leaf_intervals": self.proved_clearance_leaf_intervals,
            "midpoints": dict(self.midpoints),
            "between_sample_findings": [f.as_json() for f in self.between_sample_findings],
            "collision_free_unproved_intervals": [u.as_json() for u in self.collision_free_unproved_intervals],
            "clearance_unproved_pairs": [c.as_json() for c in self.clearance_unproved_pairs],
            "smallest_proved_clearance_margin": None if margin is None else margin.as_json(),
            "limitation": self.limitation,
        })


def disabled() -> ContinuousReport:
    """The report of a sweep run without the between-sample check: sampled-only."""
    return ContinuousReport("disabled", "sampled_poses_only", {"deg": None, "mm": None}, None, 0, [], 0, [], 0, 0, 0, 0,
                            _midpoint_counts(), [], [], [], None, DISABLED_LIMITATION)


_SETTINGS = ("guarantee", "rigorous", "max_depth", "limitation")
_PATH_COUNTS = ("intervals", "proved_collision_free", "with_findings", "unproved")


def merge(blocks: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """One report block from the `as_json` blocks of checks over disjoint pair sets (subsystem
    partitions) of the same paths and settings. A pair's proof stands on its own, so the union is
    their conjunction: counts add, lists join, the worst status and the smallest margin hold. The
    caller proves the partition (disjoint and complete pairs); mixed settings or paths are refused."""
    if not blocks:
        raise ValueError("no continuous blocks to merge")
    disabled_blocks = [block["status"] == "disabled" for block in blocks]
    if any(disabled_blocks):
        if not all(disabled_blocks):
            raise ValueError("continuous blocks mix a disabled check with a run one")
        return dict(blocks[0])
    for block in blocks[1:]:
        for key in _SETTINGS:
            if block[key] != blocks[0][key]:
                raise ValueError(f"continuous blocks disagree on {key}: {blocks[0][key]!r} and {block[key]!r}")
    grid: dict[str, float | None] = {"deg": None, "mm": None}
    safety: float | None = None
    paths: dict[str, dict[str, Any]] = {}
    midpoints: dict[str, int] = {}
    for block in blocks:
        for unit, step in block["grid"].items():
            grid[unit] = _agreed(f"the {unit} grid", grid.get(unit), step)
        safety = _agreed("the safety factor", safety, block["safety_factor"])
        for path in block["paths"]:
            known = paths.setdefault(path["id"], {**path, **{key: 0 for key in _PATH_COUNTS}})
            if any(known[key] != path[key] for key in path if key not in _PATH_COUNTS):
                raise ValueError(f"continuous blocks disagree on path {path['id']}")
            for key in _PATH_COUNTS:
                known[key] += path[key]
        for kind, count in block["midpoints"].items():
            midpoints[kind] = midpoints.get(kind, 0) + count

    def joined(key: str) -> list[Any]:
        return [row for block in blocks for row in block[key]]

    def total(key: str) -> int:
        return sum(block[key] for block in blocks)

    findings, unproved = joined("between_sample_findings"), joined("collision_free_unproved_intervals")
    margins = [block["smallest_proved_clearance_margin"] for block in blocks
               if block["smallest_proved_clearance_margin"] is not None]
    return _canonical({
        "status": "finding" if findings else "unproved" if unproved else "proved_collision_free",
        "guarantee": blocks[0]["guarantee"], "rigorous": blocks[0]["rigorous"], "grid": grid, "safety_factor": safety,
        "max_depth": blocks[0]["max_depth"], "paths": list(paths.values()), "pairs_checked": total("pairs_checked"),
        "contact_pairs_sampled_only": joined("contact_pairs_sampled_only"),
        "original_intervals": total("original_intervals"), "leaf_intervals": total("leaf_intervals"),
        "proved_collision_free_leaf_intervals": total("proved_collision_free_leaf_intervals"),
        "proved_clearance_leaf_intervals": total("proved_clearance_leaf_intervals"),
        "midpoints": midpoints, "between_sample_findings": findings, "collision_free_unproved_intervals": unproved,
        "clearance_unproved_pairs": joined("clearance_unproved_pairs"),
        "smallest_proved_clearance_margin": min(margins, key=_margin_order, default=None),
        "limitation": blocks[0]["limitation"],
    })


def _agreed(name: str, known: Any, value: Any) -> Any:
    if value is None or known is None or known == value:
        return known if value is None else value
    raise ValueError(f"continuous blocks disagree on {name}: {known!r} and {value!r}")


def _margin_order(row: Mapping[str, Any]) -> tuple:
    return (row["margin_mm"], row["pair"], row["path"], row["interval"])


def _canonical(block: dict[str, Any]) -> dict[str, Any]:
    """`block` with its lists in an order independent of evaluation and partition order."""
    block["contact_pairs_sampled_only"].sort(key=lambda row: row["pair"])
    block["between_sample_findings"].sort(key=lambda row: (row["pair"], row["path"], row["coordinate"], row["kind"]))
    block["collision_free_unproved_intervals"].sort(key=lambda row: (row["pair"], row["path"], row["interval"], row["reason"]))
    block["clearance_unproved_pairs"].sort(key=lambda row: (row["lower_mm"] - row["required_mm"], row["pair"]))
    return block


def sample_rates(path: SweepPath, *, at: Callable[[float], Mapping[str, Placement] | None],
                 boxes: Mapping[str, Envelope], pairs: Sequence[PairSpec], grid: float, safety: float = SAFETY,
                 breakpoints: Iterable[float] = ()) -> PairRates:
    """The sampled motion rates of every checked pair of `pairs` along `path`. `at(q)` gives each
    occurrence's placement with the driver at q (None: no valid pose there), called once per fine
    pose; `boxes` each occurrence's definition envelope; `breakpoints` the known knots, seams and
    events of the path's profiles (cell edges, so a narrow known ramp keeps its own cells)."""
    if not (math.isfinite(grid) and grid > 0):
        raise ValueError(f"continuous grid must be a finite positive step, got {grid!r}")
    if not (math.isfinite(safety) and safety >= 1):
        raise ValueError(f"continuous safety factor must be finite and at least 1, got {safety!r}")
    coordinates = _fine_coordinates(path.coordinates, grid, breakpoints)
    poses = [at(q) for q in coordinates]
    widths = [b - a for a, b in zip(coordinates, coordinates[1:])]
    unbounded = (math.inf,) * len(widths)
    cells: dict[tuple[str, str], tuple[tuple[float, ...], tuple[float, ...]]] = {}
    for pair in pairs:
        if pair.exclusion() is not None:
            continue
        a, b = pair.ids
        if a not in boxes or b not in boxes:
            cells[pair.ids] = (unbounded, unbounded)
            continue
        box_a, box_b = _inflated(boxes[a]), _inflated(boxes[b])
        relative = [None if pose is None or a not in pose or b not in pose else _relative(pose[a], pose[b])
                    for pose in poses]
        b_in_a, a_in_b = [], []
        for k, width in enumerate(widths):
            start, end = relative[k], relative[k + 1]
            if start is None or end is None:
                b_in_a.append(math.inf)
                a_in_b.append(math.inf)
            elif start == end:
                b_in_a.append(0.0)
                a_in_b.append(0.0)
            else:
                b_in_a.append(_corner_motion(start, end, box_b) / width)
                a_in_b.append(_corner_motion(_inverse(start), _inverse(end), box_a) / width)
        cells[pair.ids] = (tuple(b_in_a), tuple(a_in_b))
    return PairRates(path.id, path.unit, grid, safety, coordinates, cells)


def prove_between(paths: Sequence[SweepPath], *, pairs: Sequence[PairSpec],
                  endpoint: Mapping[tuple[str, tuple[str, str], Hashable], Any], rates: Mapping[str, PairRates],
                  evaluate_midpoints: Callable[[Sequence[MidpointRequest]], Mapping[int, Any]],
                  volume_tol: float, max_depth: int = MAX_DEPTH, deadline: float = math.inf,
                  complete: Callable[[Mapping[str, float]], Mapping[str, float]] | None = None) -> ContinuousReport:
    """The between-sample check of `paths` for `pairs`. `endpoint[(path id, pair ids, sample id)]`
    is the sample's pair_measure outcome; `rates[path id]` its `sample_rates`. `evaluate_midpoints`
    answers a batch of MidpointRequest with outcomes by request id (a missing id or None: not
    evaluated), once per bisection level. `volume_tol` is the sweep's collision volume, `deadline`
    a time.monotonic() value, `complete` the independent settings -> every coordinate (the
    findings' replay pose; the independent settings without it)."""
    if isinstance(max_depth, bool) or not isinstance(max_depth, int) or not 0 <= max_depth <= MAX_DEPTH:
        raise ValueError(f"continuous depth must be an integer 0..{MAX_DEPTH}, got {max_depth!r}")
    return _Prover(pairs, endpoint, rates, evaluate_midpoints, volume_tol, max_depth, deadline, complete).run(paths)


@dataclass(frozen=True)
class _Reading:
    lower_mm: float  # the exact distance when `exact`
    method: str
    exact: bool
    overlap_mm3: float


def _reading(outcome: Any) -> tuple[_Reading | None, str]:
    """A pair_measure outcome's lower bound by method, or (None, why it bounds nothing). The
    outcome is read by its fields: Measured (distance_mm, overlap_mm3), Cleared (lower_mm, method),
    Pruned (witness_request, lower_mm), Failure (message), None (the deadline)."""
    if outcome is None:
        return None, "not evaluated before the deadline"
    if hasattr(outcome, "reevaluated"):
        return None, "a suspect's original reading never qualifies"
    if hasattr(outcome, "distance_mm") and hasattr(outcome, "overlap_mm3"):
        reading = _Reading(float(outcome.distance_mm), "exact", True, float(outcome.overlap_mm3))
    elif hasattr(outcome, "lower_mm"):
        method = "pruned" if hasattr(outcome, "witness_request") else str(outcome.method)
        reading = _Reading(float(outcome.lower_mm), method, False, 0.0)
    elif hasattr(outcome, "message"):
        return None, f"failed: {outcome.message}"
    else:
        raise TypeError(f"not a pair_measure outcome: {outcome!r}")
    if not reading.lower_mm >= 0 or not reading.overlap_mm3 >= 0:
        return None, f"no valid lower bound in {outcome!r}"
    return reading, ""


@dataclass
class _Node:
    """A proof interval [low, high] of one pair on one path, bisected `depth` times from sample
    interval `root`; `start` and `end` its ends' readings (None only for a root left uncovered)."""

    root: int
    path: SweepPath
    pair: PairSpec
    low: float
    high: float
    start: _Reading | None
    end: _Reading | None
    depth: int


@dataclass
class _Root:
    path: str
    has_finding: bool = False
    has_unproved: bool = False
    collided: bool = False
    clearance: Finding | None = None  # the smallest exact midpoint distance below the minimum


class _Prover:
    def __init__(self, pairs: Sequence[PairSpec], endpoint: Mapping[Any, Any], rates: Mapping[str, PairRates],
                 evaluate: Callable[[Sequence[MidpointRequest]], Mapping[int, Any]], volume_tol: float,
                 max_depth: int, deadline: float, complete: Callable[[Mapping[str, float]], Mapping[str, float]] | None) -> None:
        self.checked = [pair for pair in pairs if pair.exclusion() is None]
        self.excluded = [{"pair": list(pair.ids), "reason": pair.exclusion()} for pair in pairs if pair.exclusion() is not None]
        self.endpoint, self.rates, self.evaluate = endpoint, rates, evaluate
        self.volume_tol, self.max_depth, self.deadline, self.complete = volume_tol, max_depth, deadline, complete
        self.roots: list[_Root] = []
        self.findings: list[Finding] = []
        self.unproved: list[Unproved] = []
        self.leaves = self.proved = self.cleared = 0
        self.midpoints = _midpoint_counts()
        self.below: dict[tuple[str, str], tuple[float, int, float]] = {}  # pair -> (smallest lower, leaves, minimum)
        self.margin: Margin | None = None
        self.next_id = 0

    def run(self, paths: Sequence[SweepPath]) -> ContinuousReport:
        frontier = [node for path in paths for node in self.roots_of(path)]
        for depth in range(self.max_depth + 1):
            pending = [node for node in frontier if self.settle(node)]
            if not pending:
                break
            if time.monotonic() > self.deadline:
                for node in pending:
                    self.unprove(node, None, "the deadline stopped the bisection")
                break
            frontier = []
            for node, outcome in zip(pending, self.evaluate_batch(pending)):
                frontier += self.split(node, outcome)
        return self.report(paths)

    def roots_of(self, path: SweepPath) -> list[_Node]:
        nodes = []
        for pair in self.checked:
            for k in range(len(path.coordinates) - 1):
                self.roots.append(_Root(path.id))
                root, low, high = len(self.roots) - 1, path.coordinates[k], path.coordinates[k + 1]
                (start, start_why), (end, end_why) = self.sample_reading(path, pair, k), self.sample_reading(path, pair, k + 1)
                node = _Node(root, path, pair, low, high, start, end, 0)
                if start is None or end is None:
                    self.unprove(node, None, start_why if start is None else end_why)
                elif self.collides(pair, start) or self.collides(pair, end):
                    self.unprove(node, None, "collision at a sampled endpoint")
                else:
                    nodes.append(node)
        return nodes

    def sample_reading(self, path: SweepPath, pair: PairSpec, k: int) -> tuple[_Reading | None, str]:
        sample = path.sample_ids[k]
        where = f"sample at {path.coordinates[k]:g} {path.unit}"
        if sample is None:
            return None, f"{where}: no valid sample"
        key = (path.id, pair.ids, sample)
        if key not in self.endpoint:
            return None, f"{where}: no reading"
        reading, why = _reading(self.endpoint[key])
        return reading, f"{where}: {why}" if reading is None else ""

    def collides(self, pair: PairSpec, reading: _Reading) -> bool:
        return reading.exact and reading.overlap_mm3 > self.volume_tol and not pair.overlap_allowed

    def settle(self, node: _Node) -> bool:
        """Close `node` as proved or unproved; True when it needs its midpoint."""
        if self.roots[node.root].collided:
            self.leaves += 1
            return False
        rate = self.rates[node.path.id].rate(node.pair.ids, node.low, node.high) if node.path.id in self.rates else math.inf
        if math.isinf(rate):
            self.unprove(node, None, "no finite motion rate (an invalid fine pose or no envelope)")
            return False
        assert node.start is not None and node.end is not None
        d0, d1 = node.start.lower_mm, node.end.lower_mm
        lower = min((d0 + d1 - rate * (node.high - node.low)) / 2, d0, d1)
        if lower > 0:
            self.prove(node, lower)
            return False
        if node.depth == self.max_depth:
            self.unprove(node, lower, f"not proved collision-free at depth {self.max_depth}")
            return False
        return True

    def prove(self, node: _Node, lower: float) -> None:
        self.leaves += 1
        self.proved += 1
        pair = node.pair
        if lower >= pair.minimum_mm:
            self.cleared += 1
            margin = lower - pair.minimum_mm
            candidate = Margin(pair.ids, node.path.id, node.low, node.high, node.path.unit, margin, pair.minimum_mm)
            if self.margin is None or _margin_order(candidate.as_json()) < _margin_order(self.margin.as_json()):
                self.margin = candidate
            return
        smallest, count, minimum = self.below.get(pair.ids, (math.inf, 0, pair.minimum_mm))
        self.below[pair.ids] = (min(smallest, lower), count + 1, minimum)

    def unprove(self, node: _Node, lower: float | None, reason: str) -> None:
        self.leaves += 1
        self.roots[node.root].has_unproved = True
        self.unproved.append(Unproved(node.pair.ids, node.path.id, node.low, node.high, node.path.unit, node.depth,
                                      None if lower is None or math.isinf(lower) else lower, reason))

    def evaluate_batch(self, nodes: list[_Node]) -> list[Any]:
        requests = []
        for node in nodes:
            requests.append(MidpointRequest(self.next_id, node.path, node.pair, (node.low + node.high) / 2))
            self.next_id += 1
        outcomes = self.evaluate(requests)
        return [outcomes.get(request.id) for request in requests]

    def split(self, node: _Node, outcome: Any) -> list[_Node]:
        """`node`'s halves at its midpoint `outcome`, or none: a collision there, or no bound."""
        root, pair, path = self.roots[node.root], node.pair, node.path
        if root.collided:
            self.leaves += 1
            return []
        reading, why = _reading(outcome)
        if reading is None:
            self.unprove(node, None, f"midpoint {why}")
            return []
        kind = _MIDPOINT_KINDS.get(reading.method, reading.method)
        self.midpoints[kind] = self.midpoints.get(kind, 0) + 1
        middle = (node.low + node.high) / 2
        if self.collides(pair, reading):
            root.collided = root.has_finding = True
            self.findings.append(self.finding("collision", node, middle, reading))
            self.leaves += 1
            return []
        if reading.exact and reading.lower_mm < pair.minimum_mm:
            root.has_finding = True
            if root.clearance is None or reading.lower_mm < root.clearance.distance_mm:
                root.clearance = self.finding("clearance", node, middle, reading)
        return [_Node(node.root, path, pair, node.low, middle, node.start, reading, node.depth + 1),
                _Node(node.root, path, pair, middle, node.high, reading, node.end, node.depth + 1)]

    def finding(self, kind: str, node: _Node, coordinate: float, reading: _Reading) -> Finding:
        settings = node.path.settings(coordinate)
        pose = dict(self.complete(settings)) if self.complete is not None else dict(settings)
        return Finding(kind, node.pair.ids, node.path.id, coordinate, node.path.unit, settings, pose,
                       reading.lower_mm, reading.overlap_mm3, node.pair.minimum_mm)

    def report(self, paths: Sequence[SweepPath]) -> ContinuousReport:
        findings = self.findings + [root.clearance for root in self.roots if root.clearance is not None
                                    and not root.collided]
        status = "finding" if findings else "unproved" if self.unproved else "proved_collision_free"
        grid: dict[str, float | None] = {"deg": None, "mm": None}
        safety: float | None = None
        for path in paths:
            rates = self.rates.get(path.id)
            if rates is None:
                continue
            for name, value, known in (("grid", rates.grid, grid[rates.unit]), ("safety factor", rates.safety, safety)):
                if known is not None and known != value:
                    raise ValueError(f"continuous paths disagree on the {name}: {known} and {value}")
            grid[rates.unit], safety = rates.grid, rates.safety
        coverage = []
        for path in paths:
            roots = [root for root in self.roots if root.path == path.id]
            coverage.append({
                "id": path.id, "driver_joint": path.driver_joint, "unit": path.unit,
                "range": [_round6(path.coordinates[0]), _round6(path.coordinates[-1])], "samples": len(path.coordinates),
                "intervals": len(roots),
                "proved_collision_free": sum(1 for r in roots if not r.has_finding and not r.has_unproved),
                "with_findings": sum(1 for r in roots if r.has_finding),
                "unproved": sum(1 for r in roots if r.has_unproved and not r.has_finding),
            })
        below = [ClearanceUnproved(pair, minimum, lower, count) for pair, (lower, count, minimum) in self.below.items()]
        return ContinuousReport(
            status, GUARANTEE, grid, safety, self.max_depth, coverage, len(self.checked), self.excluded,
            len(self.roots), self.leaves, self.proved, self.cleared, self.midpoints, findings, self.unproved,
            sorted(below, key=lambda item: (item.lower_mm - item.required_mm, item.pair)), self.margin, LIMITATION)


_MIDPOINT_KINDS = {"exact": "exact", "box": "box", "mesh": "mesh", "mesh (exact suspect)": "mesh", "cache-bound": "cache"}


def _midpoint_counts() -> dict[str, int]:
    return {"box": 0, "mesh": 0, "exact": 0, "cache": 0}


def _fine_coordinates(samples: Sequence[float], grid: float, breakpoints: Iterable[float]) -> tuple[float, ...]:
    """The path's fine poses: its samples, the knots inside its range, and every grid step from its
    start that is not within a millionth of a step of either."""
    if not samples:
        return ()
    low, high = samples[0], samples[-1]
    knots = list(breakpoints)
    if not all(math.isfinite(q) for q in knots):
        raise ValueError("continuous breakpoints must be finite")
    kept = sorted({*samples, *(q for q in knots if low < q < high)})
    points, tolerance = list(kept), grid * 1e-6
    for k in range(1, math.ceil((high - low) / grid)):
        q = low + k * grid
        at = bisect.bisect_left(kept, q)
        if (at < len(kept) and kept[at] - q <= tolerance) or (at > 0 and q - kept[at - 1] <= tolerance):
            continue
        points.append(q)
    return tuple(sorted(points))


_Rows = tuple[float, float, float, float, float, float, float, float, float, float, float, float]


def _relative(a: Placement, b: Placement) -> _Rows:
    """b's frame in a's, a^-1 b, as 12 floats: the rotation's rows, then the translation."""
    (a00, a01, a02), (a10, a11, a12), (a20, a21, a22) = a.rot
    (b00, b01, b02), (b10, b11, b12), (b20, b21, b22) = b.rot
    dx, dy, dz = b.trans[0] - a.trans[0], b.trans[1] - a.trans[1], b.trans[2] - a.trans[2]
    return (a00 * b00 + a10 * b10 + a20 * b20, a00 * b01 + a10 * b11 + a20 * b21, a00 * b02 + a10 * b12 + a20 * b22,
            a01 * b00 + a11 * b10 + a21 * b20, a01 * b01 + a11 * b11 + a21 * b21, a01 * b02 + a11 * b12 + a21 * b22,
            a02 * b00 + a12 * b10 + a22 * b20, a02 * b01 + a12 * b11 + a22 * b21, a02 * b02 + a12 * b12 + a22 * b22,
            a00 * dx + a10 * dy + a20 * dz, a01 * dx + a11 * dy + a21 * dz, a02 * dx + a12 * dy + a22 * dz)


def _inverse(r: _Rows) -> _Rows:
    r00, r01, r02, r10, r11, r12, r20, r21, r22, tx, ty, tz = r
    return (r00, r10, r20, r01, r11, r21, r02, r12, r22,
            -(r00 * tx + r10 * ty + r20 * tz), -(r01 * tx + r11 * ty + r21 * tz), -(r02 * tx + r12 * ty + r22 * tz))


def _inflated(box: Envelope) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """(centre, half extents) of `box` grown by its error on every side."""
    e = box.error_mm
    if not (math.isfinite(e) and e >= 0):
        raise ValueError(f"an envelope's error must be finite and not negative, got {e!r}")
    low, high = box.low, box.high
    return (tuple((low[i] + high[i]) / 2 for i in range(3)),  # type: ignore[return-value]
            tuple((high[i] - low[i]) / 2 + e for i in range(3)))


def _corner_motion(start: _Rows, end: _Rows, box: tuple[tuple[float, float, float], tuple[float, float, float]]) -> float:
    """How far the farthest-moving corner of `box` ((centre, half extents)) goes from `start` to
    `end`: the displacement (end - start) applied to a corner is affine, centre term plus a signed
    sum of three half-extent columns."""
    (cx, cy, cz), (hx, hy, hz) = box
    d = [e - s for s, e in zip(start, end)]
    ux = d[0] * cx + d[1] * cy + d[2] * cz + d[9]
    uy = d[3] * cx + d[4] * cy + d[5] * cz + d[10]
    uz = d[6] * cx + d[7] * cy + d[8] * cz + d[11]
    ax, ay, az = d[0] * hx, d[3] * hx, d[6] * hx
    bx, by, bz = d[1] * hy, d[4] * hy, d[7] * hy
    cx_, cy_, cz_ = d[2] * hz, d[5] * hz, d[8] * hz
    best = 0.0
    for sb in (1.0, -1.0):
        for sc in (1.0, -1.0):
            px, py, pz = ax + sb * bx + sc * cx_, ay + sb * by + sc * cy_, az + sb * bz + sc * cz_
            best = max(best, (ux + px) ** 2 + (uy + py) ** 2 + (uz + pz) ** 2,
                       (ux - px) ** 2 + (uy - py) ** 2 + (uz - pz) ** 2)
    return math.sqrt(best)


def _floor4(value: float | None) -> float | None:
    """A lower bound rounded down to 4 decimals (sweep.py's floor4 rule); None when unbounded."""
    if value is None or not math.isfinite(value):
        return None
    return math.floor(round(value * 1e4, 6)) / 1e4 + 0.0


def _round6(value: float) -> float:
    return round(value, 6) + 0.0


def _rounded(values: Mapping[str, float]) -> dict[str, float]:
    return {key: _round6(value) for key, value in values.items()}
