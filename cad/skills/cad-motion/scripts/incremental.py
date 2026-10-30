"""Incremental selection for cad-model `check` and cad-motion `sweep`: what changed between two
built versions, which occurrence pairs that touches, and the smoke samples of a chain.

Kernel-free: stdlib, plus PyYAML through pose.py.

What a pair check depends on is a version's state (`version_state`):
  - each PN's geometry identity, the hash of the DATA section of parts/<PN>.step
    (pose.step_data_hash). A rebuild that changes only the STEP header timestamp, or a model.py
    edit that yields the same entities, is no change: the source hash is reported, never selected;
  - each occurrence's PN and its nominal placement (the manifest's pose transforms);
  - the kinematic chain of the version's record snapshot, rebuilt without geometry;
  - each occurrence pair's policy, read from the snapshot: the joints between the pair, its
    declared press and running fits and heat-set inserts, and its clearance requirement with
    that requirement's margin.

`select_pairs` selects a pair that is new, whose definition geometry changed on either side, whose
relative nominal placement T_a^-1 T_b has other bits, or whose policy changed. No tolerance hides a
small move: a pair whose placement differs only by rounding, as a displacement of the whole
product leaves it, is measured again and meets its cached reading through the pair cache's rounded
bucket. With `moving` (sweeps), it also selects a pair whose relative placement has other bits at any
probe pose: the nominal pose, plus PROBES values across each independent joint's range with the
other joints at nominal. It selects a pair, too, when a coupling law on the joint paths from the
pair's common ancestor changed. Removed occurrences and pairs are reported. With no baseline,
every pair is selected, and the selection says why.

Smoke samples (`smoke_samples`) cover each independent joint with the others at nominal. A
revolute joint gets SMOKE_STEP_DEG steps across its range plus both endpoints; a prismatic joint
gets its endpoints and midpoint. The joint's events come on top:
  - the top dead centre of every slider-crank, at driver = -phase + 360 k;
  - the dwell boundaries, dwell midpoints and extrema of every periodic table. These are
    equal-output knot segments and slope sign changes, at driver = knot - phase + period k.
Each event's driver value is inverted through the linear couplings up to the independent root.
A law reached through a non-linear coupling is reported in `unsupported`, and its events are
found by sampling its root every FINE_STEP instead. Samples that pose every occurrence identically
are one sample (720 degrees is 0 for an engine whose every law repeats in 720), so the count
may exceed the base grid's. A smoke pass is partial evidence: it can find a collision early, but
never shows a range collision-free.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
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
pose = _load("cad_motion_pose", HERE / "pose.py")
pair_policy = _load("cad_motion_pair_policy", HERE / "pair_policy.py")
coupling = pose.coupling
MotionError = pose.MotionError

PROBES = 9        # probe values per independent joint for moving-pair selection, endpoints included
SMOKE_STEP_DEG = 60.0
FINE_STEP = 0.25  # deg or mm: how finely a non-linear mapping's root is sampled for its events
FINE_SAMPLES = 20001
SAME_VALUE = 1e-9  # deg or mm: event and sample coordinates this close are one
SMOKE_KINDS = frozenset({"tdc", "dwell_boundary", "dwell_midpoint", "extremum"})

Pair = tuple[str, str]


# --------------------------------------------------------------------------- version state


@dataclass(frozen=True)
class VersionState:
    """What the pair checks of one built version depend on (see the module docstring)."""

    label: str
    geometry: Mapping[str, bytes]           # PN -> geometry identity
    occurrences: Mapping[str, str]          # occurrence id -> PN
    placements: Mapping[str, Any]           # occurrence id -> nominal pose.Rigid
    policies: Mapping[Pair, str] = field(default_factory=dict)  # sorted pair -> canonical policy
    chain: Any = None                       # pose.Chain of the record snapshot; None: no motion
    sources: Mapping[str, str] = field(default_factory=dict)    # PN -> model source sha256


def _rigid(rows: Sequence[Sequence[float]]) -> Any:
    return pose.Rigid(tuple(tuple(float(v) for v in row[:3]) for row in rows),  # type: ignore[arg-type]
                      tuple(float(row[3]) for row in rows))


def _policy_entry(kind: str, item: Mapping[str, Any]) -> str:
    return json.dumps({"kind": kind, **{k: v for k, v in item.items() if k not in ("pair", "source")}},
                      sort_keys=True)


def pair_policies(record: Path, assembly: Any, joint_pairs: Iterable[Mapping[str, Any]],
                  margins: Any = None) -> dict[Pair, str]:
    """Canonical policy text per occurrence pair from record snapshot `record`: joints between the
    pair, declared fits and inserts, and clearance requirements with their margin (`margins`, a
    cad-record ClearanceMargins; None: margins are not part of the policy). Declaration order
    and record paths are left out."""
    try:
        interfaces = pair_policy.read_interfaces(record)
        declared = {"press_fit": pair_policy.declared_press_fits(record, interfaces, assembly),
                    "running_fit": pair_policy.declared_running_fits(record, interfaces, assembly),
                    "heat_set": pair_policy.declared_heat_sets(record, interfaces, assembly),
                    "clearance": pair_policy.declared_clearances(record, interfaces, assembly)}
    except pair_policy.PolicyError as error:
        raise MotionError(str(error)) from error
    entries: dict[Pair, list[str]] = defaultdict(list)
    for kind, items in declared.items():
        for item in items:
            if kind == "clearance" and margins is not None:
                item = {**item, "margin_mm": margins.for_interface(item["interface"])}
            entries[tuple(item["pair"])].append(_policy_entry(kind, item))  # type: ignore[index]
    for joint in joint_pairs:
        entries[tuple(sorted(joint["pair"]))].append(_policy_entry("joint", {"type": joint["type"]}))  # type: ignore[index]
    return {pair: "\n".join(sorted(texts)) for pair, texts in entries.items()}


def _margins(record: Path) -> Any:
    rules = _load("cad_record_design_rules", HERE.parents[1] / "cad-record" / "scripts" / "design_rules.py")
    try:
        return rules.load_clearance_margins(record)
    except ValueError as error:
        raise MotionError(str(error)) from error


def built_chain(assembly: Any, built: Iterable[str], attach: Iterable[str] = ()) -> Any:
    """The kinematic chain a version was built with, without geometry: `assembly` (pose.Assembly of
    its record snapshot), the `built` PNs and the version's --attach options. Its nominal transforms
    are the version's placements; its relative transforms are the sweep's."""
    return pose.assembly_chain(assembly, dict.fromkeys(built), pose.attach_joints(attach, assembly))


def version_state(hw: Path, label: str) -> VersionState:
    """The state of built version `label` of `hw`, from its verified manifest, its per-part STEP
    files and its record snapshot. MotionError when it is not built, fails its manifest or
    predates occurrence records."""
    try:
        label, folder, record = pose.LAYOUT.built_version(hw, label)
    except pose.LAYOUT.LayoutError as error:
        raise MotionError(f"version {label}: {error}") from error
    path = folder / "manifest.json"
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        occurrences = {oid: str(entry["PN"]) for oid, entry in manifest["occurrences"].items()}
        placements = {oid: _rigid(rows) for oid, rows in manifest["pose"]["transforms"].items()}
        parts = {pn: folder / info["step"] for pn, info in manifest["parts"].items()}
        sources = {pn: str(info.get("source_sha256")) for pn, info in manifest["parts"].items()}
        joint_pairs, attach = list(manifest["joint_pairs"]), list(manifest.get("attach", []))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
        raise MotionError(f"{path}: not a manifest with occurrences and a nominal pose ({type(error).__name__}: "
                          f"{error}); rebuild that version") from error
    if set(placements) != set(occurrences):
        raise MotionError(f"{path}: the nominal pose and the occurrences name different occurrences")
    geometry = {pn: pose.step_data_hash(step) for pn, step in parts.items()}
    assembly = pose.load_assembly(record, record)
    chain = built_chain(assembly, parts, attach)
    policies = pair_policies(record, assembly, joint_pairs, _margins(record))
    return VersionState(label, geometry, occurrences, placements, policies, chain, sources)


# --------------------------------------------------------------------------- change set and selection


@dataclass(frozen=True)
class PairSelection:
    """The pairs a changed-only check measures, each with why; the rest is `unchanged`."""

    selected: Mapping[Pair, tuple[str, ...]]
    unchanged: frozenset[Pair]
    removed: tuple[Pair, ...]          # baseline pairs whose occurrences are gone
    baseline: str | None
    reason: str | None = None          # why every pair is selected, when there is no baseline

    def scope(self) -> dict[str, Any]:
        """The `scope` block of a changed-only report: never a complete pass."""
        counts: dict[str, int] = defaultdict(int)
        for reasons in self.selected.values():
            for reason in reasons:
                counts[reason] += 1
        return {"kind": "changed_pairs", "complete": False, "baseline": self.baseline,
                **({"full_selection": self.reason} if self.reason else {}),
                "selected_pairs": len(self.selected), "unchanged_pairs": len(self.unchanged),
                "reasons": dict(sorted(counts.items())), "removed_pairs": [list(pair) for pair in self.removed]}


@dataclass(frozen=True)
class ChangeSet:
    """`current` against `baseline` (None: no baseline, `reason` says why), per entity."""

    current: VersionState
    baseline: VersionState | None
    reason: str
    geometry: tuple[str, ...] = ()     # PNs whose geometry identity changed or that are new
    source_only: tuple[str, ...] = ()  # PNs whose model source changed while the geometry did not
    added: tuple[str, ...] = ()        # occurrence ids
    removed: tuple[str, ...] = ()
    moved: tuple[str, ...] = ()        # occurrences whose nominal placement changed

    def select(self, pairs: Iterable[Pair], *, moving: bool = False) -> PairSelection:
        return select_pairs(pairs, self.current, self.baseline, moving=moving, reason=None if self.baseline else self.reason)

    def to_json(self) -> dict[str, Any]:
        return {"current": self.current.label, "baseline": self.baseline.label if self.baseline else None,
                "reason": self.reason, "geometry_changed": list(self.geometry),
                "source_only_changed": list(self.source_only), "added_occurrences": list(self.added),
                "removed_occurrences": list(self.removed), "moved_occurrences": list(self.moved)}


def _same(a: Any, b: Any) -> bool:
    """Whether two placements have the same bits (-0.0 is 0.0)."""
    return a.rot == b.rot and a.trans == b.trans


def _label_number(label: str) -> int:
    match = pose.VERSION_LABEL.match(label)
    if not match:
        raise MotionError(f"not a version label: {label!r}")
    return int(match.group(1))


def compare_versions(hw: Path, current: str, baseline: str | None = None) -> ChangeSet:
    """`current` against `baseline`, by default the newest built version before it. An explicit
    baseline that is not another built version, or a baseline that fails its manifest, raises
    MotionError; no earlier built version gives a ChangeSet without a baseline."""
    state = version_state(hw, current)
    if baseline is None:
        earlier = [label for label in pose.LAYOUT.versions(hw) if _label_number(label) < _label_number(state.label)]
        if not earlier:
            return ChangeSet(state, None, f"no built version before {state.label}: every pair is selected")
        baseline, how = earlier[-1], "the newest built version before it"
    else:
        how = "--since-version"
        if baseline in (current, state.label):
            raise MotionError(f"--since-version {baseline}: the baseline must be another built version")
    base = version_state(hw, baseline)
    geometry = tuple(sorted(pn for pn, gid in state.geometry.items() if base.geometry.get(pn) != gid))
    source_only = tuple(sorted(pn for pn, sha in state.sources.items()
                               if pn in base.sources and base.sources[pn] != sha and pn not in geometry))
    added = tuple(sorted(set(state.occurrences) - set(base.occurrences)))
    removed = tuple(sorted(set(base.occurrences) - set(state.occurrences)))
    moved = tuple(sorted(oid for oid, placement in state.placements.items()
                         if oid in base.placements and not _same(placement, base.placements[oid])))
    return ChangeSet(state, base, f"baseline {base.label}: {how}", geometry, source_only, added, removed, moved)


def _law_signature(law: Any) -> str:
    if isinstance(law, coupling.Linear):
        return repr(("linear", law.driver, law.ratio, law.offset))
    if isinstance(law, coupling.PeriodicTable):
        return repr(("periodic_table", law.driver, law.profile.period, law.profile.knots, law.phase))
    m = law.mechanism
    return repr(("slider_crank", law.driver, law.output, m.radius, m.length, m.phase))


class _Motion:
    """Per pair of one state's chain: relative placements at the probe poses and the coupling laws
    on the pair's joint paths."""

    def __init__(self, chain: Any) -> None:
        self.chain = chain
        self.keys: tuple[Any, ...] = ("nominal",)
        self.values = [chain.complete({})]
        for joint in chain.independent:
            for k in range(PROBES):
                value = joint.min + (joint.max - joint.min) * k / (PROBES - 1)
                self.keys += ((joint.id, k),)
                self.values.append(chain.complete({joint.id: value}))
        self.relative: dict[Pair, list[Any]] = {}

    def measure(self, pairs: Sequence[Pair]) -> None:
        known = set(self.chain.ids)
        wanted = [p for p in pairs if p[0] in known and p[1] in known and p not in self.relative]
        rows: dict[Pair, list[Any]] = {p: [] for p in wanted}
        for values in self.values:
            for pair, rigid in self.chain.relative_transforms(values, wanted).items():
                rows[pair].append(rigid)
        self.relative.update(rows)

    def laws(self, pair: Pair) -> tuple[str, ...]:
        """The coupling laws that move the pair's own joints, through their drivers to the roots."""
        paths = [self.chain.path(oid) for oid in pair]
        depth = 0
        while depth < min(map(len, paths)) and paths[0][depth] is paths[1][depth]:
            depth += 1
        laws, found = self.chain.couplings.laws, []
        for joint in (j for path in paths for j in path[depth:]):
            jid = joint.id
            while jid in laws:
                found.append(f"{jid}: {_law_signature(laws[jid])}")
                jid = laws[jid].driver
        return tuple(sorted(set(found)))


