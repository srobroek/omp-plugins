"""Pair measurements for cad-motion `sweep.py` and cad-model `check`.

The one measuring module of both tools. A request asks for the (minimum distance mm, overlap volume
mm^3) of two part definitions: definition `b` placed by `placement` in the frame of definition `a`
(sweep: a at its definition frame) or of `a` placed by `a_placement` (check: both in world
coordinates). Every measurement is pose.py's `interference` rule on the definition shapes moved by
`pose.placed`; nothing is copied, meshed or rebuilt per request. Each measurement is given the gap
between the two placed bounding boxes (`box_gap`), so a pair whose boxes are apart skips the
kernel's containment test, which cannot succeed there. Requests with bitwise equal definitions and
placements are measured once.

With `reuse` (sweep), a measurement is reused within the run by the two definitions and the
placement rounded to 1e-6 per matrix entry, so a joint sweep measures only the pairs that joint
moves and two same-PN pairs in one relative placement share one measurement. The reused value
belongs to the first request of the rounded key in request order. A reused distance that lies
within the request's placement bound of one of its clearance `thresholds` is measured again: moving
b from the measured placement to the requested one moves none of its points farther than
|dR|_F r + |dt| (r: the radius of b's bounding box about its origin), so the distance changes by at
most that, and a reused value never carries a verdict across a threshold.

With `prune` (sweep), a request of a `group` (the caller's occurrence pair, whose minimum it
reduces) is not measured when a lower bound on its distance exceeds, by SLACK_MM, the group's
smallest distance known so far, OVERLAP_GATE_MM and each of its `thresholds`. Its distance then lies
above the group's final minimum and every threshold, and it has no overlap, so no reduction over the
group depends on it: it is answered `Pruned`, which reads as (inf, 0). A reused request is pruned
only when the bound holds for both the placement it would reuse and its own. The bounds use exact
geometry, no tessellation: the box gap, and a known distance at a nearby placement of the group
minus the farthest any corner of b's box moves between the two placements (a rigid motion's
displacement is affine in the point, so its maximum over the box is at a corner, and distance is
1-Lipschitz). The group minimum only decreases, so a skip stays valid in any measuring order.
Requests are measured best first: each group's smallest box gap first, the groups in turn, so a
group's minimum is usually its first measurement.

`measure` returns one outcome per request, in request order: `(distance, volume)`, `Pruned`, a
`Failure` (the kernel raised; its message), or None when the deadline stopped the run first.
Stdlib only; OCP is imported when a shape is touched.
"""

from __future__ import annotations

import heapq
import importlib.util
import itertools
import math
import struct
import sys
import time
from collections import defaultdict, deque
from collections.abc import Hashable, Mapping, Sequence
from dataclasses import dataclass
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

SLACK_MM = 1e-6  # under every lower bound: 10x the kernel's confusion tolerance, for rounding in the bounds
MOTION_WINDOW = 6  # a known distance bounds the requests this many places either side in its group


@dataclass(frozen=True)
class Request:
    """Definition `b` placed by `placement`, against definition `a` at its definition frame or
    placed by `a_placement`; `thresholds` are the clearance thresholds (mm) the caller compares the
    distance with, and `group` the requests whose minimum it reduces together (None: never pruned)."""

    a: str
    b: str
    placement: Any
    a_placement: Any = None
    thresholds: tuple[float, ...] = ()
    group: Hashable | None = None


@dataclass(frozen=True)
class Failure:
    """A request the kernel could not measure: the error's message, else its type name."""

    message: str


@dataclass(frozen=True)
class Pruned:
    """A request the broad phase proved farther than its group's minimum, OVERLAP_GATE_MM and each of
    its thresholds; `witness` is the request whose distance was the group minimum then."""

    witness: int


Outcome = tuple[float, float] | Pruned | Failure


def reading(outcome: tuple[float, float] | Pruned) -> tuple[float, float]:
    """(distance, volume) as a reduction reads it: a pruned request is infinitely far, without overlap."""
    return (math.inf, 0.0) if isinstance(outcome, Pruned) else outcome


