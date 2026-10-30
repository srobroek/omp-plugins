"""Sweep subsystems: the record's subassemblies as owners of a sweep's pairs, and each one's period.

Kernel-free and standard-library only; sweep.py and merge_sweeps.py use it.

Ownership. A subsystem is an assembly.yaml subassembly (pose.Assembly.groups); no other declaration
exists. An occurrence is moving when a movable joint lies on its path from the ground; every moving
occurrence of the chain must belong to exactly one subassembly, so one that no subassembly lists
(an `--attach`ed part) or that two list (a legacy PN in two `parts` lists) is a problem, and so is a
subassembly named `interface` or `static`, the two reserved owners. Each pair a sweep measures (its
checked pairs and its requirement pairs) then has exactly one owner:

    moving / static            the moving occurrence's subassembly
    moving / moving, one owner that subassembly
    moving / moving, two       interface
    static / static            static

`--subsystem NAME` selects the pairs a name owns, not the pairs either body belongs to; the owners
partition the pairs, so the subsystem runs of every owner merge into the whole sweep.

Period. `detect_period` finds, for one independent joint's path, the smallest lag after which every
moving member of a subsystem is back where it was over a whole cycle: candidate lags are where a
member's transform returns to its start on the grid, and a candidate holds only when every member's
transform at q + lag equals the one at q, within PERIOD_ROT_ATOL and PERIOD_TRANS_MM (absolute; no
relative tolerance), for every grid value of a complete cycle [start, start + lag]. Transforms past
the joint's range are evaluated for that check only; they are not samples and carry no limit or
measurement. No candidate, or none that holds, leaves the period unverified, never a guessed 360 or
720. A 5.5:1 starter pinion on a crank returns with the crank only every 720 degrees: the crank's own
return at 360 is a candidate the pinion rejects. The period is evidence about the sampled
transforms; the sweep's samples and proofs still cover the joint's whole range.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

INTERFACE = "interface"
STATIC = "static"
RESERVED = (INTERFACE, STATIC)
PERIOD_ROT_ATOL = 1e-9  # rotation matrix entries
PERIOD_TRANS_MM = 1e-6  # translation components, mm
MAX_REJECTED = 10  # rejected candidate lags listed; `rejected_count` counts them all


class SubsystemError(ValueError):
    """The record's subassemblies do not partition the sweep's moving occurrences; `problems` lists why."""

    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = list(problems)


def pair_id(pair: tuple[str, str]) -> str:
    """The stable id of an occurrence pair in chain order."""
    return f"{pair[0]}|{pair[1]}"


@dataclass(frozen=True)
class PairPartition:
    """Every measured pair's owner. `owner_by_occurrence` maps each chain occurrence to its
    subassembly when it moves, else to `static`; `groups` lists the owning subassemblies in record
    order with their moving `members`; `all_pair_ids` the pairs in measuring order."""

    owner_by_occurrence: Mapping[str, str]
    pair_owner: Mapping[tuple[str, str], str]
    all_pair_ids: tuple[str, ...]
    groups: tuple[str, ...]
    members: Mapping[str, tuple[str, ...]]

    @property
    def owners(self) -> tuple[str, ...]:
        """Every owner of at least one pair: the subassemblies in record order, then interface, static."""
        used = set(self.pair_owner.values())
        return tuple(name for name in (*self.groups, *RESERVED) if name in used)

    def select(self, names: Iterable[str]) -> set[tuple[str, str]]:
        """The pairs the owners `names` own; an unknown name is a SubsystemError."""
        names = list(dict.fromkeys(names))
        known = (*self.groups, *RESERVED)
        unknown = [name for name in names if name not in known]
        if unknown:
            raise SubsystemError([f"--subsystem {name}: no such subsystem; subsystems: {', '.join(known)}"
                                  for name in unknown])
        wanted = set(names)
        return {pair for pair, owner in self.pair_owner.items() if owner in wanted}

    def digest(self) -> str:
        """sha256 of the partition as canonical JSON: which owner holds which pair, of which pairs."""
        document = {"owners": {pair_id(pair): owner for pair, owner in self.pair_owner.items()},
                    "occurrences": dict(self.owner_by_occurrence), "pairs": list(self.all_pair_ids)}
        return hashlib.sha256(json.dumps(document, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def moving_occurrences(chain: Any) -> list[str]:
    """Chain occurrences with a movable joint on their path from the ground, in chain order."""
    return [oid for oid in chain.ids if any(joint.movable for joint in chain.path(oid))]


def partition(chain: Any, groups: Sequence[Any], all_pairs: Sequence[tuple[str, str]]) -> PairPartition:
    """The owner of each pair in `all_pairs` (occurrence ids, chain order) under the subassemblies
    `groups` (assembly_data.Group: id, members). SubsystemError lists every problem."""
    problems = [f"subassembly {group.id!r} uses a reserved subsystem name" for group in groups
                if group.id in RESERVED]
    ids = [group.id for group in groups]
    problems += [f"subassembly id {name!r} is used {ids.count(name)} times; give each subassembly its own id"
                 for name in dict.fromkeys(ids) if ids.count(name) > 1]
    moving = moving_occurrences(chain)
    membership: dict[str, list[str]] = {oid: [] for oid in moving}
    for group in groups:
        for member in group.members:
            if member in membership and group.id not in membership[member]:
                membership[member].append(group.id)
    for oid, owners in membership.items():
        if not owners:
            problems.append(f"moving occurrence {chain.ref(oid)} belongs to no subassembly; list it in exactly one")
        elif len(owners) > 1:
            problems.append(f"moving occurrence {chain.ref(oid)} belongs to {len(owners)} subassemblies "
                            f"({', '.join(owners)}); list it in exactly one")
    if problems:
        raise SubsystemError(problems)
    owner = {oid: STATIC for oid in chain.ids}
    owner.update({oid: owners[0] for oid, owners in membership.items()})
    pair_owner = {}
    for a, b in all_pairs:
        first, second = owner[a], owner[b]
        if first == second:
            pair_owner[(a, b)] = first
        elif STATIC in (first, second):
            pair_owner[(a, b)] = second if first == STATIC else first
        else:
            pair_owner[(a, b)] = INTERFACE
    names = [group.id for group in groups if any(owner.get(member) == group.id for member in group.members)]
    members = {name: tuple(oid for oid in moving if owner[oid] == name) for name in names}
    return PairPartition(owner, pair_owner, tuple(pair_id(pair) for pair in all_pairs), tuple(names), members)


@dataclass(frozen=True)
class PeriodEvidence:
    """What the transforms of a subsystem's moving members show about its period along one joint:
    `status` verified (`period` in `unit`), unverified (`period` None, `reason` says why) or
    static (no member moves along the joint). `rejected` lists each candidate lag that failed,
    with the member and grid value where it failed and by how much."""

    joint: str
    unit: str
    status: str
    period: float | None
    grid: float
    rejected: tuple[dict[str, Any], ...] = ()  # the first MAX_REJECTED
    rejected_count: int = 0
    reason: str | None = None
    outside_range: int = 0  # transforms evaluated past the joint's range for the check; never samples

    def as_json(self) -> dict[str, Any]:
        return {"joint": self.joint, "unit": self.unit, "status": self.status, "period": self.period,
                "grid": self.grid, "tolerance": {"rotation": PERIOD_ROT_ATOL, "translation_mm": PERIOD_TRANS_MM,
                                                 "relative": 0.0},
                "rejected": list(self.rejected), "rejected_count": self.rejected_count, "reason": self.reason,
                "transforms_outside_range": self.outside_range}


def _deviation(first: Any, second: Any) -> tuple[float, float]:
    """(largest |rotation entry difference|, largest |translation component difference| mm)."""
    rotation = max(abs(x - y) for row, other in zip(first.rot, second.rot) for x, y in zip(row, other))
    translation = max(abs(x - y) for x, y in zip(first.trans, second.trans))
    return rotation, translation


def _same(first: Any, second: Any) -> bool:
    rotation, translation = _deviation(first, second)
    return rotation <= PERIOD_ROT_ATOL and translation <= PERIOD_TRANS_MM


@dataclass
class _Track:
    """Transforms along one joint's path on the grid, evaluated once per grid index."""

    low: float
    grid: float
    count: int  # grid values inside the range: indices 0 .. count - 1
    at: Callable[[float], Mapping[str, Any]]
    values: dict[int, Mapping[str, Any]] = field(default_factory=dict)
    outside: int = 0

    def __call__(self, index: int) -> Mapping[str, Any]:
        found = self.values.get(index)
        if found is None:
            found = self.values[index] = self.at(self.low + index * self.grid)
            self.outside += index >= self.count
        return found