def select_pairs(pairs: Iterable[Pair], current: VersionState, baseline: VersionState | None, *,
                 moving: bool = False, reason: str | None = None) -> PairSelection:
    """The pairs of `pairs` (sorted occurrence ids of `current`) whose checks can differ from
    `baseline`'s, with their reasons: added, geometry, placement, policy, and with `moving` also
    motion. Without a baseline, every pair is selected for `reason`."""
    pairs = sorted({tuple(sorted(p)) for p in pairs})  # type: ignore[misc]
    if baseline is None:
        why = reason or "no baseline"
        return PairSelection({p: ("no_baseline",) for p in pairs}, frozenset(), (), None, why)
    selected: dict[Pair, tuple[str, ...]] = {}
    unchanged: set[Pair] = set()
    motion_now = motion_then = None
    if moving and current.chain is not None and baseline.chain is not None:
        motion_now, motion_then = _Motion(current.chain), _Motion(baseline.chain)
        comparable = motion_now.keys == motion_then.keys
        candidates = [p for p in pairs if all(o in baseline.occurrences for o in p)]
        motion_now.measure(candidates)
        motion_then.measure(candidates)
    for pair in pairs:
        a, b = pair
        if any(baseline.occurrences.get(o) != current.occurrences[o] for o in pair):
            selected[pair] = ("added",)
            continue
        reasons = []
        if any(current.geometry.get(current.occurrences[o]) != baseline.geometry.get(baseline.occurrences[o])
               for o in pair):
            reasons.append("geometry")
        now = current.placements[a].inverse() @ current.placements[b]
        then = baseline.placements[a].inverse() @ baseline.placements[b]
        if not _same(now, then):
            reasons.append("placement")
        if current.policies.get(pair) != baseline.policies.get(pair):
            reasons.append("policy")
        if motion_now is not None and motion_then is not None:
            seen_now, seen_then = motion_now.relative.get(pair), motion_then.relative.get(pair)
            if (not comparable or seen_now is None or seen_then is None
                    or not all(_same(x, y) for x, y in zip(seen_now, seen_then))
                    or motion_now.laws(pair) != motion_then.laws(pair)):
                reasons.append("motion")
        if reasons:
            selected[pair] = tuple(reasons)
        else:
            unchanged.add(pair)
    gone = set(baseline.occurrences) - set(current.occurrences)
    removed = tuple(p for p in _all_pairs(baseline.occurrences) if p[0] in gone or p[1] in gone)
    return PairSelection(selected, frozenset(unchanged), removed, baseline.label)


