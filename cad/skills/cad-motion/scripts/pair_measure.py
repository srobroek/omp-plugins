"""Pair measurements for cad-motion `sweep.py` and cad-model `check`.

The one measuring module of both tools. A request asks for the (minimum distance mm, overlap volume
mm^3) of two part definitions: definition `b` placed by `placement` in the frame of definition `a`.
Every measurement is pose.py's `interference` rule on the definition shapes, b moved by
`pose.placed`; nothing is copied, meshed or rebuilt per request. Each measurement is given the gap
between the two placed bounding boxes (`box_gap`), so a pair whose boxes are apart skips the
kernel's containment test, which cannot succeed there. Requests of the same two definitions at
bitwise equal placements are measured once: the key is exact, so a shared measurement is the very
value each request would get from a measurement of its own.

With `prune` (sweep), a request of a `group` (the caller's occurrence pair, whose minimum it
reduces) is not measured when a lower bound on its distance exceeds, by SLACK_MM, the group's
smallest distance known so far, OVERLAP_GATE_MM and each of its `thresholds`. Its distance then lies
above the group's final minimum and every threshold, and it has no overlap, so no reduction over the
group depends on it: it is answered `Pruned`, which reads as (inf, 0). The bounds use exact
geometry, no tessellation: the box gap, and a known distance at a nearby placement of the group
minus the farthest any corner of b's box moves between the two placements (a rigid motion's
displacement is affine in the point, so its maximum over the box is at a corner, and distance is
1-Lipschitz). The group minimum only decreases, so a skip stays valid in any measuring order.
Requests are measured best first: each group's smallest box gap first, the groups in turn, so a
group's minimum is usually its first measurement. With more than one worker, the groups of the
costliest definitions (face-count product) start first, so they do not trail the run.

Fast mode (`band`, with `prune`; sweep's default, `--exact` turns it off) answers a grouped request
`Cleared`, unmeasured, when its own lower bound exceeds OVERLAP_GATE_MM and each of its thresholds
by more than the band: the box gap, or the conservative mesh bound of `mesh_bound.py` where the
gap does not suffice. That bound and its pair, an upper bound, depend on the request alone, so
what is cleared, and every value a reduction takes from it, is the same in any measuring order.
Every request is classified before anything else answers it, a measurement from the cache or from
another request's included, so a cold and a warm cache agree too. Every measured value is still
the exact one; a cleared request reads as (inf, 0) and carries its (lower, upper) bounds for a
reduction that reports them. Every measurement is also checked against its bounds (see Suspect):
one its box gap or mesh contradicts answers nothing; it is re-measured, then read as its mesh
bounds or left a failing "suspect", and the caller must report it.

With a `PairCache`, measurements persist across runs and tools in SQLite, keyed by content: the
two definitions' BRep bytes, the placement's bits and a salt naming the measuring code, kernel and
platform (`measurement_salt`). A hit is the value the measurement returns, so the cache is on by
default; an edit to a part, the rule or the kernel only makes old entries unreachable. It is
written every CACHE_BATCH measurements, so a stopped run resumes from what it measured.

Workers die with the measuring process (`die_with`), inside a measurement too.

`measure` returns one outcome per request, in request order: `(distance, volume)`, `Pruned`,
`Cleared`, a `Failure` (the kernel raised; its message), or None when the deadline stopped the run
first. Stdlib only; OCP is imported when a shape is touched, numpy and python-fcl by `mesh_bound.py`.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import concurrent.futures.process
import functools
import hashlib
import heapq
import importlib.util
import inspect
import io
import itertools
import math
import multiprocessing
import os
import platform
import sqlite3
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
REEVALUATE_MM = 0.01  # how far a suspect's re-evaluations move b, both ways: half the default deflection
# Bump when what a measurement returns changes in a way the salt's sources and versions do not show.
MEASUREMENT_VERSION = 1
CACHE_MAX_BYTES = 256 * 2**20  # past this the oldest entries go, down to CACHE_TRIM_TO of it
CACHE_TRIM_TO = 0.75
CACHE_BATCH = 256  # entries per write transaction
AUTO_JOBS_MAX = 8  # `--jobs auto`: this many worker processes at most, about 110 MB each


@dataclass(frozen=True)
class Request:
    """Definition `b` placed by `placement` in the frame of definition `a`; `thresholds` are the
    clearance thresholds (mm) the caller compares the distance with, and `group` the requests whose
    minimum it reduces together (None: never pruned)."""

    a: str
    b: str
    placement: Any
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


@dataclass(frozen=True)
class Cleared:
    """Fast mode: a request whose own lower bound on its distance, `lower` (`by`: "box", the box
    gap, or "mesh", the mesh bound), exceeds OVERLAP_GATE_MM and each of its thresholds by more
    than the band: it has no overlap and no threshold is near, so it is not measured. `upper` bounds
    the distance from above (inf when only the box gap is known)."""

    lower: float
    upper: float
    by: str


# An exact distance this many mesh deflections from the mesh distance, or the mesh spread if larger,
# contradicts the mesh: a Suspect.
SUSPECT_DEFLECTIONS = 10


@dataclass
class Suspect:
    """A kernel measurement its own bounds contradict: its distance is below the box gap, or more
    than max(SUSPECT_DEFLECTIONS x the mesh deflection, the mesh spread) from the mesh distance
    (below it only where the mesh proves a lower bound). Its value answers nothing. Its
    re-evaluations, (label, outcome, mesh interval or None): the caller's neighbouring placements
    (sweep: every independent joint +-0.1), else b moved +-REEVALUATE_MM along (1, 1, 1)/sqrt(3),
    and the same placement with a and b swapped. `resolved` when each lies in its own mesh interval
    (the swapped one, and one without a mesh, in the suspect's [lower, upper]) and `lower` clears
    the gate and every threshold of the requests: they are answered Cleared, by "mesh (exact
    suspect)"; otherwise by "suspect", which the caller must fail."""

    requests: tuple[int, ...]
    distance: float
    volume: float
    lower: float
    upper: float
    reevaluated: list[tuple[str, tuple[float, float] | Failure, tuple[float, float, float] | None]]
    expected: int = 0
    resolved: bool | None = None