class PairMeasurer:
    """Measures requests on `shapes` (definition key -> TopoDS_Shape)."""

    def __init__(self, shapes: Mapping[str, Any], reuse: bool = False) -> None:
        self.shapes = dict(shapes)
        self.reuse = reuse
        self.radii = {key: max(math.hypot(*corner) for corner in itertools.product(*zip(*box_corners(shape))))
                      for key, shape in self.shapes.items()} if reuse else {}
        # The corners of each definition's bounding box, enlarged by its shape tolerances: the box
        # holds the shape, so its placed corners' axis-aligned hull holds the placed shape.
        self.corners = {key: list(itertools.product(*zip(*box_corners(shape, tolerance=True))))
                        for key, shape in self.shapes.items()}
        self.requested = 0  # requests answered
        self.measured = 0  # kernel measurements
        self.reused = 0  # requests answered by an earlier measurement
        self.rechecks = 0  # reuse candidates measured again: a threshold lies within their placement bound
        self.pruned = 0  # requests the broad phase answered without a measurement

    def measure(self, requests: Sequence[Request], deadline: float = math.inf, stop_on_failure: bool = False,
                prune: bool = False) -> list[Outcome | None]:
        """One outcome per request, in request order; None for the requests the deadline left
        unanswered, and for those still open after a failure when `stop_on_failure`."""
        run = _Run(self, requests, prune)
        run.execute(deadline, stop_on_failure)
        return run.outcomes

    def placement_bound(self, measured: Request, request: Request) -> float:
        """How far moving b from `measured`'s placement to `request`'s can move any of its points."""
        return (math.dist([v for row in measured.placement.rot for v in row],
                          [v for row in request.placement.rot for v in row])
                * self.radii[request.b] + math.dist(measured.placement.trans, request.placement.trans))

    def moved_corners(self, request: Request) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]]:
        """(a's, b's) bounding-box corners at the request's placements."""
        return (_moved(self.corners[request.a], request.a_placement), _moved(self.corners[request.b], request.placement))

    def box_gap(self, request: Request) -> float:
        """The distance between the axis-aligned hulls of the two placed bounding boxes: a lower
        bound on the distance between the placed shapes."""
        return _hull_gap(*self.moved_corners(request))

    def _measure_one(self, request: Request, box_gap: float) -> tuple[float, float] | Failure:
        self.measured += 1
        shape_a = self.shapes[request.a]
        if request.a_placement is not None:
            shape_a = pose.placed(shape_a, request.a_placement)
        try:
            return pose.interference(shape_a, pose.placed(self.shapes[request.b], request.placement), box_gap=box_gap)
        except Exception as error:  # noqa: BLE001 - OCP raises Standard_Failure on broken input
            return Failure(str(error) or type(error).__name__)