def _all_pairs(occurrences: Iterable[str]) -> Iterable[Pair]:
    ids = sorted(occurrences)
    return ((a, b) for i, a in enumerate(ids) for b in ids[i + 1:])


# --------------------------------------------------------------------------- events and smoke samples


@dataclass(frozen=True)
class Event:
    """A known critical coordinate of independent joint `joint`: `kind` tdc, dwell_boundary,
    dwell_midpoint, extremum or knot; `source` names the mechanism or the coupled joint and its
    profile; `method` is analytic, or sampled (a non-linear mapping)."""

    joint: str
    value: float
    kind: str
    source: str
    method: str = "analytic"


def _linear_root(chain: Any, joint_id: str) -> tuple[str, float, float] | None:
    """(root, a, b) with q_joint = a q_root + b through linear couplings only; None when a non-linear
    law lies between `joint_id` and its root."""
    laws, a, b = chain.couplings.laws, 1.0, 0.0
    while joint_id in laws:
        law = laws[joint_id]
        if not isinstance(law, coupling.Linear):
            return None
        a, b = a * law.ratio, a * law.offset + b
        joint_id = law.driver
    return joint_id, a, b


def _periodic(chain: Any, driver: str, base: float, period: float) -> list[tuple[str, float]]:
    """Root coordinates where `driver` takes base + period k, within the root's range."""
    mapped = _linear_root(chain, driver)
    assert mapped is not None
    root_id, a, b = mapped
    root = chain.joint(root_id)
    low, high = sorted((a * root.min + b, a * root.max + b))
    found = []
    for k in range(math.ceil((low - base) / period - 1e-12), math.floor((high - base) / period + 1e-12) + 1):
        value = ((base + period * k) - b) / a
        if root.min - SAME_VALUE <= value <= root.max + SAME_VALUE:
            found.append((root_id, min(max(value, root.min), root.max)))
    return found


