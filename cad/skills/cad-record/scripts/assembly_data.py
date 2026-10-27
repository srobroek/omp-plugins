"""Kernel-free occurrence inventory of an assembly record: normalization and reference resolution.

The one reader of `assembly.yaml` occurrences, shared by cad-record `validate.py` and cad-motion
`pose.py` (and through pose, by cad-model, cad-render and cad-viewer). Callers load the YAML and
pass the parsed mappings; nothing here reads files or imports a CAD kernel.

An occurrence is one physical placement of one part definition (PN). Explicit occurrences are
listed under the top-level `occurrences` key with an assembly-global lowercase id and a rest
placement, and joined to subassemblies by `"@id"` references. Each PN in a legacy `parts` list
is one implicit occurrence whose id is the PN itself, at the identity placement. A bare PN
reference resolves only when exactly one occurrence of that PN exists; `"@id"` names one
occurrence.

Placement: x -> R x + t, translation in mm, rotation a right-handed axis-angle in degrees about
the definition's local origin, applied before the translation.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

PN = re.compile(r"[A-Z]{2,5}-[0-9]{4}")
OCCURRENCE_ID = re.compile(r"[a-z][a-z0-9_-]*")
FRAMES = ("assembly_zero", "part_local")
DEFAULT_FRAME = "assembly_zero"

Vec = tuple[float, float, float]


class InventoryError(ValueError):
    """The record cannot be normalized; `problems` lists every reason."""

    def __init__(self, problems: Sequence[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = list(problems)


class UnresolvedReference(ValueError):
    """A reference names no occurrence, or a bare PN names several."""


@dataclass(frozen=True)
class Placement:
    """A proper rigid rest placement: rotation `angle_deg` about the unit `axis`, then `translation_mm`."""

    translation_mm: Vec = (0.0, 0.0, 0.0)
    axis: Vec = (0.0, 0.0, 1.0)
    angle_deg: float = 0.0

    @property
    def is_identity(self) -> bool:
        return self.translation_mm == (0.0, 0.0, 0.0) and math.remainder(self.angle_deg, 360.0) == 0.0

    def record(self) -> dict[str, Any]:
        """The normalized placement as JSON: unit axis, angle and translation."""
        return {"translation_mm": list(self.translation_mm),
                "rotation": {"axis": list(self.axis), "angle_deg": self.angle_deg}}


IDENTITY = Placement()


@dataclass(frozen=True)
class Occurrence:
    id: str
    pn: str
    placement: Placement
    explicit: bool  # listed under `occurrences`; False for a legacy PN singleton (id == PN)

    @property
    def ref(self) -> str:
        """The copyable reference: `@id` for an explicit occurrence, the PN for a legacy singleton."""
        return f"@{self.id}" if self.explicit else self.pn


@dataclass(frozen=True)
class Group:
    id: str
    title: str
    members: tuple[str, ...]  # occurrence ids in record order


@dataclass(frozen=True)
class Inventory:
    """Every occurrence of the record, in order of first group membership, plus the groups."""

    occurrences: tuple[Occurrence, ...]
    groups: tuple[Group, ...] = ()
    _by_id: dict[str, Occurrence] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_by_id", {occurrence.id: occurrence for occurrence in self.occurrences})

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(occurrence.id for occurrence in self.occurrences)

    @property
    def pns(self) -> tuple[str, ...]:
        """The part definitions the occurrences instantiate, in first-occurrence order."""
        return tuple(dict.fromkeys(occurrence.pn for occurrence in self.occurrences))

    def get(self, occurrence_id: str) -> Occurrence:
        try:
            return self._by_id[occurrence_id]
        except KeyError:
            raise UnresolvedReference(f"unknown occurrence {occurrence_id!r}") from None

    def __contains__(self, occurrence_id: object) -> bool:
        return occurrence_id in self._by_id

    def of(self, pn: str) -> tuple[Occurrence, ...]:
        return tuple(occurrence for occurrence in self.occurrences if occurrence.pn == pn)

    def quantities(self) -> dict[str, int]:
        """Occurrences per PN: the assembled quantity of each part definition."""
        counts: dict[str, int] = {}
        for occurrence in self.occurrences:
            counts[occurrence.pn] = counts.get(occurrence.pn, 0) + 1
        return counts

    def resolve(self, ref: str) -> Occurrence:
        """The occurrence `ref` names: `@id`, or a PN with exactly one occurrence."""
        if not isinstance(ref, str):
            raise UnresolvedReference(f"reference {ref!r} is not a string")
        if ref.startswith("@"):
            occurrence = self._by_id.get(ref[1:])
            if occurrence is None or not occurrence.explicit:
                known = ", ".join(o.ref for o in self.occurrences if o.explicit) or "none"
                raise UnresolvedReference(f"{ref} names no occurrence; explicit occurrences: {known}")
            return occurrence
        found = self.of(ref)
        if len(found) == 1:
            return found[0]
        if not found:
            raise UnresolvedReference(f"{ref} names no occurrence; occurrences: {', '.join(o.ref for o in self.occurrences)}")
        raise UnresolvedReference(f"{ref} is ambiguous: it is placed {len(found)} times; "
                              f"name one of {', '.join(o.ref for o in found)}")

    def endpoint(self, pn: str, occurrence_ref: str | None) -> Occurrence:
        """A feature endpoint's occurrence: `occurrence_ref` must be an occurrence of `pn`; omitted only for a singleton."""
        if occurrence_ref is None:
            return self.resolve(pn)
        occurrence = self.resolve(occurrence_ref)
        if occurrence.pn != pn:
            raise UnresolvedReference(f"{occurrence_ref} is an occurrence of {occurrence.pn}, not {pn}")
        return occurrence

    def drawing_item(self, pn: str, refs: Sequence[str] | None = None) -> tuple[Occurrence, ...]:
        """The occurrences one assembly-drawing item row stands for; quantity is their count.

        Without `refs` the item is a legacy singleton and `pn` must have exactly one occurrence.
        """
        if refs is None:
            return (self.resolve(pn),)
        found = tuple(self.endpoint(pn, ref) for ref in refs)
        if len({o.id for o in found}) != len(found):
            raise UnresolvedReference(f"drawing item {pn} lists an occurrence twice")
        return found

    def extended(self, pns: Iterable[str]) -> Inventory:
        """This inventory plus a legacy identity singleton for each PN in `pns` that has no occurrence.

        The runtime `--attach` path for a built part listed in no subassembly; it never adds an
        instance of a PN that already has occurrences.
        """
        known = set(self.pns)
        extra = tuple(Occurrence(pn, pn, IDENTITY, False) for pn in dict.fromkeys(pns) if pn not in known)
        return Inventory(self.occurrences + extra, self.groups) if extra else self