class _Run:
    """One `measure` call: the requests' units (distinct exact measurements), reuse and groups."""

    def __init__(self, measurer: PairMeasurer, requests: Sequence[Request], prune: bool) -> None:
        self.measurer, self.requests, self.prune = measurer, requests, prune
        count = len(requests)
        self.outcomes: list[Outcome | None] = [None] * count
        units: dict[tuple[Any, ...], int] = {}
        self.unit_of = [units.setdefault((r.a, r.b, _bits(r.a_placement), _bits(r.placement)), len(units))
                        for r in requests]
        self.unit_request = {unit: index for index, unit in reversed(list(enumerate(self.unit_of)))}
        self.known: dict[int, tuple[float, float] | Failure] = {}
        self.rep, self.bound = list(range(count)), [0.0] * count
        if measurer.reuse:
            first: dict[tuple[Any, ...], int] = {}
            for index, request in enumerate(requests):
                if request.a_placement is None:
                    key = (request.a, request.b, *(round(v, 6) for row in request.placement.rows(9) for v in row))
                    rep = first.setdefault(key, index)
                    if rep != index:
                        self.rep[index], self.bound[index] = rep, measurer.placement_bound(requests[rep], request)
        self.waiting: dict[int, list[int]] = defaultdict(list)  # unit -> requests its outcome may answer
        self.own: dict[int, list[int]] = defaultdict(list)  # unit -> requests at exactly its placement
        for index in range(count):
            self.own[self.unit_of[index]].append(index)
            self.waiting[self.unit_of[self.rep[index]]].append(index)
            if self.rep[index] != index:
                self.waiting[self.unit_of[index]].append(index)
        self.members: dict[Hashable, list[int]] = defaultdict(list)
        self.position = [0] * count
        for index, request in enumerate(requests):
            if request.group is not None:
                self.position[index] = len(self.members[request.group])
                self.members[request.group].append(index)
        self.floor: dict[Hashable, tuple[float, int]] = {}  # group -> (smallest known distance, its request)
        self.corners: dict[int, list[tuple[float, float, float]]] = {}  # unit -> b's placed box corners
        self.gaps: dict[int, float] = {}
        self.motion: dict[int, float] = {}  # unit -> best motion lower bound
        self.inflight: set[int] = set()
        self.touched: set[Hashable] = set()  # groups whose floor or bounds moved since the last prune pass
        self.queues: dict[Hashable, list[tuple[float, int]]] = defaultdict(list)  # open requests per group
        self.order: list[Hashable] = []
        self.turn = 0

    # -- answers -------------------------------------------------------------------------------

    def placed_corners(self, unit: int) -> list[tuple[float, float, float]]:
        """b's bounding-box corners at the unit's placement; computes its box gap on the way."""
        if unit not in self.corners:
            moved_a, moved_b = self.measurer.moved_corners(self.requests[self.unit_request[unit]])
            self.corners[unit], self.gaps[unit] = moved_b, _hull_gap(moved_a, moved_b)
        return self.corners[unit]

    def gap(self, unit: int) -> float:
        self.placed_corners(unit)
        return self.gaps[unit]

    def lower(self, unit: int) -> float:
        return max(self.gap(unit), self.motion.get(unit, -math.inf))

    def need(self, index: int) -> int:
        """The unit an open request waits on: its representative's, else its own."""
        rep = self.rep[index]
        if rep != index and self.unit_of[rep] not in self.known:
            return self.unit_of[rep]
        return self.unit_of[index]

    def resolve(self, index: int) -> bool:
        """Answer request `index` from the known units if they decide it; whether it is answered."""
        if self.outcomes[index] is not None:
            return True
        own = self.known.get(self.unit_of[index])
        rep = self.rep[index]
        if rep != index:
            earlier = self.known.get(self.unit_of[rep])
            if earlier is None:
                return False
            bound = self.bound[index]
            if isinstance(earlier, Failure) or not bound or all(abs(earlier[0] - threshold) > bound
                                                                for threshold in self.requests[index].thresholds):
                self.measurer.reused += 1
                self.settle(index, earlier)
                return True
            if own is None:
                return False
            self.measurer.rechecks += 1
        elif own is None:
            return False
        self.settle(index, own)
        return True

    def settle(self, index: int, outcome: Outcome) -> None:
        self.outcomes[index] = outcome
        self.measurer.requested += 1
        group = self.requests[index].group
        if group is not None and isinstance(outcome, tuple) and outcome[0] < self.floor.get(group, (math.inf, 0))[0]:
            self.floor[group] = (outcome[0], index)
            self.touched.add(group)

    def prunable(self, index: int) -> bool:
        request = self.requests[index]
        floor = self.floor.get(request.group)
        if floor is None:
            return False
        limit = max(floor[0], pose.OVERLAP_GATE_MM, *request.thresholds)
        units = {self.unit_of[index], self.need(index)}
        return all(self.lower(unit) - SLACK_MM > limit for unit in units)

    def prune_group(self, group: Hashable) -> None:
        for index in self.members[group]:
            if self.outcomes[index] is None and self.need(index) not in self.inflight and self.prunable(index):
                self.measurer.pruned += 1
                self.settle(index, Pruned(self.floor[group][1]))

    def learn(self, unit: int, outcome: tuple[float, float] | Failure) -> None:
        """A unit's outcome is known: answer what it decides, bound its group neighbours, prune."""
        self.known[unit] = outcome
        for index in self.waiting[unit]:
            if not self.resolve(index):
                self.queue(index)
        if self.prune and isinstance(outcome, tuple):
            for index in self.own[unit]:
                group = self.requests[index].group
                if group is None or self.requests[index].a_placement is not None:
                    continue
                members, at = self.members[group], self.position[index]
                for neighbour in members[max(0, at - MOTION_WINDOW):at + MOTION_WINDOW + 1]:
                    if self.outcomes[neighbour] is None:
                        for target in {self.unit_of[neighbour], self.need(neighbour)}:
                            self.bound_by_motion(unit, outcome[0], target)
                        self.touched.add(group)

    def bound_by_motion(self, unit: int, distance: float, target: int) -> None:
        shift = max(math.dist(p, q) for p, q in zip(self.placed_corners(unit), self.placed_corners(target)))
        if distance - shift > self.motion.get(target, -math.inf):
            self.motion[target] = distance - shift

    # -- scheduling ----------------------------------------------------------------------------

    def queue(self, index: int) -> None:
        """Put an open request in its group's best-first queue, keyed by its needed unit's box gap."""
        key = self.requests[index].group if self.prune else None
        heapq.heappush(self.queues[key], (self.gap(self.need(index)) if self.prune else index, index))

    def next_unit(self) -> int | None:
        """The next unit to measure: groups in turn, each its open request of the smallest box gap."""
        for _ in range(len(self.order)):
            key = self.order[self.turn % len(self.order)]
            self.turn += 1
            queue = self.queues[key]
            while queue:
                _, index = heapq.heappop(queue)
                if self.outcomes[index] is not None:
                    continue
                unit = self.need(index)
                if unit in self.inflight or unit in self.known:
                    continue
                if self.prune and self.prunable(index):
                    self.measurer.pruned += 1
                    self.settle(index, Pruned(self.floor[self.requests[index].group][1]))
                    continue
                return unit
        return None

    def execute(self, deadline: float, stop_on_failure: bool) -> None:
        if time.monotonic() > deadline:
            return
        for index in range(len(self.requests)):
            if not self.resolve(index):
                self.queue(index)
        self.order = list(self.queues)
        executor = _InProcess(self.measurer)
        while True:
            while len(self.inflight) < executor.capacity and time.monotonic() <= deadline:
                unit = self.next_unit()
                if unit is None:
                    break
                self.inflight.add(unit)
                request = self.requests[self.unit_request[unit]]
                executor.submit(unit, request, self.gap(unit))
            if not self.inflight:
                return
            unit, outcome = executor.next()
            self.inflight.discard(unit)
            self.learn(unit, outcome)
            if isinstance(outcome, Failure) and stop_on_failure:
                return
            if self.prune:
                for group in self.touched:
                    if group in self.floor:
                        self.prune_group(group)
            self.touched.clear()