def detect_periods(joint: Any, low: float, high: float, members: Mapping[str, Sequence[str]],
                   at: Callable[[float], Mapping[str, Any]], grid: float) -> dict[str, PeriodEvidence]:
    """PeriodEvidence per subsystem of `members` (name -> moving occurrence ids) along `joint` swept
    from `low` to `high` with the other joints fixed: `at(value)` gives every occurrence's transform
    at that joint value. Each grid value's transforms are evaluated once for every subsystem."""
    if not (math.isfinite(grid) and grid > 0):
        raise ValueError(f"period grid must be a finite positive step, got {grid!r}")
    count = int(math.floor((high - low) / grid + 1e-9)) + 1 if high >= low else 0
    track = _Track(low, grid, count, at)
    return {name: _detect(track, joint, list(ids)) for name, ids in members.items()}


def detect_period(joint: Any, low: float, high: float, members: Sequence[str],
                  at: Callable[[float], Mapping[str, Any]], grid: float) -> PeriodEvidence:
    """detect_periods for one subsystem."""
    return detect_periods(joint, low, high, {"subsystem": members}, at, grid)["subsystem"]


def _detect(track: _Track, joint: Any, members: list[str]) -> PeriodEvidence:
    evidence = {"joint": joint.id, "unit": joint.unit, "grid": track.grid}
    if track.count < 2:
        return PeriodEvidence(**evidence, status="unverified", period=None,
                              reason="the joint's range holds fewer than two grid values")
    start = track(0)
    returns: dict[str, list[int]] = {}  # per member that moves along the joint: where it is back at its start
    for oid in members:
        same = [index for index in range(1, track.count) if _same(track(index)[oid], start[oid])]
        if len(same) < track.count - 1:
            returns[oid] = same
    if not returns:
        return PeriodEvidence(**evidence, status="static", period=None,
                              reason="no member moves along this joint", outside_range=track.outside)
    rejected = []
    for lag in sorted({index for indices in returns.values() for index in indices}):
        failure = _first_mismatch(track, members, lag)
        if failure is None:
            return PeriodEvidence(**evidence, status="verified", period=lag * track.grid,
                                  rejected=tuple(rejected[:MAX_REJECTED]), rejected_count=len(rejected),
                                  outside_range=track.outside)
        rejected.append({"lag": lag * track.grid, **failure})
    reason = ("a candidate lag failed for some member over a complete cycle" if rejected else
              "no moving member returns to its start transform within the joint's range")
    return PeriodEvidence(**evidence, status="unverified", period=None, rejected=tuple(rejected[:MAX_REJECTED]),
                          rejected_count=len(rejected), reason=reason, outside_range=track.outside)


def _first_mismatch(track: _Track, members: list[str], lag: int) -> dict[str, Any] | None:
    """Where the first member's transform at q + lag differs from q's over [start, start + lag], or None."""
    for index in range(lag + 1):
        here, there = track(index), track(index + lag)
        for oid in members:
            if not _same(here[oid], there[oid]):
                rotation, translation = _deviation(here[oid], there[oid])
                return {"member": oid, "at": track.low + index * track.grid, "rotation_deviation": rotation,
                        "translation_deviation_mm": translation}
    return None
