"""Pair measurements for cad-motion `sweep.py` and cad-model `check`: the one evaluator of both.

A request asks for the (minimum distance mm, overlap volume mm^3) of two part definitions:
definition `b` placed by `placement` in the frame of definition `a`. Every measurement is pose.py's
`interference` rule on the definition shapes, b moved by `pose.placed`; nothing is copied, meshed
or rebuilt per request. Each measurement is given the gap between the two placed exact bounding
boxes, so a pair whose boxes are apart skips the kernel's containment test, which cannot succeed
there.

Identity. Each definition has a geometry identity (pose.geometry_ids: its STEP DATA hash, else a
BRep hash) and the rule its RuleVersion digest. Before anything is evaluated a request is put in
canonical operand order, the smaller (geometry id, placement bits) first, the placement inverted
when b goes first, so (a, b, T) and (b, a, T^-1) are one evaluation whichever a caller asks.
Requests of the same canonical definitions at bitwise equal placements are one unit, evaluated
once. A unit's exact fingerprint hashes its placement's 12 doubles; its bucket rounds the rotation
to ROTATION_QUANTUM and the translation to TRANSLATION_QUANTUM_MM, -0 as 0.

Outcomes. `MeasurementSession.measure` answers each request, in request order, with:
- Measured: a validated kernel reading, IEEE bits preserved;
- Cleared: the request's own distance interval [lower_mm, upper_mm], whose lower end exceeds its
  cap, so it has no overlap and no requirement is near: proved by the box gap, the mesh bound
  (mesh_bound.py), a resolved suspect's bounds, or a cached interval ("cache-bound");
- Pruned: with `prune`, a grouped request whose certified lower bound exceeds, by SLACK_MM, its
  group's smallest distance known so far, the overlap gate and its minimum_mm;
- Failure: the kernel raised, or a suspect stayed unresolved;
- None: the deadline stopped the run first.

Modes. A "sample" request (fast mode) is Cleared when its own lower bound exceeds its cap,
max(OVERLAP_GATE_MM, minimum_mm) plus the rule's band, by SLACK_MM; an "exact" one is never Cleared;
a "bound" one (a between-sample midpoint) is Cleared when its own lower bound exceeds the gate, so
it does not touch, and measured otherwise. A request with `require_exact` is always measured. A unit
whose bounds without a mesh leave a clearable request within its cap is pending until its mesh bound
comes back; nothing answers its requests before, and every request is classified before a reading
answers it, so what is cleared depends on the request and what the cache holds, not on the
measuring order.

Pruning (sweep): a lower bound is the box gap, a known distance at a nearby placement of the group
minus the farthest any corner of b's box moves between the two placements (a rigid motion's
displacement is affine in the point, so its maximum over the box is at a corner, and distance is
1-Lipschitz), and outside exact mode the mesh or cached bound less the band. The group minimum only
decreases, so a skip stays valid in any measuring order. Requests are measured best first: each
group's smallest box gap first, the groups in turn.

Suspects. Every kernel reading is checked against its own bounds: below a box gap, more than
max(SUSPECT_DEFLECTIONS x the mesh deflection, both deviations) above the mesh distance, or as far
below it where the mesh rules containment out. A suspect answers nothing and is never stored. It is
re-evaluated at the caller's neighbouring placements (sweep: every independent joint +-0.1), else
with b moved +-REEVALUATE_MM along (1, 1, 1)/sqrt(3), and with a and b swapped. It resolves when
each re-evaluation lies in its own bounds and its own lower bound exceeds the gate, minimum_mm and
band of each request: those are Cleared "mesh (exact suspect)", and the resolution is cached with
its provenance (a warm run reports it again); otherwise they fail. An exact-required request of a
suspect always fails.

Cache (PairCache, by default hw/.cad/pairs-v2.sqlite). Exact readings are keyed by the geometry
ids, rule and exact fingerprint, independent of any policy. Decisions (mesh bounds, resolved
suspects) by a key of the geometry ids, rounded placement, minimum_mm, rule and mode, plus the
exact fingerprint. What the cache holds at the exact fingerprint is the stored value itself. A row
in the same bucket at another placement is never exact: its interval, widened by the farthest any
corner of b's exact box moves between the two placements, may clear a request "cache-bound";
otherwise the request is evaluated. Each task's results are committed before its requests are
reported to `on_chunk`, so a stopped run resumes from what it committed.

Workers. With `jobs` > 1 a session runs one pool of worker processes (spawn on macOS and Windows,
forkserver elsewhere; never fork) for its lifetime. Each loads the definitions and the parent's
mesh assets once, dies with the measuring process, and runs tasks of at most CHUNK_REQUESTS units,
costliest first by the cache's per-pair cost (face counts while unseen). Results commit in the
parent and outcomes are indexed by request, so completion order changes no outcome. The deadline
terminates the workers; a worker's death is an error.

Stdlib only; OCP is imported when a shape is touched, numpy and python-fcl by `mesh_bound.py`.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import concurrent.futures.process
import dataclasses
import functools
import hashlib
import heapq
import importlib.metadata
import importlib.util
import io
import itertools
import json
import math
import multiprocessing
import os
import platform
import shutil
import sqlite3
import struct
import sys
import tempfile
import time
from collections import defaultdict, deque
from collections.abc import Callable, Hashable, Mapping, Sequence
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
LIFECYCLE_PATH = Path(__file__).resolve().parents[2] / "cad-flow" / "scripts" / "process_lifecycle.py"

SLACK_MM = 1e-6  # under every lower bound: 10x the kernel's confusion tolerance, for rounding in the bounds
MOTION_WINDOW = 6  # a known distance bounds the requests this many places either side in its group
REEVALUATE_MM = 0.01  # how far a suspect's re-evaluations move b, both ways: half the default deflection
# An exact distance this many mesh deflections from the mesh distance, or both deviations if more,
# contradicts the mesh: a Suspect.
SUSPECT_DEFLECTIONS = 10
MESH_BAND_MM = 2.0  # fast mode's default band (sweep --mesh-band), part of the rule
# Bump when what an evaluation returns changes in a way the rule's sources and versions do not show.
RULE_REVISION = 1
SCHEMA_VERSION = 2  # of pairs-v2.sqlite
ROTATION_QUANTUM = 1e-7  # a bucket's rotation-matrix entry step
TRANSLATION_QUANTUM_MM = 1e-5  # a bucket's translation step
CHUNK_REQUESTS = 24  # units per worker task at most
MODES = ("sample", "exact", "bound")
SUSPECT_METHOD = "mesh (exact suspect)"
CACHE_FILE = "pairs-v2.sqlite"
CACHE_MAX_BYTES = 256 * 2**20  # past this the oldest rows go, down to CACHE_TRIM_TO of it
CACHE_TRIM_TO = 0.75
CACHE_TRIM_EVERY = 32  # commits between size checks
AUTO_JOBS_MAX = 8  # `--jobs auto`: this many worker processes at most, about 110 MB each
_EXACT_TAG = b"cad-motion pair exact fingerprint v2\0"
_BUCKET_TAG = b"cad-motion pair bucket v2\0"
_DECISION_TAG = b"cad-motion pair decision v2\0"


# --------------------------------------------------------------------------- records


@dataclass(frozen=True)
class Request:
    """Definition `b` placed by `placement` (pose.Rigid) in the frame of definition `a`.

    `group`: the requests whose minimum it reduces together (the caller's occurrence pair; None:
    never pruned). `sample_id`: the caller's sample, for reports. `mode`: "sample", "exact" or
    "bound" (see the module). `box_gap_mm`: a lower bound the caller proved on the distance
    (mesh_bound.box_gap of posed boxes); None: the measurer's own exact-box gap. `minimum_mm`: the
    greatest requirement that applies to the pair. `require_exact`: answer Measured only.
    """

    a: str
    b: str
    placement: Any
    group: Hashable | None = None
    sample_id: str | None = None
    mode: str = "sample"
    box_gap_mm: float | None = None
    minimum_mm: float = 0.0
    require_exact: bool = False

    def __post_init__(self) -> None:
        if self.mode not in MODES:
            raise ValueError(f"request mode {self.mode!r} is not one of {', '.join(MODES)}")
        if not (math.isfinite(self.minimum_mm) and self.minimum_mm >= 0.0):
            raise ValueError(f"request minimum_mm must be a finite number >= 0, got {self.minimum_mm!r}")

    @property
    def decision_mode(self) -> str:
        """The mode a decision about this request is keyed by."""
        return "required" if self.require_exact else self.mode


@dataclass(frozen=True)
class Measured:
    """A validated kernel reading. `seconds` (the kernel's time) is not part of equality."""

    distance_mm: float
    overlap_mm3: float
    seconds: float = field(default=0.0, compare=False)
    method: str = "exact"


@dataclass(frozen=True)
class Cleared:
    """The request's own interval on its distance, no overlap, unmeasured; `method`: "box",
    "mesh", SUSPECT_METHOD or "cache-bound". `upper_mm` is inf when only a lower bound is known;
    `mesh_mm` the mesh distance and `deviation_mm` both meshes' deviations where a mesh bound took
    part. `seconds` (the mesh query's time) is not part of equality."""

    lower_mm: float
    upper_mm: float
    method: str
    mesh_mm: float | None = None
    deviation_mm: float = 0.0
    seconds: float = field(default=0.0, compare=False)


@dataclass(frozen=True)
class Pruned:
    """A request proved farther than its group's minimum (that of request `witness_request` then),
    the gate and its minimum_mm by its certified lower bound `lower_mm`."""

    witness_request: int
    lower_mm: float


@dataclass(frozen=True)
class Failure:
    """A request the kernel could not measure (the error's message, else its type name), or whose
    reading is an unresolved suspect."""

    message: str


Outcome = Measured | Cleared | Pruned | Failure


def reading(outcome: Measured | Cleared | Pruned) -> tuple[float, float]:
    """(distance, volume) as a reduction reads it: a cleared or pruned request is infinitely far,
    without overlap."""
    if isinstance(outcome, Measured):
        return outcome.distance_mm, outcome.overlap_mm3
    if isinstance(outcome, (Cleared, Pruned)):
        return math.inf, 0.0
    raise TypeError(f"no reading for {outcome!r}")


@dataclass
class Suspect:
    """A kernel reading its own bounds contradict (see the module); never an outcome. `requests`
    are request indexes of the measure call; `reevaluated` holds (label, outcome, its own mesh
    (lower, upper) or None); `replacement` what its requests read as when `resolved`; `cached`:
    reported from the cache's stored resolution, nothing re-evaluated."""

    requests: tuple[int, ...]
    distance_mm: float
    overlap_mm3: float
    lower_mm: float
    upper_mm: float
    reevaluated: list[tuple[str, Measured | Failure, tuple[float, float] | None]] = field(default_factory=list)
    resolved: bool | None = None
    replacement: Cleared | None = None
    cached: bool = False
    expected: int = field(default=0, repr=False)

    def provenance(self) -> str:
        """The resolution as stored with its cached decision."""
        return json.dumps({"distance_mm": self.distance_mm, "overlap_mm3": self.overlap_mm3, "lower_mm": self.lower_mm,
                           "upper_mm": _finite(self.upper_mm),
                           "reevaluated": [[label, *(["error", outcome.message] if isinstance(outcome, Failure)
                                                     else ["exact", outcome.distance_mm, outcome.overlap_mm3]),
                                            None if bounds is None else [bounds[0], _finite(bounds[1])]]
                                           for label, outcome, bounds in self.reevaluated]})

    @classmethod
    def from_provenance(cls, text: str, requests: tuple[int, ...], replacement: Cleared) -> Suspect:
        data = json.loads(text)
        reevaluated = []
        for label, kind, *values, bounds in data["reevaluated"]:
            outcome = Failure(values[0]) if kind == "error" else Measured(values[0], values[1])
            reevaluated.append((label, outcome, None if bounds is None else (bounds[0], _infinite(bounds[1]))))
        return cls(requests, data["distance_mm"], data["overlap_mm3"], data["lower_mm"], _infinite(data["upper_mm"]),
                   reevaluated, True, replacement, True)


@dataclass(frozen=True)
class Chunk:
    """One committed task: its id, the request indexes it answered (in answering order), and its
    seconds in the process that ran it."""

    task_id: int
    requests: tuple[int, ...]
    seconds: float


@dataclass
class Counters:
    """What a measurer did, over every call of every session."""

    requested: int = 0  # requests answered
    kernel_evaluations: int = 0  # kernel measurements, re-evaluations of suspects included
    fcl_queries: int = 0  # mesh distance queries, in whichever process
    exact_hits: int = 0  # units whose exact reading the cache held
    decision_hits: int = 0  # units whose mesh bound or resolved suspect the cache held
    bucket_hits: int = 0  # requests cleared by a cached interval at another placement of their bucket
    reused: int = 0  # requests answered by a unit reading another request was answered with
    pruned: int = 0
    cleared: dict[str, int] = field(default_factory=lambda: {"box": 0, "mesh": 0, SUSPECT_METHOD: 0, "cache-bound": 0})
    reevaluations: int = 0  # kernel measurements of suspects' re-evaluations
    committed_chunks: int = 0  # task results committed to the cache
    worker_pids: set[int] = field(default_factory=set)  # worker processes that returned a task
    kernel_seconds: float = 0.0
    mesh_seconds: float = 0.0
    parent_seconds: float = 0.0  # time in `measure`, waiting for workers left out


# --------------------------------------------------------------------------- rule and identity


@dataclass(frozen=True)
class RuleVersion:
    """Everything an evaluation's value depends on besides the two geometries and the placement.
    `digest` (sha256 of its canonical JSON) is part of every cache key; one rule serves sweep and
    static checks. Worker count, output paths and the sampled domain are not in it."""

    schema: int
    revision: int
    sources: Mapping[str, str]  # file name -> sha256 of pose.py, pair_measure.py, mesh_bound.py, coupling.py
    constants: Mapping[str, float]
    mesh: Mapping[str, Any] | None  # mesh_bound.MeshBounds.settings(); None: no mesh bound
    band_mm: float
    transform: Mapping[str, Any]  # the identity policy of placements
    libraries: Mapping[str, str]
    platform: Mapping[str, str]

    @classmethod
    def current(cls, mesh: Any = None, band_mm: float = MESH_BAND_MM) -> RuleVersion:
        """The rule of this code, kernel and platform, with `mesh` (mesh_bound.MeshBounds or None)
        and the fast-mode band."""
        if not (math.isfinite(band_mm) and band_mm > 0.0):
            raise ValueError(f"the mesh band must be a positive number of mm, got {band_mm!r}")
        constants = {name: getattr(pose, name) for name in ("OVERLAP_GATE_MM", "FUZZY_MM", "VOLUME_EPS",
                                                            "CONTAINMENT_TOL_MM", "SOLID_GAP_MM", "INTERFERENCE_MM3")}
        constants.update(SLACK_MM=SLACK_MM, SUSPECT_DEFLECTIONS=SUSPECT_DEFLECTIONS, REEVALUATE_MM=REEVALUATE_MM)
        return cls(SCHEMA_VERSION, RULE_REVISION, _source_hashes(), constants,
                   None if mesh is None else dict(mesh.settings()), float(band_mm),
                   {"rotation_quantum": ROTATION_QUANTUM, "translation_quantum_mm": TRANSLATION_QUANTUM_MM,
                    "operands": "smaller (geometry id, placement bits) first, inverted when swapped"},
                   {"ocp": _ocp_version(), "python": platform.python_version(),
                    "implementation": sys.implementation.name},
                   {"system": sys.platform, "machine": platform.machine()})

    def as_json(self) -> dict[str, Any]:
        """The rule as plain JSON, for a run recipe."""
        return json.loads(json.dumps(dataclasses.asdict(self), sort_keys=True))

    @functools.cached_property
    def digest(self) -> bytes:
        return hashlib.sha256(json.dumps(self.as_json(), sort_keys=True, separators=(",", ":"),
                                         allow_nan=False).encode()).digest()


@functools.cache
def _source_hashes() -> dict[str, str]:
    files = {"pose.py": Path(pose.__file__), "pair_measure.py": Path(__file__),
             "mesh_bound.py": Path(__file__).with_name("mesh_bound.py"), "coupling.py": Path(pose.COUPLING_PATH)}
    return {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}


@functools.cache
def _ocp_version() -> str:
    try:
        import OCP
    except ImportError:
        return "unavailable"
    found = [f"OCP {getattr(OCP, '__version__', '?')}"]
    for distribution in ("cadquery-ocp-novtk", "cadquery-ocp"):
        try:
            found.append(f"{distribution} {importlib.metadata.version(distribution)}")
        except importlib.metadata.PackageNotFoundError:
            pass
    return "; ".join(found)


def _bits(rigid: Any) -> bytes:
    """A placement's 12 IEEE doubles."""
    return struct.pack("<12d", *rigid.rot[0], *rigid.rot[1], *rigid.rot[2], *rigid.trans)


def exact_fingerprint(rigid: Any) -> bytes:
    """The exact identity of a placement: sha256 of its 12 doubles."""
    return hashlib.sha256(_EXACT_TAG + _bits(rigid)).digest()


def _rounded(rigid: Any) -> bytes:
    """A placement rounded to its bucket: rotation entries to ROTATION_QUANTUM, translation to
    TRANSLATION_QUANTUM_MM, as integers (so -0 is 0)."""
    return struct.pack("<12q", *(round(v / ROTATION_QUANTUM) for row in rigid.rot for v in row),
                       *(round(v / TRANSLATION_QUANTUM_MM) for v in rigid.trans))


def _rigid(bits: bytes) -> Any:
    values = struct.unpack("<12d", bits)
    return pose.Rigid((values[0:3], values[3:6], values[6:9]), values[9:12])


@dataclass
class _Unit:
    """One evaluation: canonical definitions `a`, `b` at `placement`, and the requests it answers."""

    a: str
    b: str
    placement: Any
    ga: bytes
    gb: bytes
    bits: bytes
    exact_fp: bytes
    rounded: bytes
    bucket: bytes
    requests: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class _Bounds:
    """A unit's mesh bounds: MeshQuery's interval, mesh distance and both deviations."""

    lower: float
    upper: float
    mesh_mm: float | None
    deviation: float
    seconds: float = 0.0


# --------------------------------------------------------------------------- the measurer


class PairMeasurer:
    """Measures requests on `shapes` (definition key -> TopoDS_Shape) whose identities are
    `geometry_ids` (key -> 32-byte id, pose.geometry_ids) under `rule`, in this process or, with
    `jobs` > 1, in a session's worker processes (`start_method`: forkserver, spawn on macOS and
    Windows; never fork). With `threads`, a measurement in this process searches on OCCT's thread
    pool; workers never do, as `jobs` of them already fill the cores. `cache`: a PairCache, read
    and written by this process alone. `mesh`: mesh_bound.MeshBounds, or None: box gaps alone."""

    def __init__(self, shapes: Mapping[str, Any], *, geometry_ids: Mapping[str, bytes], rule: RuleVersion,
                 jobs: int = 1, start_method: str | None = None, threads: bool = True, cache: PairCache | None = None,
                 mesh: Any = None) -> None:
        self.shapes = dict(shapes)
        missing = sorted(set(self.shapes) - set(geometry_ids))
        if missing:
            raise ValueError(f"no geometry id for {', '.join(missing)}")
        self.geometry_ids = {key: bytes(geometry_ids[key]) for key in self.shapes}
        wrong = sorted(key for key, value in self.geometry_ids.items() if len(value) != 32)
        if wrong:
            raise ValueError(f"geometry ids must be 32-byte digests: {', '.join(wrong)}")
        self.rule, self.jobs, self.threads, self.cache, self.mesh = rule, jobs, threads, cache, mesh
        self.start_method = start_method or _default_start_method()
        self.counters = Counters()
        self._corners: dict[str, list[tuple[float, float, float]]] = {}
        self._faces: dict[str, int] = {}

    def session(self, assets: Any = None) -> MeasurementSession:
        """A measuring session (a context manager): one lazily started worker pool for its
        lifetime. `assets` (mesh_bound.MeshAssets) are the parent's tessellations the workers
        load; None: prepared from `mesh` when the first worker task starts."""
        return MeasurementSession(self, assets)

    def corners(self, key: str) -> list[tuple[float, float, float]]:
        """The 8 corners of definition `key`'s exact box, enlarged by its tolerances: the box holds
        the shape, so its placed corners' axis-aligned hull holds the placed shape."""
        if key not in self._corners:
            self._corners[key] = list(itertools.product(*zip(*pose.box_corners(self.shapes[key], tolerance=True))))
        return self._corners[key]

    def box_gap(self, a: str, b: str, placement: Any) -> float:
        """The exact-box gap of definition `b` placed by `placement` in a's frame: a lower bound on
        their distance, and what the kernel is given."""
        return _placed_gap(self.corners(a), self.corners(b), placement)

    def faces(self, key: str) -> int:
        if key not in self._faces:
            self._faces[key] = face_count(self.shapes[key])
        return self._faces[key]

    def canonical(self, a: str, b: str, placement: Any) -> tuple[str, str, Any]:
        """The operand order the evaluation uses: (a, b, placement) or (b, a, placement^-1),
        whichever has the smaller (geometry id, geometry id, placement bits)."""
        inverse = placement.inverse()
        forward = (self.geometry_ids[a], self.geometry_ids[b], _bits(placement), a, b)
        backward = (self.geometry_ids[b], self.geometry_ids[a], _bits(inverse), b, a)
        return (b, a, inverse) if backward < forward else (a, b, placement)

    def decision_key(self, unit: _Unit, request: Request) -> bytes:
        return hashlib.sha256(_DECISION_TAG + unit.ga + unit.gb + unit.rounded + struct.pack("<d", request.minimum_mm + 0.0)
                              + self.rule.digest + request.decision_mode.encode()).digest()


class MeasurementSession:
    """See PairMeasurer.session. `suspects` are the last `measure` call's."""

    def __init__(self, measurer: PairMeasurer, assets: Any) -> None:
        self.measurer, self.assets = measurer, assets
        self.suspects: list[Suspect] = []
        self._executor: _InProcess | _Workers = _InProcess(measurer) if measurer.jobs <= 1 else _Workers(self)
        self._tempdir: str | None = None
        self._assets_path: str | None = None

    def __enter__(self) -> MeasurementSession:
        return self

    def __exit__(self, kind: Any, error: Any, trace: Any) -> None:
        self.close(terminate=kind is not None)

    def measure(self, requests: Sequence[Request], *, deadline: float = math.inf, prune: bool = False,
                neighbours: Callable[[int], list[tuple[str, Any]]] | None = None,
                on_chunk: Callable[[Chunk], None] | None = None) -> list[Outcome | None]:
        """One outcome per request, in request order; None for those the deadline (time.monotonic)
        left unanswered. `neighbours(index)` lists a suspect's re-evaluation placements as (label,
        pose.Rigid) pairs; `on_chunk` is called after each task's results are committed."""
        started = time.monotonic()
        run = _Run(self, requests, prune, neighbours, on_chunk)
        try:
            run.execute(self._executor, deadline)
        except BaseException:
            self._executor.terminate()
            raise
        finally:
            self.suspects = run.suspects
            self.measurer.counters.parent_seconds += time.monotonic() - started - run.waited
        return run.outcomes

    def assets_file(self) -> str | None:
        """The .npz of the mesh assets the workers load (written once per session), or None."""
        mesh = self.measurer.mesh
        if mesh is None:
            return None
        if self._assets_path is None:
            assets = self.assets if self.assets is not None else mesh.prepare(self.measurer.shapes)
            self._tempdir = tempfile.mkdtemp(prefix="cad-motion-mesh-")
            path = Path(self._tempdir) / "assets.npz"
            assets.save(path)
            self._assets_path = str(path)
        return self._assets_path

    def close(self, terminate: bool = False) -> None:
        """End the worker pool (`terminate`: kill the workers mid-task) and remove the assets file."""
        try:
            if terminate:
                self._executor.terminate()
            else:
                self._executor.close()
        finally:
            if self._tempdir is not None:
                shutil.rmtree(self._tempdir, ignore_errors=True)
                self._tempdir = self._assets_path = None


class _Run:
    """One `measure` call: the requests' units, groups, cache knowledge and schedule."""

    def __init__(self, session: MeasurementSession, requests: Sequence[Request], prune: bool,
                 neighbours: Callable[[int], list[tuple[str, Any]]] | None,
                 on_chunk: Callable[[Chunk], None] | None) -> None:
        self.session, self.requests, self.prune, self.on_chunk = session, requests, prune, on_chunk
        measurer = self.measurer = session.measurer
        self.counters = measurer.counters
        self.band = measurer.rule.band_mm
        self.meshing = measurer.mesh is not None
        self.neighbours = neighbours or self.translated
        count = len(requests)
        self.outcomes: list[Outcome | None] = [None] * count
        self.open = count
        self.units: list[_Unit] = []
        self.unit_of: list[int] = []
        seen: dict[tuple[str, str, bytes], int] = {}
        for index, request in enumerate(requests):
            for key in (request.a, request.b):
                if key not in measurer.shapes:
                    raise ValueError(f"request {index}: no definition {key!r}")
            a, b, placement = measurer.canonical(request.a, request.b, request.placement)
            bits = _bits(placement)
            unit = seen.get((a, b, bits))
            if unit is None:
                unit = seen[(a, b, bits)] = len(self.units)
                rounded = _rounded(placement)
                self.units.append(_Unit(a, b, placement, measurer.geometry_ids[a], measurer.geometry_ids[b], bits,
                                        hashlib.sha256(_EXACT_TAG + bits).digest(), rounded,
                                        hashlib.sha256(_BUCKET_TAG + rounded).digest()))
            self.units[unit].requests.append(index)
            self.unit_of.append(unit)
        self.members: dict[Hashable, list[int]] = defaultdict(list)
        self.position = [0] * count
        for index, request in enumerate(requests):
            if request.group is not None:
                self.position[index] = len(self.members[request.group])
                self.members[request.group].append(index)
        self.floor: dict[Hashable, tuple[float, int]] = {}  # group -> (smallest known distance, its request)
        self.gaps: dict[int, float] = {}  # unit -> its exact-box gap
        self.placed: dict[int, list[tuple[float, float, float]]] = {}  # request -> b's box corners at its placement
        self.motion: dict[int, float] = {}  # unit -> best motion lower bound
        self.interval: dict[int, _Bounds] = {}  # unit -> mesh bounds
        self.bucket: dict[int, tuple[float, float]] = {}  # unit -> cached interval widened to its placement
        self.kernel_gap: dict[int, float] = {}  # unit -> the box gap its measurement was given
        self.held: dict[int, Measured] = {}  # pending units' cached readings, answered once classified
        self.answering: set[int] = set()  # units whose reading answered a request
        self.near: set[int] = set()  # requests found within their cap
        self.inflight: set[int] = set()  # units in a task
        self.touched: set[Hashable] = set()  # groups whose floor or bounds moved since the last prune pass
        self.queues: dict[Hashable, list[tuple[float, int]]] = defaultdict(list)
        self.order: list[Hashable] = []
        self.turn = 0
        self.extra: deque[tuple[tuple, ...]] = deque()  # suspects' re-evaluation tasks waiting
        self.extra_of: dict[int, tuple[Suspect, str, int]] = {}  # entry id -> (suspect, label, unit)
        self.next_id = len(self.units)
        self.task_entries: dict[int, list[int]] = {}  # task id -> its units and entries
        self.next_task = 0
        self.records: list[tuple[str, tuple]] = []  # cache rows since the last commit
        self.answered: list[int] = []  # requests answered since the last chunk report
        self.costs: dict[tuple[bytes, bytes], float] = {}  # (ga, gb) -> the cache's kernel seconds
        self.rate: float | None = None  # seconds per face pair of the costs known, for the unseen
        self.suspects: list[Suspect] = []
        self.waited = 0.0  # seconds this process waited for a result

    # -- bounds ---------------------------------------------------------------------------------

    def gap(self, unit: int) -> float:
        """The unit's exact-box gap (PairMeasurer.box_gap)."""
        if unit not in self.gaps:
            u = self.units[unit]
            self.gaps[unit] = self.measurer.box_gap(u.a, u.b, u.placement)
        return self.gaps[unit]

    def box(self, index: int) -> float:
        """The request's box lower bound: the caller's, else its unit's exact-box gap."""
        given = self.requests[index].box_gap_mm
        return given if given is not None else self.gap(self.unit_of[index])

    def clearable(self, index: int) -> bool:
        request = self.requests[index]
        return not request.require_exact and request.mode != "exact"

    def cap(self, index: int) -> float:
        """The distance beyond which a clearable request is cleared."""
        request = self.requests[index]
        if request.mode == "bound":
            return pose.OVERLAP_GATE_MM
        return max(pose.OVERLAP_GATE_MM, request.minimum_mm) + self.band

    def own_bound(self, index: int) -> tuple[float, float, str, float | None, float]:
        """The request's own (lower, upper, what proved the lower, mesh distance, deviation): the box
        bound, raised by the unit's mesh bound or cached interval where known. None of it depends
        on what else was measured."""
        unit = self.unit_of[index]
        lower, upper, method, mesh_mm, deviation = self.box(index), math.inf, "box", None, 0.0
        bounds = self.interval.get(unit)
        if bounds is not None:
            upper, mesh_mm, deviation = bounds.upper, bounds.mesh_mm, bounds.deviation
            if bounds.lower > lower:
                lower, method = bounds.lower, "mesh"
        cached = self.bucket.get(unit)
        if cached is not None:
            upper = min(upper, cached[1])
            if cached[0] > lower:
                lower, method = cached[0], "cache-bound"
        return lower, upper, method, mesh_mm, deviation

    def pending(self, unit: int) -> bool:
        """Whether the unit waits for its mesh bound: none is known, and its bounds without one leave
        an open clearable request within its cap."""
        if not self.meshing or unit in self.interval:
            return False
        cached = self.bucket.get(unit, (-math.inf, math.inf))[0]
        return any(self.outcomes[index] is None and self.clearable(index) and index not in self.near
                   and max(self.box(index), cached) - SLACK_MM <= self.cap(index)
                   for index in self.units[unit].requests)

    def clear(self, index: int) -> bool | None:
        """Answer the open request `index` Cleared when its own lower bound exceeds its cap by
        SLACK_MM: True; False when it does not or cannot; None while its unit is pending."""
        if not self.clearable(index) or index in self.near:
            return False
        unit = self.unit_of[index]
        if self.pending(unit):
            return None
        lower, upper, method, mesh_mm, deviation = self.own_bound(index)
        if lower - SLACK_MM > self.cap(index):
            self.counters.cleared[method] += 1
            self.counters.bucket_hits += method == "cache-bound"
            seconds = self.interval[unit].seconds if method == "mesh" else 0.0
            self.settle(index, Cleared(lower, upper, method, mesh_mm, deviation, seconds))
            return True
        self.near.add(index)
        return False

    def prune_lower(self, index: int) -> float:
        """The request's lower bound for pruning: its box bound and motion bound; outside exact mode
        its mesh bound and cached interval less the band too, so a request a mesh alone puts beyond
        its group minimum is still measured inside the band, as clearing would measure it."""
        unit = self.unit_of[index]
        lower = max(self.box(index), self.motion.get(unit, -math.inf))
        if self.requests[index].mode != "exact":
            if unit in self.interval:
                lower = max(lower, self.interval[unit].lower - self.band)
            if unit in self.bucket:
                lower = max(lower, self.bucket[unit][0] - self.band)
        return lower

    def prunable(self, index: int) -> bool:
        request = self.requests[index]
        if not self.prune or request.group is None or request.require_exact:
            return False
        floor = self.floor.get(request.group)
        return floor is not None and \
            self.prune_lower(index) - SLACK_MM > max(floor[0], pose.OVERLAP_GATE_MM, request.minimum_mm)

    def prune_request(self, index: int) -> None:
        self.counters.pruned += 1
        self.settle(index, Pruned(self.floor[self.requests[index].group][1], self.prune_lower(index)))

    def suspicious(self, unit: int, measured: Measured) -> bool:
        """Whether a fresh reading contradicts the unit's own bounds (see Suspect)."""
        distance = measured.distance_mm
        if distance < self.box_floor(unit) - SLACK_MM:
            return True
        bounds = self.interval.get(unit)
        if bounds is None or bounds.mesh_mm is None:
            return False
        tolerance = max(SUSPECT_DEFLECTIONS * self.measurer.mesh.linear, bounds.deviation)
        return distance > bounds.mesh_mm + tolerance or (bounds.lower > 0.0 and bounds.mesh_mm - distance > tolerance)

    def box_floor(self, unit: int) -> float:
        """The largest box bound of the unit: its kernel box gap and its requests' box bounds."""
        given = [self.requests[index].box_gap_mm for index in self.units[unit].requests]
        return max([self.kernel_gap.get(unit, 0.0), *(value for value in given if value is not None)])

    # -- answers --------------------------------------------------------------------------------

    def settle(self, index: int, outcome: Outcome) -> None:
        self.outcomes[index] = outcome
        self.open -= 1
        self.counters.requested += 1
        self.answered.append(index)
        group = self.requests[index].group
        if group is not None and isinstance(outcome, Measured) \
                and outcome.distance_mm < self.floor.get(group, (math.inf, 0))[0]:
            self.floor[group] = (outcome.distance_mm, index)
            self.touched.add(group)

    def learn(self, unit: int, outcome: Measured | Failure, fresh: bool) -> None:
        """A unit's reading is known: hold a fresh one its bounds contradict as a suspect; else
        record a fresh one with its decision rows, answer the unit's open requests and bound their
        group neighbours."""
        if fresh and isinstance(outcome, Measured):
            if self.suspicious(unit, outcome):
                self.suspect(unit, outcome)
                return
            self.record_measurement(unit, outcome)
            self.record_evaluations(unit, "measured")
        for index in self.units[unit].requests:
            if self.outcomes[index] is None and self.clear(index) is False:
                if unit in self.answering:
                    self.counters.reused += 1
                self.answering.add(unit)
                self.settle(index, outcome)
        if self.prune and isinstance(outcome, Measured):
            for index in self.units[unit].requests:
                group = self.requests[index].group
                if group is None:
                    continue
                members, at = self.members[group], self.position[index]
                for neighbour in members[max(0, at - MOTION_WINDOW):at + MOTION_WINDOW + 1]:
                    if self.outcomes[neighbour] is None:
                        self.bound_by_motion(index, outcome.distance_mm, neighbour)
                        self.touched.add(group)

    def placed_corners(self, index: int) -> list[tuple[float, float, float]]:
        """b's box corners at request `index`'s own placement (its group's frame)."""
        if index not in self.placed:
            request = self.requests[index]
            self.placed[index] = [request.placement.apply(c) for c in self.measurer.corners(request.b)]
        return self.placed[index]

    def bound_by_motion(self, source: int, distance: float, target: int) -> None:
        shift = max(math.dist(p, q) for p, q in zip(self.placed_corners(source), self.placed_corners(target)))
        unit = self.unit_of[target]
        if distance - shift > self.motion.get(unit, -math.inf):
            self.motion[unit] = distance - shift

    def classify(self, unit: int) -> None:
        """The unit's mesh bound came back without a measurement: answer what it clears or proves
        prunable, and queue the rest to be measured."""
        for index in self.units[unit].requests:
            if self.outcomes[index] is not None or self.clear(index):
                continue
            if self.prunable(index):
                self.prune_request(index)
                continue
            self.queue(index)

    def prune_group(self, group: Hashable) -> None:
        for index in self.members[group]:
            if self.outcomes[index] is None and self.unit_of[index] not in self.inflight \
                    and self.clear(index) is False and self.prunable(index):
                self.prune_request(index)

    # -- suspects -------------------------------------------------------------------------------

    def suspect(self, unit: int, measured: Measured) -> None:
        """Hold the unit's requests and queue the re-evaluations of its suspect reading."""
        u = self.units[unit]
        bounds = self.interval.get(unit)
        lower = max(self.box_floor(unit), bounds.lower if bounds is not None else -math.inf)
        suspect = Suspect(tuple(u.requests), measured.distance_mm, measured.overlap_mm3, lower,
                          bounds.upper if bounds is not None else math.inf)
        self.suspects.append(suspect)
        first = self.requests[u.requests[0]]
        tasks = [(label, first.a, first.b, placement, ("both",)) for label, placement in self.neighbours(u.requests[0])]
        tasks.append(("swapped", u.b, u.a, u.placement.inverse(), ("plain",)))
        suspect.expected = len(tasks)
        entries = []
        for label, a, b, placement, mode in tasks:
            self.extra_of[self.next_id] = (suspect, label, unit)
            entries.append((self.next_id, a, b, (placement.rot, placement.trans), mode))
            self.next_id += 1
        self.extra.append(tuple(entries))

    def translated(self, index: int) -> list[tuple[str, Any]]:
        """The default re-evaluation placements: b moved +-REEVALUATE_MM along (1, 1, 1)/sqrt(3)."""
        placement = self.requests[index].placement
        moved = []
        for shift in (REEVALUATE_MM, -REEVALUATE_MM):
            step = shift / math.sqrt(3.0)
            moved.append((f"{shift:+g} mm", pose.Rigid(placement.rot, tuple(v + step for v in placement.trans))))
        return moved

    def reevaluated(self, entry: int, outcome: Measured | Failure, bounds: _Bounds | None) -> None:
        """A suspect's re-evaluation is back; with the last, resolve the suspect and answer its requests."""
        suspect, label, unit = self.extra_of.pop(entry)
        suspect.reevaluated.append((label, outcome, None if bounds is None else (bounds.lower, bounds.upper)))
        if len(suspect.reevaluated) < suspect.expected:
            return

        def agrees(result: Measured | Failure, own: tuple[float, float] | None) -> bool:
            low, high = own if own is not None else (suspect.lower_mm, suspect.upper_mm)
            return isinstance(result, Measured) and low - SLACK_MM <= result.distance_mm <= high + SLACK_MM

        consistent = all(agrees(result, own) for _, result, own in suspect.reevaluated)
        waiting = [index for index in suspect.requests if self.outcomes[index] is None]
        eligible = [index for index in waiting if not self.requests[index].require_exact]
        decided = all(suspect.lower_mm - SLACK_MM > max(pose.OVERLAP_GATE_MM, self.requests[index].minimum_mm) + self.band
                      for index in eligible)
        suspect.resolved = consistent and decided
        interval = self.interval.get(unit)
        if suspect.resolved:
            suspect.replacement = Cleared(suspect.lower_mm, suspect.upper_mm, SUSPECT_METHOD,
                                          interval.mesh_mm if interval is not None else None,
                                          interval.deviation if interval is not None else 0.0)
            self.record_evaluations(unit, "cleared", eligible, suspect)
        for index in waiting:
            if suspect.resolved and index in eligible:
                self.counters.cleared[SUSPECT_METHOD] += 1
                self.settle(index, suspect.replacement)
            else:
                self.settle(index, Failure(f"suspect reading {suspect.distance_mm!r} mm contradicts its own bounds "
                                           f"[{suspect.lower_mm!r}, {suspect.upper_mm!r}] mm"))

    # -- cache ----------------------------------------------------------------------------------

    def record_measurement(self, unit: int, measured: Measured) -> None:
        u = self.units[unit]
        self.records.append(("measurement", (u.ga, u.gb, self.measurer.rule.digest, u.bucket, u.bits, u.exact_fp,
                                             struct.pack("<2d", measured.distance_mm, measured.overlap_mm3),
                                             measured.seconds)))
        self.records.append(("cost", (u.ga, u.gb, self.measurer.rule.digest, "exact", measured.seconds)))

    def record_evaluations(self, unit: int, outcome: str, indexes: Sequence[int] | None = None,
                           suspect: Suspect | None = None) -> None:
        """One decision row per distinct decision key of the unit's requests (or `indexes`): its mesh
        bounds, and for a measured unit a link to its reading; a resolved suspect with provenance."""
        u = self.units[unit]
        bounds = self.interval.get(unit)
        if suspect is not None:
            lower, upper, mesh_mm, deviation, method = (suspect.lower_mm, suspect.upper_mm,
                                                        bounds.mesh_mm if bounds else None,
                                                        bounds.deviation if bounds else 0.0, SUSPECT_METHOD)
        elif bounds is not None:
            lower, upper, mesh_mm, deviation, method = bounds.lower, bounds.upper, bounds.mesh_mm, bounds.deviation, "mesh"
        else:
            return
        validation = None if suspect is None else suspect.provenance()
        seen: set[bytes] = set()
        for index in (u.requests if indexes is None else indexes):
            request = self.requests[index]
            key = self.measurer.decision_key(u, request)
            if key in seen:
                continue
            seen.add(key)
            self.records.append(("evaluation", (key, u.exact_fp, u.ga, u.gb, self.measurer.rule.digest, u.bucket, u.bits,
                                                request.decision_mode, request.minimum_mm, outcome, lower,
                                                _finite(upper), mesh_mm, deviation, method, outcome == "measured",
                                                bounds.seconds if bounds is not None else 0.0, validation)))

    def load_cache(self) -> None:
        """Take what the cache holds: exact readings, mesh bounds and resolved suspects at each
        unit's exact fingerprint, and widened intervals from other placements of its bucket."""
        cache = self.measurer.cache
        if cache is None or not self.units:
            return
        stored = cache.lookup(self.measurer.rule.digest, self.units)
        cached_suspects: dict[int, dict[bytes, _Row]] = {}
        for unit, (readings, rows) in enumerate(stored):
            u = self.units[unit]
            elsewhere: list[tuple[float, float, bytes]] = []  # (lower, upper, placement) at other placements
            for found in readings:
                if found.exact_fp == u.exact_fp:
                    self.counters.exact_hits += 1
                    self.held[unit] = Measured(found.distance, found.volume, found.seconds)
                else:
                    elsewhere.append((found.distance, found.distance, found.transform))
            for row in rows:
                if row.exact_fp != u.exact_fp:
                    elsewhere.append((row.lower, row.upper, row.transform))
                elif row.method == SUSPECT_METHOD:
                    cached_suspects.setdefault(unit, {})[row.key] = row
                elif row.mesh_mm is not None and unit not in self.interval:
                    self.interval[unit] = _Bounds(row.lower, row.upper, row.mesh_mm, row.deviation)
                    self.counters.decision_hits += 1
            for low, high, transform in elsewhere:
                shift = self.displacement(u, transform)
                low, high = max(0.0, low - shift - SLACK_MM), high + shift + SLACK_MM
                best = self.bucket.get(unit, (-math.inf, math.inf))
                self.bucket[unit] = (max(best[0], low), min(best[1], high))
        for unit, rows in cached_suspects.items():
            self.counters.decision_hits += 1
            answered: list[tuple[int, _Row]] = []
            for index in self.units[unit].requests:
                row = rows.get(self.measurer.decision_key(self.units[unit], self.requests[index]))
                if row is None or self.outcomes[index] is not None or self.clear(index):
                    continue
                self.counters.cleared[SUSPECT_METHOD] += 1
                self.settle(index, Cleared(row.lower, row.upper, SUSPECT_METHOD, row.mesh_mm, row.deviation))
                answered.append((index, row))
            if answered:
                index, row = answered[0]
                self.suspects.append(Suspect.from_provenance(row.validation, tuple(i for i, _ in answered),
                                                             self.outcomes[index]))
        for unit, measured in list(self.held.items()):
            if not self.pending(unit):
                self.learn(unit, self.held.pop(unit), fresh=False)
        self.costs = cache.costs(self.measurer.rule.digest)
        self.touched.clear()

    def displacement(self, unit: _Unit, transform: bytes) -> float:
        """The farthest any corner of b's exact box moves between `transform` and the unit's placement."""
        other = _rigid(transform)
        return max(math.dist(unit.placement.apply(c), other.apply(c)) for c in self.measurer.corners(unit.b))

    def commit(self, task: int, seconds: float) -> None:
        """Commit the rows since the last commit, then report the requests answered meanwhile."""
        cache = self.measurer.cache
        if cache is not None and self.records and cache.commit_chunk(self.records):
            self.counters.committed_chunks += 1
        self.records = []
        answered, self.answered = tuple(self.answered), []
        if self.on_chunk is not None:
            self.on_chunk(Chunk(task, answered, seconds))

    # -- scheduling -----------------------------------------------------------------------------

    def cost(self, unit: int) -> float:
        """The unit's expected kernel seconds: the cache's per-pair cost, else its face-count product
        at the rate of the pairs whose cost is known (1 s per face pair without one)."""
        u = self.units[unit]
        seen = self.costs.get((u.ga, u.gb))
        if seen is not None:
            return seen
        if self.rate is None:
            rates = [self.costs[(v.ga, v.gb)] / max(1, self.measurer.faces(v.a) * self.measurer.faces(v.b))
                     for v in self.units if (v.ga, v.gb) in self.costs]
            self.rate = max(rates) if rates else 1.0
        return self.rate * self.measurer.faces(u.a) * self.measurer.faces(u.b)

    def queue(self, index: int) -> None:
        """Put an open request in its queue: its group's, keyed by its box bound, when pruning; else
        the one queue, costliest first across workers, in request order in this process."""
        request = self.requests[index]
        key = request.group if self.prune else None
        if key not in self.queues:
            self.order.append(key)
        if self.prune:
            heapq.heappush(self.queues[key], (self.box(index), index))
        else:
            heapq.heappush(self.queues[key], (-self.cost(self.unit_of[index]) if self.measurer.jobs > 1 else 0, index))

    def next_unit(self) -> int | None:
        """The next unit to evaluate: groups in turn, each its open request of the smallest box bound."""
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
                if verdict is False and self.prunable(index):
                    self.prune_request(index)
                    continue
                if verdict is False and unit in self.held:  # a cached reading, nothing pending
                    self.learn(unit, self.held.pop(unit), fresh=False)
                    continue
                return unit
        return None

    def entry(self, unit: int) -> tuple:
        """The unit's task entry (see _run_entry): a pending unit's mesh bound first, its measurement
        skipped where the bound clears every open request or proves each prunable, and always for a
        held cached reading; with a mesh and no bound known, the bound with the measurement."""
        u = self.units[unit]
        rows = (u.placement.rot, u.placement.trans)
        if self.pending(unit):
            waiting = [index for index in u.requests if self.outcomes[index] is None]
            clearable = all(self.clearable(index) and index not in self.near for index in waiting)
            cap = max(self.cap(index) for index in waiting) if clearable else math.inf
            limit = math.inf
            if all(self.prune and self.requests[index].group in self.floor and not self.requests[index].require_exact
                   and self.requests[index].mode != "exact" for index in waiting):
                limit = self.band + max(max(self.floor[self.requests[index].group][0], pose.OVERLAP_GATE_MM,
                                            self.requests[index].minimum_mm) for index in waiting)
            mode: tuple = ("fast", cap, limit, unit not in self.held)
        elif self.meshing and unit not in self.interval:
            mode = ("both",)
        else:
            mode = ("plain",)
        return unit, u.a, u.b, rows, mode

    def chunk_size(self) -> int:
        """Units per task: CHUNK_REQUESTS, but while pruning one in this process and few enough per
        worker that results come back to prune with."""
        if not self.prune:
            return CHUNK_REQUESTS
        if self.measurer.jobs <= 1:
            return 1
        return max(1, min(CHUNK_REQUESTS, self.open // (4 * self.measurer.jobs)))

    def execute(self, executor: _InProcess | _Workers, deadline: float) -> None:
        if time.monotonic() > deadline:
            return
        self.load_cache()
        for index in range(len(self.requests)):
            if self.outcomes[index] is None:
                self.queue(index)
        if self.prune and self.measurer.jobs > 1:  # the costliest groups start first, shortening the tail
            self.order.sort(key=lambda key: -self.cost(self.unit_of[self.queues[key][0][1]]))
        self.answered = []  # what the cache answered is no chunk's
        while True:
            while len(self.task_entries) < executor.capacity and time.monotonic() <= deadline:
                if self.extra:
                    entries = list(self.extra.popleft())
                else:
                    entries = []
                    while len(entries) < self.chunk_size():
                        unit = self.next_unit()
                        if unit is None:
                            break
                        self.inflight.add(unit)
                        entries.append(self.entry(unit))
                    if not entries:
                        break
                task = self.next_task
                self.next_task += 1
                self.task_entries[task] = [entry[0] for entry in entries]
                executor.submit((task, tuple(entries)), deadline)
            if not self.task_entries:
                return
            waiting = time.monotonic()
            done = executor.next(deadline)
            self.waited += time.monotonic() - waiting
            if done is None:  # the deadline passed with tasks in flight
                executor.terminate()
                return
            self.absorb(*done)
            if self.prune:
                for group in self.touched:
                    if group in self.floor:
                        self.prune_group(group)
            self.touched.clear()
            self.commit(done[0], done[3])

    def absorb(self, task: int, rows: list[tuple], pid: int, seconds: float) -> None:
        """A task's results: each entry's kernel reading and mesh bound, in entry order."""
        if self.measurer.jobs > 1:
            self.counters.worker_pids.add(pid)
        entries = self.task_entries.pop(task)
        for entry in entries:
            if entry < len(self.units):
                self.inflight.discard(entry)
        for entry, result, query, gap, kernel_seconds, query_seconds in rows:
            bounds = None
            if query is not None:
                bounds = _Bounds(query[0], query[1], query[2], query[3], query_seconds)
                self.counters.fcl_queries += query[2] is not None
                self.counters.mesh_seconds += query_seconds
            outcome: Measured | Failure | None = None
            if result is not None:
                self.counters.kernel_evaluations += 1
                self.counters.kernel_seconds += kernel_seconds
                outcome = Failure(result) if isinstance(result, str) else Measured(result[0], result[1], kernel_seconds)
            if entry in self.extra_of:
                self.counters.reevaluations += outcome is not None
                self.reevaluated(entry, outcome if outcome is not None else Failure("not measured"), bounds)
                continue
            unit = entry
            if bounds is not None:
                self.interval[unit] = bounds
            if gap is not None:
                self.kernel_gap[unit] = gap
            if outcome is not None:
                self.learn(unit, outcome, fresh=True)
                continue
            self.record_evaluations(unit, "bound")  # the mesh bound alone came back
            if unit in self.held:
                self.learn(unit, self.held.pop(unit), fresh=False)
            else:
                self.classify(unit)


# --------------------------------------------------------------------------- evaluation


def _placed_gap(corners_a: list[tuple[float, float, float]], corners_b: list[tuple[float, float, float]],
                placement: Any) -> float:
    """The distance between the axis-aligned hulls of a's box corners and b's placed ones."""
    return _hull_gap(corners_a, [placement.apply(corner) for corner in corners_b])


def _run_entry(shapes: Mapping[str, Any], corners: Callable[[str], list], mesh: Any, entry: tuple,
               threads: bool) -> tuple:
    """One entry: (id, a, b, b's placement rows, mode). Mode ("plain",) measures; ("both",)
    measures and queries the mesh; ("fast", cap, limit, measure) queries the mesh first and skips the
    measurement where its lower bound exceeds the cap or the prune limit by SLACK_MM, or where
    `measure` is false. Returns (id, (distance, volume) | the kernel error | None, the mesh bounds
    (lower, upper, mesh distance, deviation) | None, the box gap given to the kernel | None,
    kernel seconds, mesh seconds), plain values that pickle under any module name."""
    entry_id, a, b, rows, mode = entry
    placement = pose.Rigid(*rows)
    query, query_seconds = None, 0.0
    if mesh is not None and mode[0] in ("fast", "both"):
        started = time.perf_counter()
        found = mesh.query(a, b, placement)
        query_seconds = time.perf_counter() - started
        query = (found.lower_mm, found.upper_mm, found.mesh_mm, found.deviation_a_mm + found.deviation_b_mm)
        if mode[0] == "fast" and (not mode[3] or found.lower_mm - SLACK_MM > min(mode[1], mode[2])):
            return entry_id, None, query, None, 0.0, query_seconds
    gap = _placed_gap(corners(a), corners(b), placement)
    started = time.perf_counter()
    try:
        result: Any = pose.interference(shapes[a], pose.placed(shapes[b], placement), box_gap=gap, threads=threads)
    except Exception as error:  # noqa: BLE001 - OCP raises Standard_Failure on broken input
        result = str(error) or type(error).__name__
    return entry_id, result, query, gap, time.perf_counter() - started, query_seconds


def _run_task(shapes: Mapping[str, Any], corners: Callable[[str], list], mesh: Any, task: tuple, threads: bool,
              deadline: float = math.inf) -> tuple:
    """A task's entries in order, up to `deadline` (this process only): (task id, rows, pid, seconds)."""
    started = time.perf_counter()
    task_id, entries = task
    rows = []
    for entry in entries:
        if time.monotonic() > deadline:
            break
        rows.append(_run_entry(shapes, corners, mesh, entry, threads))
    return task_id, rows, os.getpid(), time.perf_counter() - started


class _InProcess:
    """Runs tasks in this process, one at a time."""

    capacity = 1

    def __init__(self, measurer: PairMeasurer) -> None:
        self.measurer = measurer
        self.done: deque[tuple] = deque()

    def submit(self, task: tuple, deadline: float) -> None:
        m = self.measurer
        self.done.append(_run_task(m.shapes, m.corners, m.mesh, task, m.threads, deadline))

    def next(self, deadline: float) -> tuple | None:
        return self.done.popleft()

    def terminate(self) -> None:
        self.done.clear()

    def close(self) -> None:
        self.done.clear()


# A worker loads this module by path (the parent may have loaded it under any main module) and
# rebuilds the definitions from BinTools bytes, as a TopoDS_Shape does not pickle.
_WORKER_START = """
import importlib.util, sys
if "cad_motion_pair_measure" not in sys.modules:
    spec = importlib.util.spec_from_file_location("cad_motion_pair_measure", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
sys.modules["cad_motion_pair_measure"]._start_worker(blobs, parent, mesh, assets)
"""
_WORKER_SHAPES: dict[str, Any] = {}
_WORKER_CORNERS: dict[str, list] = {}
_WORKER_MESH: Any = None  # this worker's mesh_bound.MeshBounds over the parent's assets


def _start_worker(blobs: Mapping[str, bytes], parent: int, mesh: tuple[float, float] | None,
                  assets: str | None) -> None:
    """A worker's initializer: die with `parent`, rebuild the definitions and, with `mesh` (linear,
    angular deflections), query the parent's mesh `assets` file; BVHs and classifiers are built on
    first use."""
    global _WORKER_MESH
    from OCP.BinTools import BinTools
    from OCP.TopoDS import TopoDS_Shape

    _lifecycle().die_with(parent)
    for key, blob in blobs.items():
        shape = TopoDS_Shape()
        BinTools.Read_s(shape, io.BytesIO(blob))
        _WORKER_SHAPES[key] = shape
    if mesh is not None and assets is not None:
        name = "cad_motion_mesh_bound"
        module = sys.modules.get(name) or _load(name, Path(__file__).with_name("mesh_bound.py"))
        _WORKER_MESH = module.MeshBounds(_WORKER_SHAPES, *mesh, assets=module.MeshAssets.load(Path(assets)))


def _worker_corners(key: str) -> list:
    if key not in _WORKER_CORNERS:
        _WORKER_CORNERS[key] = list(itertools.product(*zip(*pose.box_corners(_WORKER_SHAPES[key], tolerance=True))))
    return _WORKER_CORNERS[key]


def _work(task: tuple) -> tuple:
    return _run_task(_WORKER_SHAPES, _worker_corners, _WORKER_MESH, task, False)


class _Workers:
    """A session's worker pool, started with its first task and kept for the session; two tasks per
    worker in flight."""

    def __init__(self, session: MeasurementSession) -> None:
        self.session = session
        self.capacity = 2 * session.measurer.jobs
        self.pool: concurrent.futures.ProcessPoolExecutor | None = None
        self.pending: dict[concurrent.futures.Future, int] = {}

    def submit(self, task: tuple, deadline: float) -> None:
        if self.pool is None:
            measurer = self.session.measurer
            blobs = {key: pose.shape_bytes(shape) for key, shape in measurer.shapes.items()}
            mesh = None if measurer.mesh is None else (measurer.mesh.linear, measurer.mesh.angular)
            self.pool = concurrent.futures.ProcessPoolExecutor(
                measurer.jobs, mp_context=multiprocessing.get_context(measurer.start_method), initializer=exec,
                initargs=(_WORKER_START, {"path": str(Path(__file__).resolve()), "blobs": blobs, "parent": os.getpid(),
                                          "mesh": mesh, "assets": self.session.assets_file()}))
        self.pending[self.pool.submit(_work, task)] = task[0]

    def next(self, deadline: float) -> tuple | None:
        """The next finished task's result, or None when `deadline` passes first."""
        timeout = None if math.isinf(deadline) else max(0.0, deadline - time.monotonic())
        done, _ = concurrent.futures.wait(self.pending, timeout=timeout, return_when=concurrent.futures.FIRST_COMPLETED)
        if not done:
            return None
        future = done.pop()
        self.pending.pop(future)
        try:
            return future.result()
        except concurrent.futures.process.BrokenProcessPool as error:
            self.terminate()
            raise pose.MotionError(f"a pair measuring worker process died: {error}") from error

    def terminate(self) -> None:
        """Kill the workers, mid-task too, and drop the pool; a later task starts a new one."""
        pool, self.pool = self.pool, None
        self.pending.clear()
        if pool is None:
            return
        kill = getattr(pool, "kill_workers", None)  # Python 3.14; before, only the executor's own process map
        if kill is not None:
            kill()
        else:
            for process in list((getattr(pool, "_processes", None) or {}).values()):
                process.kill()
        pool.shutdown(wait=True, cancel_futures=True)

    def close(self) -> None:
        pool, self.pool = self.pool, None
        self.pending.clear()
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)


def _lifecycle() -> Any:
    """cad-flow's process_lifecycle (die_with), loaded once per process by path."""
    return sys.modules.get("cad_flow_process_lifecycle") or _load("cad_flow_process_lifecycle", LIFECYCLE_PATH)


# --------------------------------------------------------------------------- the cache


@dataclass(frozen=True)
class _Reading:
    """A stored exact reading at one placement of a bucket."""

    exact_fp: bytes
    transform: bytes
    distance: float
    volume: float
    seconds: float


@dataclass(frozen=True)
class _Row:
    """A stored decision row at one placement of a bucket: an interval on the distance there."""

    key: bytes
    exact_fp: bytes
    transform: bytes
    lower: float
    upper: float
    mesh_mm: float | None
    deviation: float
    method: str
    validation: str | None


_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS measurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ga BLOB NOT NULL, gb BLOB NOT NULL, rule BLOB NOT NULL,
    bucket BLOB NOT NULL, transform BLOB NOT NULL, exact_fp BLOB NOT NULL, reading BLOB NOT NULL,
    seconds REAL NOT NULL, UNIQUE (ga, gb, rule, exact_fp));
CREATE INDEX IF NOT EXISTS measurements_bucket ON measurements (bucket);
CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key BLOB NOT NULL, exact_fp BLOB NOT NULL, ga BLOB NOT NULL,
    gb BLOB NOT NULL, rule BLOB NOT NULL, bucket BLOB NOT NULL, transform BLOB NOT NULL, mode TEXT NOT NULL,
    minimum_mm REAL NOT NULL, outcome TEXT NOT NULL, lower_mm REAL NOT NULL, upper_mm REAL, mesh_mm REAL,
    deviation_mm REAL NOT NULL, method TEXT NOT NULL, measurement_id INTEGER, seconds REAL NOT NULL,
    validation_json TEXT, UNIQUE (key, exact_fp));