class _InProcess:
    """Measures in this process, one unit at a time."""

    capacity = 1

    def __init__(self, measurer: PairMeasurer) -> None:
        self.measurer = measurer
        self.done: deque[tuple[int, tuple[float, float] | Failure]] = deque()

    def submit(self, unit: int, request: Request, box_gap: float) -> None:
        self.done.append((unit, self.measurer._measure_one(request, box_gap)))

    def next(self) -> tuple[int, tuple[float, float] | Failure]:
        return self.done.popleft()


def _bits(rigid: Any) -> bytes:
    """A placement's 12 IEEE doubles, or nothing for no placement."""
    return b"" if rigid is None else struct.pack("<12d", *rigid.rot[0], *rigid.rot[1], *rigid.rot[2], *rigid.trans)


def _moved(corners: list[tuple[float, float, float]], rigid: Any) -> list[tuple[float, float, float]]:
    return corners if rigid is None else [rigid.apply(corner) for corner in corners]


def _hull_gap(moved_a: list[tuple[float, float, float]], moved_b: list[tuple[float, float, float]]) -> float:
    """The distance between the axis-aligned hulls of two point sets."""
    total = 0.0
    for k in range(3):
        low_a, high_a = min(p[k] for p in moved_a), max(p[k] for p in moved_a)
        low_b, high_b = min(p[k] for p in moved_b), max(p[k] for p in moved_b)
        total += max(0.0, low_b - high_a, low_a - high_b) ** 2
    return math.sqrt(total)


def box_corners(shape: Any, tolerance: bool = False) -> tuple[list[float], list[float]]:
    """(min, max) corners of `shape`'s optimal bounding box from its exact geometry; with `tolerance`
    enlarged by the shape's vertex, edge and face tolerances."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, tolerance)
    low, high = box.CornerMin(), box.CornerMax()
    return [low.X(), low.Y(), low.Z()], [high.X(), high.Y(), high.Z()]
