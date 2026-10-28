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
group's minimum is usually its first measurement.

With a `PairCache`, measurements persist across runs and tools in SQLite, keyed by content: the
two definitions' BRep bytes, the placement's bits and a salt naming the measuring code, kernel and
platform (`measurement_salt`). A hit is the value the measurement returns, so the cache is on by
default; an edit to a part, the rule or the kernel only makes old entries unreachable.

`measure` returns one outcome per request, in request order: `(distance, volume)`, `Pruned`, a
`Failure` (the kernel raised; its message), or None when the deadline stopped the run first.
Stdlib only; OCP is imported when a shape is touched.
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


Outcome = tuple[float, float] | Pruned | Failure


def reading(outcome: tuple[float, float] | Pruned) -> tuple[float, float]:
    """(distance, volume) as a reduction reads it: a pruned request is infinitely far, without overlap."""
    return (math.inf, 0.0) if isinstance(outcome, Pruned) else outcome


class PairMeasurer:
    """Measures requests on `shapes` (definition key -> TopoDS_Shape), in this process or, with
    `jobs` > 1, in that many worker processes (`start_method`: forkserver, spawn on macOS and
    Windows; never fork). With `threads`, a measurement in this process searches on OCCT's thread
    pool; workers never do, as `jobs` of them already fill the cores. With `cache`, a request is
    first looked up there, and this process alone writes each new measurement to it."""

    def __init__(self, shapes: Mapping[str, Any], jobs: int = 1, start_method: str | None = None,
                 threads: bool = True, cache: PairCache | None = None) -> None:
        self.shapes = dict(shapes)
        self.jobs = jobs
        self.start_method = start_method or _default_start_method()
        self.threads = threads
        self.cache = cache
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

    def measure(self, requests: Sequence[Request], deadline: float = math.inf, stop_on_failure: bool = False,
                prune: bool = False) -> list[Outcome | None]:
        """One outcome per request, in request order; None for the requests the deadline left
        unanswered, and for those still open after a failure when `stop_on_failure`."""
        run = _Run(self, requests, prune)
        executor = (_InProcess(self.shapes, self.threads) if self.jobs <= 1
                    else _Workers(self.shapes, self.jobs, self.start_method))
        try:
            run.execute(executor, deadline, stop_on_failure)
        finally:
            executor.close()
            if self.cache is not None:
                self.cache.flush()
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

    def __init__(self, measurer: PairMeasurer, requests: Sequence[Request], prune: bool) -> None:
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

    def prune_group(self, group: Hashable) -> None:
        for index in self.members[group]:
            if self.outcomes[index] is None and self.unit_of[index] not in self.inflight and self.prunable(index):
                self.measurer.pruned += 1
                self.settle(index, Pruned(self.floor[group][1]))

    def learn(self, unit: int, outcome: tuple[float, float] | Failure) -> None:
        """A unit's outcome is known: answer its open requests, bound their group neighbours."""
        self.known[unit] = outcome
        for index in self.own[unit]:
            if self.outcomes[index] is None:
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
                if self.prune and self.prunable(index):
                    self.measurer.pruned += 1
                    self.settle(index, Pruned(self.floor[self.requests[index].group][1]))
                    continue
                return unit
        return None

    def execute(self, executor: _InProcess | _Workers, deadline: float, stop_on_failure: bool) -> None:
        if time.monotonic() > deadline:
            return
        cache, keys = self.measurer.cache, {}
        if cache is not None:
            keys = {unit: self.measurer.cache_key(self.requests[index]) for unit, index in self.unit_request.items()}
            stored = cache.lookup(list(keys.values()))
            for unit, key in keys.items():
                if key in stored:
                    self.measurer.disk_hits += 1
                    self.learn(unit, stored[key])
            self.touched.clear()
        for index in range(len(self.requests)):
            if self.outcomes[index] is None:
                self.queue(index)
        self.order = list(self.queues)
        while True:
            while len(self.inflight) < executor.capacity and time.monotonic() <= deadline:
                unit = self.next_unit()
                if unit is None:
                    break
                self.inflight.add(unit)
                self.measurer.measured += 1
                request = self.requests[self.unit_request[unit]]
                executor.submit(unit, (request.a, request.b, (request.placement.rot, request.placement.trans),
                                       self.gap(unit)))
            if not self.inflight:
                return
            unit, outcome = executor.next()
            self.inflight.discard(unit)
            if cache is not None and isinstance(outcome, tuple):
                cache.store(keys[unit], outcome)
            self.learn(unit, outcome)
            if isinstance(outcome, Failure) and stop_on_failure:
                return
            if self.prune:
                for group in self.touched:
                    if group in self.floor:
                        self.prune_group(group)
            self.touched.clear()