Outcome = tuple[float, float] | Pruned | Cleared | Failure


def reading(outcome: tuple[float, float] | Pruned | Cleared) -> tuple[float, float]:
    """(distance, volume) as a reduction reads it: a pruned or cleared request is infinitely far,
    without overlap."""
    return (math.inf, 0.0) if isinstance(outcome, (Pruned, Cleared)) else outcome


class PairMeasurer:
    """Measures requests on `shapes` (definition key -> TopoDS_Shape), in this process or, with
    `jobs` > 1, in that many worker processes (`start_method`: forkserver, spawn on macOS and
    Windows; never fork). With `threads`, a measurement in this process searches on OCCT's thread
    pool; workers never do, as `jobs` of them already fill the cores. With `cache`, a request is
    first looked up there, and this process alone writes each new measurement to it.

    With `band` (mm, fast mode; None: exact) a pruned `measure` clears every grouped request whose
    own lower bound exceeds its gate and thresholds by more than `band`. `mesh`
    (mesh_bound.MeshBounds, or None: the box gap alone) supplies the mesh intervals, computed with
    the measurements, in each worker by its own MeshBounds; with it every measurement that may
    decide a result is checked against its bounds (`suspects`): in fast mode each one, in exact
    mode one below a threshold or in contact without overlap."""

    def __init__(self, shapes: Mapping[str, Any], jobs: int = 1, start_method: str | None = None,
                 threads: bool = True, cache: PairCache | None = None, band: float | None = None,
                 mesh: Any = None) -> None:
        self.shapes = dict(shapes)
        self.jobs = jobs
        self.start_method = start_method or _default_start_method()
        self.threads = threads
        self.cache = cache
        self.band = band
        self.mesh = mesh
        self.identities: dict[str, bytes] = {}  # definition key -> sha256 of its BRep bytes
        self.faces: dict[str, int] = {}  # definition key -> face count
        # The corners of each definition's bounding box, enlarged by its shape tolerances: the box
        # holds the shape, so its placed corners' axis-aligned hull holds the placed shape.
        self.corners = {key: list(itertools.product(*zip(*box_corners(shape, tolerance=True))))
                        for key, shape in self.shapes.items()}
        self.requested = 0  # requests answered
        self.measured = 0  # kernel measurements
        self.reused = 0  # requests answered by a measurement taken for an earlier request
        self.pruned = 0  # requests the broad phase answered without a measurement
        self.disk_hits = 0  # measurements read from the cache
        self.cleared = {"box": 0, "mesh": 0}  # fast mode: requests cleared, by what
        self.mesh_bounds = 0  # mesh intervals computed, in whichever process
        self.mesh_seconds = 0.0  # spent on them
        self.parent_seconds = 0.0  # this process's time in `measure`, waiting for workers left out
        self.reevaluations = 0  # kernel measurements of suspects' re-evaluations
        self.suspects: list[Suspect] = []  # the last `measure` call's

    def measure(self, requests: Sequence[Request], deadline: float = math.inf, stop_on_failure: bool = False,
                prune: bool = False, neighbours: Any = None) -> list[Outcome | None]:
        """One outcome per request, in request order; None for the requests the deadline left
        unanswered, and for those still open after a failure when `stop_on_failure`.
        `neighbours(index)`, if given, lists a suspect's re-evaluation placements as (label,
        pose.Rigid) pairs."""
        self.suspects = []
        started = time.monotonic()
        run = _Run(self, requests, prune, neighbours)
        options = None if self.mesh is None else (self.mesh.linear, self.mesh.angular)
        executor = (_InProcess(self.shapes, self.mesh, self.threads) if self.jobs <= 1
                    else _Workers(self.shapes, self.jobs, self.start_method, options))
        try:
            run.execute(executor, deadline, stop_on_failure)
        finally:
            executor.close()
            if self.cache is not None:
                self.cache.flush()
            self.parent_seconds += time.monotonic() - started - run.waited
        return run.outcomes

    def moved_corners(self, request: Request) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]]:
        """(a's, b's) bounding-box corners, b's at the request's placement."""
        return self.corners[request.a], [request.placement.apply(corner) for corner in self.corners[request.b]]

    def box_gap(self, request: Request) -> float:
        """The distance between the axis-aligned hulls of the two placed bounding boxes: a lower
        bound on the distance between the placed shapes."""
        return _hull_gap(*self.moved_corners(request))

    def cache_key(self, request: Request) -> bytes:
        """sha256 of the salt, both definitions' BRep bytes and the placement's 12 doubles."""
        for key in (request.a, request.b):
            if key not in self.identities:
                self.identities[key] = hashlib.sha256(shape_bytes(self.shapes[key])).digest()
        return hashlib.sha256(measurement_salt() + self.identities[request.a] + self.identities[request.b]
                              + _bits(request.placement)).digest()

    def work(self, request: Request) -> int:
        """The product of the two definitions' face counts: how long a measurement takes, roughly."""
        for key in (request.a, request.b):
            if key not in self.faces:
                self.faces[key] = face_count(self.shapes[key])
        return self.faces[request.a] * self.faces[request.b]