def _knot_events(profile: Any) -> list[tuple[float, str]]:
    """(profile input, kind) of each dwell boundary, dwell midpoint, extremum and other knot of a
    periodic piecewise-linear profile, read cyclically."""
    knots = profile.knots[:-1]  # the last knot is the first one period on
    n = len(knots)
    slopes = []
    for i in range(n):
        (x0, y0), (x1, y1) = profile.knots[i], profile.knots[i + 1]
        slopes.append(0 if y1 == y0 else (1 if y1 > y0 else -1))
    if not any(slopes):
        return []
    events = []
    for i, (x, _) in enumerate(knots):
        before, after = slopes[i - 1], slopes[i]
        kind = ("dwell_boundary" if (before == 0) != (after == 0) else
                "extremum" if before != after else "knot")
        events.append((x, kind))
    for i in range(n):  # dwell midpoints: maximal runs of flat segments, cyclically
        if slopes[i] == 0 and slopes[i - 1] != 0:
            end, length = i, 0.0
            while slopes[end % n] == 0:
                (x0, _), (x1, _) = profile.knots[end % n], profile.knots[end % n + 1]
                length += x1 - x0
                end += 1
            events.append((math.fmod(knots[i][0] + length / 2.0, profile.period), "dwell_midpoint"))
    return events