CREATE INDEX IF NOT EXISTS evaluations_bucket ON evaluations (bucket);
CREATE INDEX IF NOT EXISTS evaluations_pair ON evaluations (ga, gb, rule);
CREATE TABLE IF NOT EXISTS pair_cost (
    ga BLOB NOT NULL, gb BLOB NOT NULL, rule BLOB NOT NULL, mode TEXT NOT NULL, seconds REAL NOT NULL,
    observations INTEGER NOT NULL, PRIMARY KEY (ga, gb, rule, mode));
PRAGMA user_version = {SCHEMA_VERSION};
"""
_LOOKUP_BATCH = 500


class PairCache:
    """Pair results kept across runs and tools in `directory`/pairs-v2.sqlite (WAL; `-wal` and
    `-shm` beside it, all three named in `directory`/.gitignore): exact readings, decisions and
    per-pair costs (see the module). Keys are content addresses, so a changed definition or rule only
    stops finding old rows. This process alone writes, one transaction per committed task chunk,
    INSERT OR IGNORE for readings, so concurrent runs share the file. Past `max_bytes` of live pages
    the oldest rows go, down to CACHE_TRIM_TO of it. Any SQLite or file error turns the cache off for
    the rest of the run with a note on stderr: the run then evaluates what it would have read."""

    IGNORED = (CACHE_FILE, f"{CACHE_FILE}-wal", f"{CACHE_FILE}-shm")

    def __init__(self, directory: Path, max_bytes: int = CACHE_MAX_BYTES) -> None:
        self.path = directory / CACHE_FILE
        self.max_bytes = max_bytes
        self.connection: sqlite3.Connection | None = None
        self.commits = 0
        try:
            directory.mkdir(parents=True, exist_ok=True)
            _ignore(directory / ".gitignore", self.IGNORED)
            self.connection = sqlite3.connect(self.path, timeout=60.0)
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=NORMAL")
            version = self.connection.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, SCHEMA_VERSION):
                raise sqlite3.DatabaseError(f"schema version {version}, expected {SCHEMA_VERSION}")
            self.connection.executescript(_SCHEMA)
        except (sqlite3.Error, OSError) as error:
            self._off(error)

    @property
    def usable(self) -> bool:
        return self.connection is not None

    def lookup(self, rule: bytes, units: Sequence[_Unit]) -> list[tuple[list[_Reading], list[_Row]]]:
        """Per unit: the exact readings and the decision rows its bucket holds under `rule`, at any
        placement in it (its own exact fingerprint among them or not)."""
        empty: list[tuple[list[_Reading], list[_Row]]] = [([], []) for _ in units]
        if self.connection is None:
            return empty
        readings: dict[tuple[bytes, bytes, bytes], list[_Reading]] = defaultdict(list)
        rows: dict[tuple[bytes, bytes, bytes], list[_Row]] = defaultdict(list)
        try:
            buckets = sorted({unit.bucket for unit in units})
            for start in range(0, len(buckets), _LOOKUP_BATCH):
                chunk = buckets[start:start + _LOOKUP_BATCH]
                marks = ", ".join("?" * len(chunk))
                for ga, gb, bucket, fp, transform, value, seconds in self.connection.execute(
                        "SELECT ga, gb, bucket, exact_fp, transform, reading, seconds FROM measurements "
                        f"WHERE rule = ? AND bucket IN ({marks})", (rule, *chunk)):
                    readings[(bytes(ga), bytes(gb), bytes(bucket))].append(
                        _Reading(bytes(fp), bytes(transform), *struct.unpack("<2d", value), seconds))
                for ga, gb, bucket, key, fp, transform, lower, upper, mesh_mm, deviation, method, validation in \
                        self.connection.execute(
                            "SELECT ga, gb, bucket, key, exact_fp, transform, lower_mm, upper_mm, mesh_mm, deviation_mm, "
                            f"method, validation_json FROM evaluations WHERE rule = ? AND bucket IN ({marks})",
                            (rule, *chunk)):
                    rows[(bytes(ga), bytes(gb), bytes(bucket))].append(_Row(
                        bytes(key), bytes(fp), bytes(transform), lower, _infinite(upper), mesh_mm, deviation, method,
                        validation))
        except (sqlite3.Error, struct.error, TypeError, ValueError) as error:
            self._off(error)
            return empty
        return [(readings.get((u.ga, u.gb, u.bucket), []), rows.get((u.ga, u.gb, u.bucket), [])) for u in units]

    def costs(self, rule: bytes) -> dict[tuple[bytes, bytes], float]:
        """(ga, gb) -> the largest kernel seconds observed under `rule`."""
        if self.connection is None:
            return {}
        try:
            return {(bytes(ga), bytes(gb)): seconds for ga, gb, seconds in self.connection.execute(
                "SELECT ga, gb, seconds FROM pair_cost WHERE rule = ? AND mode = 'exact'", (rule,))}
        except sqlite3.Error as error:
            self._off(error)
            return {}

    def commit_chunk(self, records: Sequence[tuple[str, tuple]]) -> bool:
        """Write one chunk's readings, decisions and costs in one transaction; True when committed."""
        if self.connection is None:
            return False
        kinds: dict[str, list[tuple]] = defaultdict(list)
        for kind, values in records:
            kinds[kind].append(values)
        try:
            with self.connection:
                self.connection.executemany(
                    "INSERT OR IGNORE INTO measurements (ga, gb, rule, bucket, transform, exact_fp, reading, seconds) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", kinds["measurement"])
                self.connection.executemany(
                    "INSERT OR REPLACE INTO evaluations (key, exact_fp, ga, gb, rule, bucket, transform, mode, minimum_mm, "
                    "outcome, lower_mm, upper_mm, mesh_mm, deviation_mm, method, measurement_id, seconds, validation_json) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN (SELECT id FROM measurements "
                    "WHERE ga = ?3 AND gb = ?4 AND rule = ?5 AND exact_fp = ?2) END, ?, ?)", kinds["evaluation"])
                self.connection.executemany(
                    "INSERT INTO pair_cost (ga, gb, rule, mode, seconds, observations) VALUES (?, ?, ?, ?, ?, 1) "
                    "ON CONFLICT (ga, gb, rule, mode) DO UPDATE SET seconds = max(seconds, excluded.seconds), "
                    "observations = observations + 1", kinds["cost"])
            self.commits += 1
            if self.commits % CACHE_TRIM_EVERY == 0:
                self.trim()
        except sqlite3.Error as error:
            self._off(error)
            return False
        return True

    def trim(self) -> None:
        """Past max_bytes of live pages, delete the oldest rows of each table down to CACHE_TRIM_TO of it."""
        if self.connection is None:
            return
        try:
            page_size, pages, free = (self.connection.execute(f"PRAGMA {name}").fetchone()[0]
                                      for name in ("page_size", "page_count", "freelist_count"))
            live = (pages - free) * page_size
            if live <= self.max_bytes:
                return
            keep = CACHE_TRIM_TO * self.max_bytes / live
            with self.connection:
                for table in ("measurements", "evaluations"):
                    rows = self.connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    self.connection.execute(f"DELETE FROM {table} WHERE id NOT IN (SELECT id FROM {table} ORDER BY id "
                                            f"DESC LIMIT ?)", (int(rows * keep),))
        except sqlite3.Error as error:
            self._off(error)

    def close(self) -> None:
        """Hold the size cap and close the file."""
        self.trim()
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