class _Run:
    """One `measure` call: the requests' units (distinct exact measurements) and groups."""

    def __init__(self, measurer: PairMeasurer, requests: Sequence[Request], prune: bool, neighbours: Any) -> None:
        self.measurer, self.requests, self.prune = measurer, requests, prune
        count = len(requests)
        self.outcomes: list[Outcome | None] = [None] * count
        units: dict[tuple[str, str, bytes], int] = {}
        self.unit_of = [units.setdefault((r.a, r.b, _bits(r.placement)), len(units)) for r in requests]
        self.unit_request = {unit: index for index, unit in reversed(list(enumerate(self.unit_of)))}
        self.known: dict[int, tuple[float, float] | Failure] = {}
        self.answering: set[int] = set()  # units whose outcome answered a request
        self.own: dict[int, list[int]] = defaultdict(list)  # unit -> its requests
        for index, unit in enumerate(self.unit_of):
            self.own[unit].append(index)
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
        # Fast mode (the measurer's `band`, with prune): a request whose own lower bound clears its cap
        # is answered Cleared. A unit whose box gap leaves a grouped request within its cap is pending
        # until its mesh interval, computed with its measurement, comes back; nothing answers it before.
        self.band = measurer.band if prune else None
        self.meshing = measurer.mesh is not None
        self.neighbours = neighbours or self.translated
        self.interval: dict[int, tuple[float, float, float]] = {}  # unit -> mesh (lower, upper, spread)
        self.near: set[int] = set()  # requests fast mode found within their cap
        self.stored: dict[int, tuple[float, float]] = {}  # pending units' cache hits
        self.keys: dict[int, bytes] = {}  # unit -> cache key
        self.extra: deque[tuple[int, Task]] = deque()  # suspects' re-evaluations waiting for a worker
        self.extra_of: dict[int, tuple[Suspect, str, int]] = {}  # task id beyond the units -> (suspect, label, unit)
        self.next_id = len(self.unit_request)
        self.waited = 0.0  # seconds this process waited for a result

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
        """The unit's lower bound for pruning: its box gap, a nearby measurement's motion bound, and in
        fast mode its mesh bound less the band, so a request the mesh alone puts beyond its group
        minimum is still measured inside the band, as clearing would measure it."""
        own = self.gap(unit)
        if self.band is not None and unit in self.interval:
            own = max(own, self.interval[unit][0] - self.band)
        return max(own, self.motion.get(unit, -math.inf))

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
        return self.lower(self.unit_of[index]) - SLACK_MM > max(floor[0], pose.OVERLAP_GATE_MM, *request.thresholds)

    def cap(self, index: int) -> float:
        """Fast mode: the distance beyond which a request is cleared, its gate or largest threshold
        plus the band."""
        return max((pose.OVERLAP_GATE_MM, *self.requests[index].thresholds)) + self.band

    def grouped(self, unit: int) -> list[int]:
        return [index for index in self.own[unit] if self.requests[index].group is not None]

    def pending(self, unit: int) -> bool:
        """Fast mode: whether the unit waits for its mesh interval: none is known, and the box gap
        leaves a grouped request of it within its cap."""
        return (self.meshing and unit not in self.interval
                and any(self.gap(unit) - SLACK_MM <= self.cap(index) for index in self.grouped(unit)))

    def own_bound(self, unit: int) -> tuple[float, float, str]:
        """The unit's own (lower, upper) bounds on its distance and what proved the lower: the box
        gap, raised by the mesh interval where one is known. Both depend on the unit alone, never on
        what was measured first, so a fast run clears the same requests in any order."""
        gap = self.gap(unit)
        if unit in self.interval:
            lower, upper, _ = self.interval[unit]
            return (lower, upper, "mesh") if lower > gap else (gap, upper, "box")
        return gap, math.inf, "box"

    def clear(self, index: int) -> bool | None:
        """Fast mode: answer the open request `index` Cleared when its unit's own lower bound
        exceeds its cap by SLACK_MM: True; False when it does not; None while its unit is pending."""
        if self.band is None or self.requests[index].group is None or index in self.near:
            return False
        unit = self.unit_of[index]
        if self.pending(unit):
            return None
        lower, upper, by = self.own_bound(unit)
        if lower - SLACK_MM > self.cap(index):
            self.measurer.cleared[by] += 1
            self.settle(index, Cleared(lower, upper, by))
            return True
        self.near.add(index)
        return False

    def suspicious(self, unit: int, distance: float) -> bool:
        """Whether a measured distance contradicts the unit's own bounds (see Suspect)."""
        if distance < self.gap(unit) - SLACK_MM:
            return True
        if unit not in self.interval:
            return False
        lower, upper, spread = self.interval[unit]
        estimate = upper - spread
        tolerance = max(SUSPECT_DEFLECTIONS * self.measurer.mesh.linear, spread)
        return distance > estimate + tolerance or (lower > 0.0 and distance < estimate - tolerance)

    def suspect(self, unit: int, outcome: tuple[float, float]) -> None:
        """Hold the unit's requests and queue the re-evaluations of its suspect measurement."""
        lower, upper, _ = self.own_bound(unit)
        suspect = Suspect(tuple(self.own[unit]), outcome[0], outcome[1], lower, upper, [])
        self.measurer.suspects.append(suspect)
        index = self.unit_request[unit]
        request = self.requests[index]
        tasks = [(label, request.a, request.b, placement, ("both",)) for label, placement in self.neighbours(index)]
        tasks.append(("swapped", request.b, request.a, request.placement.inverse(), ("plain",)))
        suspect.expected = len(tasks)
        for label, a, b, placement, mode in tasks:
            self.extra_of[self.next_id] = (suspect, label, unit)
            self.extra.append((self.next_id, (a, b, (placement.rot, placement.trans), 0.0, mode)))
            self.next_id += 1

    def translated(self, index: int) -> list[tuple[str, Any]]:
        """The default re-evaluation placements: b moved +-REEVALUATE_MM along (1, 1, 1)/sqrt(3)."""
        placement = self.requests[index].placement
        moved = []
        for shift in (REEVALUATE_MM, -REEVALUATE_MM):
            step = shift / math.sqrt(3.0)
            moved.append((f"{shift:+g} mm", pose.Rigid(placement.rot, tuple(v + step for v in placement.trans))))
        return moved

    def reevaluated(self, task_id: int, result: Any, interval: tuple[float, float, float] | None) -> None:
        """A suspect's re-evaluation is back; with the last, resolve the suspect and answer its requests."""
        suspect, label, unit = self.extra_of.pop(task_id)
        suspect.reevaluated.append((label, _outcome(result), interval))
        if len(suspect.reevaluated) < suspect.expected:
            return

        def agrees(outcome: Any, bounds: tuple[float, float, float] | None) -> bool:
            low, high = (bounds[0], bounds[1]) if bounds is not None else (suspect.lower, suspect.upper)
            return isinstance(outcome, tuple) and low - SLACK_MM <= outcome[0] <= high + SLACK_MM

        consistent = all(agrees(outcome, bounds) for _, outcome, bounds in suspect.reevaluated)
        margin = self.band if self.band is not None else EXACT_RESOLVE_BAND_MM  # as clearing requires
        decided = all(suspect.lower - SLACK_MM > max((pose.OVERLAP_GATE_MM, *self.requests[index].thresholds)) + margin
                      for index in self.own[unit])
        suspect.resolved = consistent and decided
        by = "mesh (exact suspect)" if suspect.resolved else "suspect"
        for index in self.own[unit]:
            if self.outcomes[index] is None:
                self.settle(index, Cleared(suspect.lower, suspect.upper, by))

    def prune_group(self, group: Hashable) -> None:
        for index in self.members[group]:
            if self.outcomes[index] is None and self.unit_of[index] not in self.inflight \
                    and self.clear(index) is False and self.prunable(index):
                self.measurer.pruned += 1
                self.settle(index, Pruned(self.floor[group][1]))

    def classify(self, unit: int) -> None:
        """Fast mode: the unit's mesh interval came back without a measurement: answer the requests
        it clears or proves prunable, and queue the rest to be measured."""
        for index in self.own[unit]:
            if self.outcomes[index] is not None or self.clear(index):
                continue
            if self.prunable(index):
                self.measurer.pruned += 1
                self.settle(index, Pruned(self.floor[self.requests[index].group][1]))
                continue
            if self.requests[index].group not in self.queues:
                self.order.append(self.requests[index].group)
            self.queue(index)

    def learn(self, unit: int, outcome: tuple[float, float] | Failure, store: bool = False) -> None:
        """A unit's outcome is known: hold it as a suspect, else write it to the cache (`store`),
        answer its open requests and bound their group neighbours."""
        if self.meshing and isinstance(outcome, tuple) and self.suspicious(unit, outcome[0]):
            self.suspect(unit, outcome)
            return
        if store and self.measurer.cache is not None and isinstance(outcome, tuple):
            self.measurer.cache.store(self.keys[unit], outcome)
        self.known[unit] = outcome
        for index in self.own[unit]:
            if self.outcomes[index] is None and not self.clear(index):
                if unit in self.answering:
                    self.measurer.reused += 1
                self.answering.add(unit)
                self.settle(index, outcome)
        if self.prune and isinstance(outcome, tuple):
            for index in self.own[unit]:
                group = self.requests[index].group
                if group is None:
                    continue
                members, at = self.members[group], self.position[index]
                for neighbour in members[max(0, at - MOTION_WINDOW):at + MOTION_WINDOW + 1]:
                    if self.outcomes[neighbour] is None:
                        self.bound_by_motion(unit, outcome[0], self.unit_of[neighbour])
                        self.touched.add(group)

    def bound_by_motion(self, unit: int, distance: float, target: int) -> None:
        shift = max(math.dist(p, q) for p, q in zip(self.placed_corners(unit), self.placed_corners(target)))
        if distance - shift > self.motion.get(target, -math.inf):
            self.motion[target] = distance - shift

    # -- scheduling ----------------------------------------------------------------------------

    def queue(self, index: int) -> None:
        """Put an open request in its queue: its group's, keyed by its unit's box gap, when pruning;
        else the one queue, longest first across workers and in request order in this process."""
        request = self.requests[index]
        if self.prune:
            heapq.heappush(self.queues[request.group], (self.gap(self.unit_of[index]), index))
        else:
            heapq.heappush(self.queues[None], (-self.measurer.work(request) if self.measurer.jobs > 1 else 0, index))

    def next_unit(self) -> int | None:
        """The next unit to measure: groups in turn, each its open request of the smallest box gap."""
        for _ in range(len(self.order)):
            key = self.order[self.turn % len(self.order)]
            self.turn += 1
            queue = self.queues[key]
            while queue:
                _, index = heapq.heappop(queue)
                unit = self.unit_of[index]
                if self.outcomes[index] is not None or unit in self.inflight:
                    continue
                verdict = self.clear(index)
                if verdict:
                    continue
                if verdict is False and self.prune and self.prunable(index):
                    self.measurer.pruned += 1
                    self.settle(index, Pruned(self.floor[self.requests[index].group][1]))
                    continue
                return unit
        return None

    def task(self, unit: int) -> Task:
        """The unit's task (see _run_task): a pending unit's mesh interval first, its measurement
        skipped where the interval clears every request or proves each prunable, and always for a
        cache hit; in exact mode with a mesh, the interval after every measurement."""
        request = self.requests[self.unit_request[unit]]
        if self.band is not None and self.pending(unit):
            limit = math.inf
            if all(self.requests[index].group in self.floor for index in self.own[unit]):
                limit = self.band + max(max(self.floor[self.requests[index].group][0], pose.OVERLAP_GATE_MM,
                                            *self.requests[index].thresholds) for index in self.own[unit])
            mode: tuple = ("fast", max(self.cap(index) for index in self.grouped(unit)), limit, unit not in self.stored)
        elif self.band is None and self.meshing:
            mode = ("both",)
        else:
            mode = ("plain",)
        return request.a, request.b, (request.placement.rot, request.placement.trans), self.gap(unit), mode

    def execute(self, executor: _InProcess | _Workers, deadline: float, stop_on_failure: bool) -> None:
        if time.monotonic() > deadline:
            return
        cache = self.measurer.cache
        if cache is not None:
            self.keys = {unit: self.measurer.cache_key(self.requests[index]) for unit, index in self.unit_request.items()}
            stored = cache.lookup(list(self.keys.values()))
            for unit, key in self.keys.items():
                if key in stored:
                    self.measurer.disk_hits += 1
                    if self.band is not None and self.pending(unit):
                        self.stored[unit] = stored[key]  # answered once its interval classifies it
                    else:
                        self.learn(unit, stored[key])
            self.touched.clear()
        for index in range(len(self.requests)):
            if self.outcomes[index] is None:
                self.queue(index)
        self.order = list(self.queues)
        if self.prune and self.measurer.jobs > 1:  # the costliest groups start first, shortening the tail
            self.order.sort(key=lambda group: -self.measurer.work(self.requests[self.queues[group][0][1]]))
        while True:
            while len(self.inflight) < executor.capacity and time.monotonic() <= deadline:
                if self.extra:
                    task_id, task = self.extra.popleft()
                    self.inflight.add(task_id)
                    self.measurer.reevaluations += 1
                    executor.submit(task_id, task)
                    continue
                unit = self.next_unit()
                if unit is None:
                    break
                self.inflight.add(unit)
                executor.submit(unit, self.task(unit))
            if not self.inflight:
                return
            waiting = time.monotonic()
            unit, (result, interval, seconds) = executor.next()
            self.waited += time.monotonic() - waiting
            self.inflight.discard(unit)
            self.measurer.mesh_seconds += seconds
            self.measurer.mesh_bounds += interval is not None
            if unit in self.extra_of:
                self.reevaluated(unit, result, interval)
                continue
            if interval is not None:
                self.interval[unit] = interval
            if result is not None:
                self.measurer.measured += 1
                outcome = _outcome(result)
                self.learn(unit, outcome, store=True)
                if isinstance(outcome, Failure) and stop_on_failure:
                    return
            elif unit in self.stored:
                self.learn(unit, self.stored.pop(unit))
            else:
                self.classify(unit)
            if self.prune:
                for group in self.touched:
                    if group in self.floor:
                        self.prune_group(group)
            self.touched.clear()