def _vector(value: Any, where: str, problems: list[str]) -> Vec | None:
    if (isinstance(value, (list, tuple)) and len(value) == 3
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value)):
        return (float(value[0]), float(value[1]), float(value[2]))
    problems.append(f"{where} must be three finite numbers")
    return None


def placement(raw: Any, where: str, problems: list[str]) -> Placement:
    """Normalize one `placement` mapping; omitted means identity. The axis is made unit length."""
    if raw is None:
        return IDENTITY
    if not isinstance(raw, Mapping) or set(raw) - {"translation_mm", "rotation"}:
        problems.append(f"{where} must be a mapping of translation_mm and rotation")
        return IDENTITY
    translation = _vector(raw.get("translation_mm", [0, 0, 0]), f"{where}.translation_mm", problems)
    rotation = raw.get("rotation")
    axis: Vec | None = (0.0, 0.0, 1.0)
    angle = 0.0
    if rotation is not None:
        if not isinstance(rotation, Mapping) or set(rotation) != {"axis", "angle_deg"}:
            problems.append(f"{where}.rotation must be a mapping of axis and angle_deg")
            return IDENTITY
        axis = _vector(rotation["axis"], f"{where}.rotation.axis", problems)
        raw_angle = rotation["angle_deg"]
        if isinstance(raw_angle, bool) or not isinstance(raw_angle, (int, float)) or not math.isfinite(raw_angle):
            problems.append(f"{where}.rotation.angle_deg must be a finite number")
            return IDENTITY
        angle = float(raw_angle)
        if axis is not None:
            norm = math.sqrt(sum(v * v for v in axis))
            if norm < 1e-12:
                problems.append(f"{where}.rotation.axis has zero length")
                return IDENTITY
            axis = (axis[0] / norm, axis[1] / norm, axis[2] / norm)
    if translation is None or axis is None:
        return IDENTITY
    return Placement(translation, axis, angle)