def _sampled(chain: Any, root: Any, quantity: Any, source: str, maxima_only: bool) -> list[Event]:
    """Events of `quantity(values)` found by sampling `root` every FINE_STEP: slope sign changes
    (extrema and dwell boundaries), flat-run midpoints, or with `maxima_only` the local maxima."""
    count = min(FINE_SAMPLES, max(2, math.ceil((root.max - root.min) / FINE_STEP) + 1))
    xs = [root.min + (root.max - root.min) * k / (count - 1) for k in range(count)]
    ys = [quantity(chain.complete({root.id: x})) for x in xs]
    signs = [0 if math.isclose(y1, y0, abs_tol=1e-12) else (1 if y1 > y0 else -1) for y0, y1 in zip(ys, ys[1:])]
    events: list[Event] = []
    for i in range(1, len(signs)):
        before, after = signs[i - 1], signs[i]
        if before == after:
            continue
        if maxima_only:
            if before > 0 > after or (before > 0 and after == 0):
                events.append(Event(root.id, xs[i], "tdc", source, "sampled"))
            continue
        kind = "dwell_boundary" if (before == 0) != (after == 0) else "extremum"
        events.append(Event(root.id, xs[i], kind, source, "sampled"))
        if after == 0:
            end = i
            while end < len(signs) and signs[end] == 0:
                end += 1
            events.append(Event(root.id, (xs[i] + xs[end]) / 2.0, "dwell_midpoint", source, "sampled"))
    return events