Task = tuple[str, str, Any, float, tuple]  # (a, b, b's placement rows, box gap, mode)
# (the measurement, the kernel error's message or None when skipped; the mesh interval (lower, upper,
# spread) or None; seconds spent on the interval)
Result = tuple[Any, Any, float]


def _measure(shapes: Mapping[str, Any], a: str, b: str, placement: Any, box_gap: float,
             threads: bool = False) -> tuple[float, float] | str:
    """pose.interference of definition a and definition b at `placement` in a's frame: (distance,
    volume), or the kernel error's message."""
    try:
        return pose.interference(shapes[a], pose.placed(shapes[b], placement), box_gap=box_gap, threads=threads)
    except Exception as error:  # noqa: BLE001 - OCP raises Standard_Failure on broken input
        return str(error) or type(error).__name__


# An exact-mode suspect reads as its mesh bounds only where they clear its thresholds by this much,
# fast mode's default band.
EXACT_RESOLVE_BAND_MM = 2.0


def _interval(mesh: Any, a: str, b: str, placement: Any) -> tuple[tuple[float, float, float], float]:
    started = time.perf_counter()
    lower, upper = mesh.interval(a, b, placement)
    return (lower, upper, mesh.spread(a, b)), time.perf_counter() - started


def _run_task(shapes: Mapping[str, Any], mesh: Any, task: Task, threads: bool = False) -> Result:
    """One task. Mode ("plain",) measures; ("both",) measures and computes the mesh interval;
    ("fast", cap, limit, measure) computes the interval first and skips the measurement where its
    lower bound exceeds the cap or the prune limit by SLACK_MM, or where `measure` is false."""
    a, b, rows, box_gap, mode = task
    placement = pose.Rigid(*rows)
    interval, seconds = None, 0.0
    if mesh is not None and mode[0] in ("fast", "both"):
        interval, seconds = _interval(mesh, a, b, placement)
        if mode[0] == "fast" and (not mode[3] or interval[0] - SLACK_MM > min(mode[1], mode[2])):
            return None, interval, seconds
    result = _measure(shapes, a, b, placement, box_gap, threads)
    return result, interval, seconds