Task = tuple[str, str, Any, float]  # (a, b, b's placement rows, box gap)


def _measure(shapes: Mapping[str, Any], task: Task, threads: bool = False) -> tuple[float, float] | str:
    """pose.interference on one task: (distance, volume), or the kernel error's message."""
    a, b, b_rows, box_gap = task
    try:
        return pose.interference(shapes[a], pose.placed(shapes[b], pose.Rigid(*b_rows)), box_gap=box_gap,
                                 threads=threads)
    except Exception as error:  # noqa: BLE001 - OCP raises Standard_Failure on broken input
        return str(error) or type(error).__name__


def _outcome(result: tuple[float, float] | str) -> tuple[float, float] | Failure:
    return Failure(result) if isinstance(result, str) else result


class _InProcess:
    """Measures in this process, one unit at a time."""

    capacity = 1

    def __init__(self, shapes: Mapping[str, Any], threads: bool) -> None:
        self.shapes, self.threads = shapes, threads
        self.done: deque[tuple[int, tuple[float, float] | Failure]] = deque()

    def submit(self, unit: int, task: Task) -> None:
        self.done.append((unit, _outcome(_measure(self.shapes, task, self.threads))))

    def next(self) -> tuple[int, tuple[float, float] | Failure]:
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
sys.modules["cad_motion_pair_measure"]._start_worker(blobs)
"""
_WORKER_SHAPES: dict[str, Any] = {}


def _start_worker(blobs: Mapping[str, bytes]) -> None:
    from OCP.BinTools import BinTools
    from OCP.TopoDS import TopoDS_Shape

    for key, blob in blobs.items():
        shape = TopoDS_Shape()
        BinTools.Read_s(shape, io.BytesIO(blob))
        _WORKER_SHAPES[key] = shape


def _work(task: Task) -> tuple[float, float] | str:
    return _measure(_WORKER_SHAPES, task)


class _Workers:
    """Measures in `jobs` worker processes, keeping two units per worker in flight; the pool
    starts with the first unit, so a run that measures nothing starts none."""

    def __init__(self, shapes: Mapping[str, Any], jobs: int, start_method: str) -> None:
        self.shapes, self.jobs, self.start_method = shapes, jobs, start_method
        self.capacity = 2 * jobs
        self.pool: concurrent.futures.ProcessPoolExecutor | None = None
        self.pending: dict[concurrent.futures.Future, int] = {}

    def submit(self, unit: int, task: Task) -> None:
        if self.pool is None:
            blobs = {key: shape_bytes(shape) for key, shape in self.shapes.items()}
            self.pool = concurrent.futures.ProcessPoolExecutor(
                self.jobs, mp_context=multiprocessing.get_context(self.start_method), initializer=exec,
                initargs=(_WORKER_START, {"path": str(Path(__file__).resolve()), "blobs": blobs}))
        self.pending[self.pool.submit(_work, task)] = unit

    def next(self) -> tuple[int, tuple[float, float] | Failure]:
        done, _ = concurrent.futures.wait(self.pending, return_when=concurrent.futures.FIRST_COMPLETED)
        future = done.pop()
        unit = self.pending.pop(future)
        try:
            return unit, _outcome(future.result())
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
