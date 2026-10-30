"""Assembly occurrences for assembly drawings, read once from a built assembly STEP.

``read_assembly(hw, assembly_step, workdir)`` adapts cad-motion's canonical STEP reader
(``pose.read_assembly_step`` and ``pose.bind_components``) instead of traversing XCAF a second
time: every occurrence of the record is bound to the STEP component that places it, keeps its
cumulative placement and product path, and its part definition is written once to
``workdir/<PN>.step`` for FreeCAD. FreeCAD then applies each placement exactly once, so repeated
instances, hierarchy and placements survive and no solid is guessed from a flattened read.

Occurrence ids are the record's ids (``ring-base``) or, for a legacy singleton, the PN itself; they
are scoped to the version whose STEP was read. Exploded views move occurrences by presentation
offsets only: ``presentation_offsets`` sums each occurrence's own drawing offset with those of its
kinematic ancestors, so a link carries its pins, and never touches the design placement.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

POSE_PATH = Path(__file__).resolve().parents[2] / "cad-motion" / "scripts" / "pose.py"

Vec = tuple[float, float, float]


def load_pose() -> Any:
    """cad-motion's pose module, shared under the module name every cad script uses."""
    name = "cad_motion_pose"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, POSE_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cad-motion pose.py not found at {POSE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class GeometryError(ValueError):
    """The STEP and the record disagree: ``code`` is ``bom_geometry_mismatch`` or ``source_mismatch``."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Occurrence:
    """One physical instance: its record identity, its STEP product and its cumulative placement."""

    occurrence_id: str
    pn: str
    product: str                      # STEP product name of the definition: "<PN> <title>"
    path: tuple[str, ...]             # product names from the STEP root down to the definition's parent
    rotation: tuple[float, float, float, float]   # unit quaternion (x, y, z, w)
    translation: Vec                  # millimetres
    groups: tuple[str, ...]           # subassembly ids that list this occurrence
    parent: str | None                # kinematic parent occurrence (the joint whose child it is)

    @property
    def ref(self) -> str:
        """The copyable reference: ``@id``, or the PN of a legacy singleton."""
        return self.pn if self.occurrence_id == self.pn else f"@{self.occurrence_id}"


@dataclass(frozen=True)
class AssemblyGeometry:
    """Every occurrence of a version in record order, and one definition STEP per PN."""

    occurrences: tuple[Occurrence, ...]
    definitions: Mapping[str, Path]
    groups: Mapping[str, tuple[str, str, tuple[str, ...]]]   # id -> (id, title, member occurrence ids)
    joints: Mapping[str, Mapping[str, Any]]                  # joint id -> {id, type, parent, child, min, max}

    def get(self, occurrence_id: str) -> Occurrence:
        for occurrence in self.occurrences:
            if occurrence.occurrence_id == occurrence_id:
                return occurrence
        raise KeyError(occurrence_id)

    def of(self, pn: str) -> tuple[Occurrence, ...]:
        return tuple(o for o in self.occurrences if o.pn == pn)

    def presentation_offsets(self, offsets: Mapping[str, Vec]) -> dict[str, Vec]:
        """Each occurrence's exploded translation: its own offset plus every kinematic ancestor's."""
        by_id = {o.occurrence_id: o for o in self.occurrences}
        total: dict[str, Vec] = {}

        def resolve(occurrence_id: str, trail: tuple[str, ...]) -> Vec:
            if occurrence_id in total:
                return total[occurrence_id]
            if occurrence_id in trail:
                raise GeometryError("source_mismatch", f"the joint tree loops through {occurrence_id}")
            own = offsets.get(occurrence_id, (0.0, 0.0, 0.0))
            parent = by_id[occurrence_id].parent
            base = resolve(parent, (*trail, occurrence_id)) if parent in by_id else (0.0, 0.0, 0.0)
            total[occurrence_id] = (base[0] + own[0], base[1] + own[1], base[2] + own[2])
            return total[occurrence_id]

        for occurrence_id in by_id:
            resolve(occurrence_id, ())
        return total


def read_assembly(hw: Path, assembly_step: Path, workdir: Path) -> AssemblyGeometry:
    """Bind the record's occurrences to ``assembly_step`` and write each used definition to ``workdir``."""
    pose = load_pose()
    try:
        with pose.stdout_to_stderr():
            assembly = pose.load_assembly(hw)
            step = pose.read_assembly_step(assembly_step)
            located = pose.bind_components(assembly, step, assembly_step)
    except pose.MotionError as error:
        raise GeometryError("bom_geometry_mismatch", str(error)) from None
    paths = {component.occurrence or component.pn: component.path for component in step.components}
    membership: dict[str, list[str]] = {}
    for group in assembly.groups:
        for member in group.members:
            membership.setdefault(member, []).append(group.id)
    parents = {joint.child: joint.parent for joint in assembly.joints}
    joints = {joint.id: {"id": joint.id, "type": joint.type, "parent": joint.parent, "child": joint.child,
                         "min": joint.min, "max": joint.max} for joint in assembly.joints}

    occurrences = []
    missing = []
    for record in assembly.occurrences:
        if record.id not in located or record.pn not in step.definitions:
            missing.append(record.ref)
            continue
        placement = located[record.id]
        occurrences.append(Occurrence(
            occurrence_id=record.id, pn=record.pn, product=step.definitions[record.pn].name,
            path=tuple(paths.get(record.id, ())), rotation=placement.quaternion(), translation=placement.trans,
            groups=tuple(membership.get(record.id, ())), parent=parents.get(record.id)))
    if missing:
        raise GeometryError("bom_geometry_mismatch",
                            f"{assembly_step} has no component for {', '.join(missing)}")
    extra = sorted(set(located) - {o.occurrence_id for o in occurrences})
    if extra:
        raise GeometryError("bom_geometry_mismatch", f"{assembly_step} places {', '.join(extra)}, which the record lacks")

    workdir.mkdir(parents=True, exist_ok=True)
    definitions = {}
    with pose.stdout_to_stderr():
        for pn in dict.fromkeys(o.pn for o in occurrences):
            definitions[pn] = workdir / f"{pn}.step"
            pose.write_part_step(definitions[pn], step.definitions[pn])
    groups = {group.id: (group.id, group.title, tuple(group.members)) for group in assembly.groups}
    return AssemblyGeometry(occurrences=tuple(occurrences), definitions=definitions, groups=groups, joints=joints)