def _outcome(result: tuple[float, float] | str) -> tuple[float, float] | Failure:
    return Failure(result) if isinstance(result, str) else result


class _InProcess:
    """Runs tasks in this process, one at a time."""

    capacity = 1

    def __init__(self, shapes: Mapping[str, Any], mesh: Any, threads: bool) -> None:
        self.shapes, self.mesh, self.threads = shapes, mesh, threads
        self.done: deque[tuple[int, Result]] = deque()

    def submit(self, unit: int, task: Task) -> None:
        self.done.append((unit, _run_task(self.shapes, self.mesh, task, self.threads)))

    def next(self) -> tuple[int, Result]:
        return self.done.popleft()

    def close(self) -> None:
        pass


# A worker loads this module by path (the parent may have loaded it under any main module) and
# rebuilds the definitions from BinTools bytes, as a TopoDS_Shape does not pickle.
_WORKER_START = """
import importlib.util, sys
if "cad_motion_pair_measure" not in sys.modules:
    spec = importlib.util.spec_from_file_location("cad_motion_pair_measure", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
sys.modules["cad_motion_pair_measure"]._start_worker(blobs, parent, mesh)
"""
_WORKER_SHAPES: dict[str, Any] = {}
_WORKER_MESH: Any = None  # this worker's mesh_bound.MeshBounds, built in its initializer
# The watchdog of a worker where the kernel offers no parent-death signal: kqueue reports the exit
# of the measuring process or of the worker, whichever is first; the first kills the worker.
_WATCHDOG = """
import os, select, signal, sys
parent, worker = int(sys.argv[1]), int(sys.argv[2])
queue = select.kqueue()
try:
    for pid in (worker, parent):
        queue.control([select.kevent(pid, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                     select.KQ_NOTE_EXIT)], 0)
    ended = queue.control(None, 1)[0].ident
except ProcessLookupError:
    ended = parent
if ended == parent:
    try:
        os.kill(worker, signal.SIGKILL)
    except ProcessLookupError:
        pass
"""