def events(chain: Any) -> tuple[tuple[Event, ...], tuple[str, ...]]:
    """Every event of `chain` within its independent joints' ranges, and the sources reached
    through a non-linear coupling (their events sampled)."""
    found: list[Event] = []
    unsupported: list[str] = []
    laws = chain.couplings.laws
    in_chain = {j.id for j in chain.movable}
    mechanisms = {law.mechanism.id: law.mechanism for jid, law in laws.items()
                  if jid in in_chain and isinstance(law, coupling.MechanismOutput)}
    for mechanism in sorted(mechanisms.values(), key=lambda m: m.id):
        source = f"{mechanism.id} (driver {mechanism.driver})"
        if _linear_root(chain, mechanism.driver) is not None:
            found += [Event(root, value, "tdc", source) for root, value in _periodic(chain, mechanism.driver,
                                                                                      -mechanism.phase, 360.0)]
        else:
            root = chain.joint(chain.couplings.root(mechanism.driver))
            unsupported.append(f"{source}: reached from {root.id} through a non-linear coupling; its top dead "
                               f"centres were found by sampling every {FINE_STEP:g} {root.unit}")
            found += _sampled(chain, root, lambda values, m=mechanism: m.displacement(values[m.driver]), source, True)
    for jid in sorted(j for j in in_chain if isinstance(laws.get(j), coupling.PeriodicTable)):
        law = laws[jid]
        source = f"{jid} {law.profile.name}"
        if _linear_root(chain, law.driver) is not None:
            for x, kind in _knot_events(law.profile):
                found += [Event(root, value, kind, source)
                          for root, value in _periodic(chain, law.driver, x - law.phase, law.profile.period)]
        else:
            root = chain.joint(chain.couplings.root(law.driver))
            unsupported.append(f"{source}: reached from {root.id} through a non-linear coupling; its events were "
                               f"found by sampling every {FINE_STEP:g} {root.unit}")
            found += _sampled(chain, root, lambda values, j=jid: values[j], source, False)
    found.sort(key=lambda e: (e.joint, e.value, e.kind, e.source))
    return tuple(found), tuple(unsupported)