def normalize(record: Mapping[str, Any], frames: Mapping[str, str] | None = None) -> Inventory:
    """The occurrence inventory of a parsed assembly.yaml; raises InventoryError listing every problem.

    `frames` maps a PN to its part.yaml `model_frame`; a PN it omits is `assembly_zero`, whose
    geometry is already in assembly coordinates and so admits one identity-placed occurrence.
    """
    problems: list[str] = []
    frames = frames or {}
    explicit: dict[str, Occurrence] = {}
    raw_occurrences = record.get("occurrences") or []
    if not isinstance(raw_occurrences, list):
        raise InventoryError(["occurrences must be a list"])
    for index, raw in enumerate(raw_occurrences):
        where = f"occurrences/{index}"
        if not isinstance(raw, Mapping):
            problems.append(f"{where} must be a mapping")
            continue
        occurrence_id, pn = raw.get("id"), raw.get("PN")
        if not isinstance(occurrence_id, str) or not OCCURRENCE_ID.fullmatch(occurrence_id):
            problems.append(f"{where}.id {occurrence_id!r} must be a lowercase identifier like ring-base")
            continue
        if not isinstance(pn, str) or not PN.fullmatch(pn):
            problems.append(f"{where} ({occurrence_id}).PN {pn!r} is not a part number")
            continue
        if occurrence_id in explicit:
            problems.append(f"duplicate occurrence id {occurrence_id!r}")
            continue
        explicit[occurrence_id] = Occurrence(occurrence_id, pn, placement(raw.get("placement"), f"{where}.placement",
                                                                          problems), True)
    explicit_pns = {o.pn for o in explicit.values()}

    order: dict[str, Occurrence] = {}
    groups: list[Group] = []
    membership: dict[str, str] = {}
    raw_groups = record.get("subassemblies") or []
    for index, raw in enumerate(raw_groups if isinstance(raw_groups, list) else []):
        if not isinstance(raw, Mapping):
            continue
        group_id = str(raw.get("id", f"subassemblies/{index}"))
        members: list[str] = []
        for pn in raw.get("parts") or []:
            if not isinstance(pn, str) or not PN.fullmatch(pn):
                problems.append(f"subassembly {group_id}: {pn!r} is not a part number")
                continue
            if pn in explicit_pns:
                refs = ", ".join(o.ref for o in explicit.values() if o.pn == pn)
                problems.append(f"subassembly {group_id} lists {pn} in parts, but {pn} has explicit occurrences; "
                                f"list {refs} under occurrences instead")
                continue
            if pn in members:
                continue
            members.append(pn)
            order.setdefault(pn, Occurrence(pn, pn, IDENTITY, False))  # a PN in several groups stays one part
        for ref in raw.get("occurrences") or []:
            if not isinstance(ref, str) or not ref.startswith("@") or ref[1:] not in explicit:
                problems.append(f"subassembly {group_id}: {ref!r} names no occurrence")
                continue
            occurrence_id = ref[1:]
            if occurrence_id in membership:
                problems.append(f"occurrence {ref} belongs to both {membership[occurrence_id]} and {group_id}")
                continue
            membership[occurrence_id] = group_id
            members.append(occurrence_id)
            order[occurrence_id] = explicit[occurrence_id]
        groups.append(Group(group_id, str(raw.get("title", "")), tuple(members)))
    for occurrence in explicit.values():
        if occurrence.id not in membership:
            problems.append(f"occurrence @{occurrence.id} belongs to no subassembly")

    inventory = Inventory(tuple(order.values()), tuple(groups))
    for pn, count in inventory.quantities().items():
        frame = frames.get(pn, DEFAULT_FRAME)
        if frame not in FRAMES:
            problems.append(f"{pn}: model_frame {frame!r} must be one of {', '.join(FRAMES)}")
        elif frame == "assembly_zero":
            placed = [o for o in inventory.of(pn) if not o.placement.is_identity]
            if count > 1:
                problems.append(f"{pn} is placed {count} times but its model_frame is assembly_zero; "
                                "a repeated part is modelled part_local")
            elif placed:
                problems.append(f"{placed[0].ref} has a non-identity placement but {pn}'s model_frame is "
                                "assembly_zero; a placed part is modelled part_local")
    if problems:
        raise InventoryError(problems)
    return inventory


def joint_tree(edges: Sequence[tuple[str, str, str]], nodes: Iterable[str] = (),
               name: Callable[[str], str] = str, *, connected: bool = True) -> tuple[str, tuple[int, ...]]:
    """(ground node, edge indices parent-before-child) of a single-parent tree over the edge nodes plus `nodes`.

    `edges` are (joint id, parent, child); `name` turns a node into its reported reference.
    Raises InventoryError on a self joint, a node with two incoming joints, or a cycle, and,
    when `connected`, on a node not connected to the ground. With `connected` False the ground is
    the first root with a joint and the order covers only its tree.
    """
    problems: list[str] = []
    incoming: dict[str, str] = {}
    for jid, parent, child in edges:
        if parent == child:
            problems.append(f"{jid}: parent and child are both {name(parent)}")
        elif child in incoming:
            problems.append(f"{name(child)} is the child of both {incoming[child]} and {jid}")
        else:
            incoming[child] = jid
    if problems:
        raise InventoryError(problems)
    ordered_nodes = list(dict.fromkeys([*(n for _, p, c in edges for n in (p, c)), *nodes]))
    roots = [n for n in ordered_nodes if n not in incoming]
    if not roots:
        raise InventoryError(["the joints form a cycle; no part is the ground"])
    ground = roots[0] if len(roots) == 1 else next((r for r in roots if any(p == r for _, p, _ in edges)), roots[0])

    def reach(starts: Iterable[str]) -> list[int]:
        order: list[int] = []
        frontier = list(starts)
        while frontier:
            parent = frontier.pop(0)
            for index, (_, edge_parent, child) in enumerate(edges):
                if edge_parent == parent:
                    order.append(index)
                    frontier.append(child)
        return order

    if connected and len(roots) > 1:
        loose = [name(r) for r in roots if r != ground]
        problems.append(f"parts not connected to the ground {name(ground)}: {loose}; connect each with a fixed "
                        "joint in assembly.yaml or --attach REF=PARENT_REF")
    if len(reach(roots)) != len(edges):
        problems.append("the joints form a cycle that is not connected to the ground")
    if problems:
        raise InventoryError(problems)
    return ground, tuple(reach([ground]))