def _ignore(path: Path, names: Sequence[str]) -> None:
    """Make `path` (.gitignore) list each of `names`, appending the missing ones."""
    present = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    missing = [name for name in names if name not in present]
    if missing:
        prefix = "\n" if present and not path.read_text(encoding="utf-8").endswith("\n") else ""
        with path.open("a", encoding="utf-8") as handle:
            handle.write(prefix + "".join(f"{name}\n" for name in missing))


def default_cache_dir(hw: Path) -> Path:
    """The pair cache directory of a hardware record: hw/.cad."""
    return hw / ".cad"


# --------------------------------------------------------------------------- helpers


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


def _finite(value: float) -> float | None:
    return None if math.isinf(value) else value


def _infinite(value: float | None) -> float:
    return math.inf if value is None else value


def _hull_gap(moved_a: list[tuple[float, float, float]], moved_b: list[tuple[float, float, float]]) -> float:
    """The distance between the axis-aligned hulls of two point sets."""
    total = 0.0
    for k in range(3):
        low_a, high_a = min(p[k] for p in moved_a), max(p[k] for p in moved_a)
        low_b, high_b = min(p[k] for p in moved_b), max(p[k] for p in moved_b)
        total += max(0.0, low_b - high_a, low_a - high_b) ** 2
    return math.sqrt(total)


def face_count(shape: Any) -> int:
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer

    explorer, count = TopExp_Explorer(shape, TopAbs_FACE), 0
    while explorer.More():
        count += 1
        explorer.Next()
    return count