def breakpoints(chain: Any) -> dict[str, tuple[float, ...]]:
    """Per independent joint, the distinct coordinates of its events, knots included: where a
    continuous check splits its intervals so it does not average a narrow known ramp away."""
    values: dict[str, list[float]] = defaultdict(list)
    for event in events(chain)[0]:
        if not values[event.joint] or event.value - values[event.joint][-1] > SAME_VALUE:
            values[event.joint].append(event.value)
    return {joint: tuple(found) for joint, found in values.items()}


@dataclass(frozen=True)
class SmokeSample:
    """One smoke pose: independent joint `joint` at `value`, the others at nominal."""

    joint: str
    value: float
    unit: str
    labels: tuple[str, ...]

    @property
    def settings(self) -> dict[str, float]:
        return {self.joint: self.value}


@dataclass(frozen=True)
class SmokePlan:
    samples: tuple[SmokeSample, ...]
    events: tuple[Event, ...]
    unsupported: tuple[str, ...]

    def coverage(self) -> dict[str, Any]:
        kinds: dict[str, int] = defaultdict(int)
        for event in self.events:
            if event.kind in SMOKE_KINDS:
                kinds[event.kind] += 1
        return {"kind": "smoke", "complete": False, "samples": len(self.samples), "base_step_deg": SMOKE_STEP_DEG,
                "events": dict(sorted(kinds.items())), "unsupported": list(self.unsupported),
                "limitation": "smoke samples can find a collision early; they never show the range collision-free, "
                              "so the full sweep is still required"}


def _base(joint: Any) -> list[tuple[float, str]]:
    if joint.type == "revolute":
        steps = int(math.floor((joint.max - joint.min) / SMOKE_STEP_DEG + 1e-9))
        values = [(joint.min + SMOKE_STEP_DEG * k, "base") for k in range(steps + 1)]
    else:
        values = [((joint.min + joint.max) / 2.0, "midpoint")]
    return [(joint.min, "endpoint"), *values, (joint.max, "endpoint")]


def _pose_key(chain: Any, settings: Mapping[str, float]) -> tuple[Any, ...]:
    transforms = chain.transforms(chain.complete(settings))
    return tuple((oid, rigid.rot, rigid.trans) for oid, rigid in sorted(transforms.items()))


def smoke_samples(chain: Any) -> SmokePlan:
    """The smoke samples of `chain` (see the module docstring): every independent joint's base grid
    and endpoints plus its events, one sample per distinct pose, in joint then value order."""
    found, unsupported = events(chain)
    samples: list[SmokeSample] = []
    poses: dict[tuple[Any, ...], int] = {}
    for joint in chain.independent:
        labelled = _base(joint) + [(e.value, f"{e.kind} {e.source}") for e in found
                                   if e.joint == joint.id and e.kind in SMOKE_KINDS]
        labelled.sort(key=lambda item: item[0])
        merged: list[tuple[float, list[str]]] = []
        for value, label in labelled:
            if merged and value - merged[-1][0] <= SAME_VALUE:
                if label not in merged[-1][1]:
                    merged[-1][1].append(label)
            else:
                merged.append((value, [label]))
        for value, labels in merged:
            key = _pose_key(chain, {joint.id: value})
            if key in poses:
                earlier = samples[poses[key]]
                extra = tuple(f"{label} at {joint.id} = {value:g}" for label in labels)
                samples[poses[key]] = SmokeSample(earlier.joint, earlier.value, earlier.unit, earlier.labels + extra)
                continue
            poses[key] = len(samples)
            samples.append(SmokeSample(joint.id, value, joint.unit, tuple(labels)))
    return SmokePlan(tuple(samples), found, unsupported)