def _start_worker(blobs: Mapping[str, bytes], parent: int, mesh: tuple[float, float] | None) -> None:
    """A worker's initializer: die with `parent`, rebuild the definitions and, with `mesh` (linear,
    angular deflections), build the worker's own MeshBounds over them, meshing each on first use."""
    global _WORKER_MESH
    from OCP.BinTools import BinTools
    from OCP.TopoDS import TopoDS_Shape

    die_with(parent)
    for key, blob in blobs.items():
        shape = TopoDS_Shape()
        BinTools.Read_s(shape, io.BytesIO(blob))
        _WORKER_SHAPES[key] = shape
    if mesh is not None:
        name = "cad_motion_mesh_bound"
        module = sys.modules.get(name) or _load(name, Path(__file__).with_name("mesh_bound.py"))
        _WORKER_MESH = module.MeshBounds(_WORKER_SHAPES, *mesh)


def die_with(parent: int) -> None:
    """End this process when process `parent` ends, even inside a measurement, so a stopped or
    killed sweep leaves no worker measuring on. On Linux the kernel sends SIGTERM when this
    process's parent exits (prctl PR_SET_PDEATHSIG): `parent` itself, or the forkserver that
    forked it, which exits with `parent`; a parent already gone ends it at once. On macOS and the
    BSDs a watchdog process (`_WATCHDOG`) waits on kqueue for either exit and kills this process
    with SIGKILL. Not a thread: an OCCT call may hold the interpreter lock for its whole run.
    Elsewhere (Windows) nothing is armed."""
    if sys.platform.startswith("linux"):
        import ctypes
        import signal

        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:  # 1: PR_SET_PDEATHSIG
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG) failed")
        if not _alive(parent):
            os._exit(1)
    elif hasattr(__import__("select"), "kqueue"):
        import subprocess

        subprocess.Popen([sys.executable, "-c", _WATCHDOG, str(parent), str(os.getpid())],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # another user's process now holds the id
        return True
    return True


def _work(task: Task) -> Result:
    return _run_task(_WORKER_SHAPES, _WORKER_MESH, task)


class _Workers:
    """Runs tasks in `jobs` worker processes, keeping two per worker in flight; the pool starts
    with the first task, so a run that measures nothing starts none."""

    def __init__(self, shapes: Mapping[str, Any], jobs: int, start_method: str,
                 mesh: tuple[float, float] | None) -> None:
        self.shapes, self.jobs, self.start_method, self.mesh = shapes, jobs, start_method, mesh
        self.capacity = 2 * jobs
        self.pool: concurrent.futures.ProcessPoolExecutor | None = None
        self.pending: dict[concurrent.futures.Future, int] = {}

    def submit(self, unit: int, task: Task) -> None:
        if self.pool is None:
            blobs = {key: shape_bytes(shape) for key, shape in self.shapes.items()}
            self.pool = concurrent.futures.ProcessPoolExecutor(
                self.jobs, mp_context=multiprocessing.get_context(self.start_method), initializer=exec,
                initargs=(_WORKER_START, {"path": str(Path(__file__).resolve()), "blobs": blobs,
                                          "parent": os.getpid(), "mesh": self.mesh}))
        self.pending[self.pool.submit(_work, task)] = unit

    def next(self) -> tuple[int, Result]:
        done, _ = concurrent.futures.wait(self.pending, return_when=concurrent.futures.FIRST_COMPLETED)
        future = done.pop()
        unit = self.pending.pop(future)
        try:
            return unit, future.result()
        except concurrent.futures.process.BrokenProcessPool as error:
            raise pose.MotionError(f"a pair measuring worker process died: {error}") from error

    def close(self) -> None:
        if self.pool is not None:
            self.pool.shutdown(wait=True, cancel_futures=True)


class PairCache:
    """Measurements kept across runs in `directory`/pairs.sqlite: key -> (distance, volume) as two
    little-endian doubles, so a hit returns the measured bits. Keys are content addresses
    (`PairMeasurer.cache_key`), so a changed definition, rule or kernel only stops finding the old
    entries; failures are never stored. Writes go in batches with INSERT OR IGNORE in WAL mode, so
    concurrent runs share the file. Past `max_bytes` of live pages the oldest entries are deleted
    down to CACHE_TRIM_TO of it. Any SQLite or file error turns the cache off for the rest of the
    run with a note on stderr, and the run measures what it would have read."""

    def __init__(self, directory: Path, max_bytes: int = CACHE_MAX_BYTES) -> None:
        self.path = directory / "pairs.sqlite"
        self.max_bytes = max_bytes
        self.pending: list[tuple[bytes, bytes]] = []
        self.connection: sqlite3.Connection | None = None
        try:
            directory.mkdir(parents=True, exist_ok=True)
            self.connection = sqlite3.connect(self.path, timeout=60.0)
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=NORMAL")
            with self.connection:
                self.connection.execute("CREATE TABLE IF NOT EXISTS pairs (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                                        "key BLOB NOT NULL UNIQUE, value BLOB NOT NULL)")
        except (sqlite3.Error, OSError) as error:
            self._off(error)

    def lookup(self, keys: Sequence[bytes]) -> dict[bytes, tuple[float, float]]:
        """The stored (distance, volume) of each key found."""
        if self.connection is None:
            return {}
        found: dict[bytes, tuple[float, float]] = {}
        try:
            for start in range(0, len(keys), 500):
                chunk = keys[start:start + 500]
                rows = self.connection.execute(
                    f"SELECT key, value FROM pairs WHERE key IN ({', '.join('?' * len(chunk))})", chunk)
                found.update((bytes(key), struct.unpack("<2d", value)) for key, value in rows)
        except (sqlite3.Error, struct.error, TypeError) as error:
            self._off(error)
            return {}
        return found

    def store(self, key: bytes, outcome: tuple[float, float]) -> None:
        if self.connection is not None:
            self.pending.append((key, struct.pack("<2d", *outcome)))
            if len(self.pending) >= CACHE_BATCH:
                self.flush()

    def flush(self) -> None:
        """Write the pending entries, then hold the size cap."""
        if self.connection is None or not self.pending:
            return
        try:
            with self.connection:
                self.connection.executemany("INSERT OR IGNORE INTO pairs (key, value) VALUES (?, ?)", self.pending)
            self.pending.clear()
            page_size, pages, free = (self.connection.execute(f"PRAGMA {name}").fetchone()[0]
                                      for name in ("page_size", "page_count", "freelist_count"))
            live = (pages - free) * page_size
            if live > self.max_bytes:
                rows = self.connection.execute("SELECT COUNT(*) FROM pairs").fetchone()[0]
                with self.connection:
                    self.connection.execute("DELETE FROM pairs WHERE id NOT IN (SELECT id FROM pairs ORDER BY id DESC "
                                            "LIMIT ?)", (int(rows * CACHE_TRIM_TO * self.max_bytes / live),))
        except sqlite3.Error as error:
            self._off(error)

    def close(self) -> None:
        """Write the pending entries and close the file."""
        self.flush()
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def _off(self, error: BaseException) -> None:
        print(f"pair cache {self.path} is unusable, measuring without it: {error}", file=sys.stderr)
        if self.connection is not None:
            try:
                self.connection.close()
            except sqlite3.Error:
                pass
        self.connection = None
        self.pending.clear()


def default_cache_dir() -> Path:
    """`$XDG_CACHE_HOME/cad-motion`, else `~/.cache/cad-motion`: the cache home of cad-concept and cad-flow."""
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "cad-motion"


@functools.cache
def measurement_salt() -> bytes:
    """What a measurement's value depends on besides its two shapes and the placement: the
    MEASUREMENT_VERSION, the source of every function on the measuring path, the rule's constants,
    the OCP/OCCT version, and the platform, as the Mac and Linux libm may round differently."""
    import OCP

    path = (_measure, pose.placed, pose.to_trsf, pose.interference, pose._contained, pose._inside_compound,
            pose._vertex_points, pose._one_member_compound, pose.shape_list, pose.volume_properties)
    constants = (pose.OVERLAP_GATE_MM, pose.FUZZY_MM, pose.VOLUME_EPS, pose.CONTAINMENT_TOL_MM, pose.SOLID_GAP_MM)
    parts = [f"cad-motion pair measurement {MEASUREMENT_VERSION}", repr(constants), getattr(OCP, "__version__", "?"),
             sys.platform, platform.machine(), *(inspect.getsource(function) for function in path)]
    return hashlib.sha256("\0".join(parts).encode()).digest()


def jobs_argument(text: str) -> int:
    """A `--jobs` value: a positive count, or `auto`, the CPU count capped at AUTO_JOBS_MAX."""
    if text == "auto":
        return max(1, min(os.cpu_count() or 1, AUTO_JOBS_MAX))
    if not text.isdigit() or int(text) < 1:
        raise argparse.ArgumentTypeError(f"expected auto or a positive integer, got {text!r}")
    return int(text)


def _default_start_method() -> str:
    """forkserver, or spawn where Python itself defaults to it (macOS, Windows); never fork: forking
    a process whose OCCT thread pool runs can deadlock the child, and spawn and forkserver children
    start clean."""
    return "spawn" if sys.platform in ("darwin", "win32") else "forkserver"


def shape_bytes(shape: Any) -> bytes:
    """`shape` in OCCT's binary BRep format, without triangulation."""
    from OCP.BinTools import BinTools, BinTools_FormatVersion

    buffer = io.BytesIO()
    BinTools.Write_s(shape, buffer, False, False, BinTools_FormatVersion.BinTools_FormatVersion_CURRENT)
    return buffer.getvalue()


def _bits(rigid: Any) -> bytes:
    """A placement's 12 IEEE doubles: the exact measurement key."""
    return struct.pack("<12d", *rigid.rot[0], *rigid.rot[1], *rigid.rot[2], *rigid.trans)


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


def face_count(shape: Any) -> int:
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    explorer, count = TopExp_Explorer(shape, TopAbs_FACE), 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count
