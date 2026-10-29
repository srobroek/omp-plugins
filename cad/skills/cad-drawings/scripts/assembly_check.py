#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["defusedxml>=0.7.1"]
# ///
"""Assembly-drawing intent, its reconciliation with the record, and the checks of composed sheets.

Kernel-free; ``assembly_drawing.py`` uses it in the run, and the CLI re-checks a published package:

    uv run --script assembly_check.py PACKAGE_DIR

``read_intent`` normalizes ``assembly.yaml`` ``drawing``. ``reconcile`` binds it to the version's
occurrences, the BOM and the interfaces: one item row per PN, every occurrence of the drawing scope in
exactly one item, quantity = the item's occurrences = the BOM roll-up, and each operation resolved to
its interface limit (fit, insert or ring) and its two items. ``check_sheet`` reads a composed sheet's
SVG back: every parts-list item has exactly one balloon in every ballooned view and every balloon one
row; each balloon names an occurrence of its item inside the view, its leader ends with its dot on the
visible surface point measured for that occurrence, and the parts-list cells equal the BOM and the
occurrence counts. Failure codes are the drawing package's (``assembly_item_unidentified``,
``bom_geometry_mismatch``, ``assembly_instruction_incomplete``, ``invalid_drawing_intent``,
``feature_not_presentable``).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from defusedxml import ElementTree as SafeET

SVG_NS = "http://www.w3.org/2000/svg"
Vec = tuple[float, float, float]

# Named view directions: (direction towards the viewer, the view's +X) in the assembly frame.
DIRECTIONS: dict[str, tuple[Vec, Vec]] = {
    "front": ((0.0, -1.0, 0.0), (1.0, 0.0, 0.0)), "back": ((0.0, 1.0, 0.0), (-1.0, 0.0, 0.0)),
    "left": ((-1.0, 0.0, 0.0), (0.0, -1.0, 0.0)), "right": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0)),
    "top": ((0.0, 0.0, 1.0), (1.0, 0.0, 0.0)), "bottom": ((0.0, 0.0, -1.0), (1.0, 0.0, 0.0)),
    "iso": ((1.0, -1.0, 1.0), (1.0, 1.0, 0.0)),
}
ORTHOGRAPHIC = frozenset(DIRECTIONS) - {"iso"}
VIEW_KINDS = ("assembled", "exploded")
SCOPES = ("modeled_mechanical_assembly", "complete_assembly")
OPERATION_KINDS = ("press_fit", "heat_set", "retaining_ring")
# Acceptance kind -> number of named features (installed part's, then the receiving part's). Each is
# measured on the assembled model: seated = contact along the installation direction, standoff = the
# measured gap there, flush = a face of the receiving part level with the installed part's trailing
# end, engaged = the installed part touching the receiving part (a ring in its groove).
ACCEPTANCE = {"seated": 2, "standoff": 2, "flush": 2, "engaged": 1}
CONTACT_MM = 0.01            # cad-model's contact tolerance
FLUSH_MM = 0.02
TOP = "top"
# Parts-list columns (ISO 7573 / ASME Y14.34) and the evidence field each one prints.
PARTS_LIST_FIELDS = ("item", "PN", "rev", "qty", "title", "material", "designation")
PARTS_LIST_HEADINGS = {
    "iso": ("Item", "PN", "Rev.", "Qty", "Title", "Material", "Designation"),
    "asme": ("FIND NO.", "PART NO.", "REV", "QTY", "DESCRIPTION", "MATERIAL", "DESIGNATION"),
}
ENDPOINT_TOLERANCE_MM = 0.05


class IntentError(ValueError):
    """``assembly.drawing`` is missing or malformed: code ``invalid_drawing_intent``."""

    code = "invalid_drawing_intent"


def finding(code: str, message: str, **where: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **where}


# --------------------------------------------------------------------------- intent


@dataclass(frozen=True)
class ViewRequest:
    id: str
    kind: str          # "assembled" or "exploded"
    direction: str     # a DIRECTIONS name

    @property
    def balloons(self) -> bool:
        """Item balloons go on exploded views, where every occurrence stands apart."""
        return self.kind == "exploded"


@dataclass(frozen=True)
class Item:
    item: int
    pn: str
    refs: tuple[str, ...] | None   # the occurrences it stands for; None for a singleton PN


@dataclass(frozen=True)
class Operation:
    id: str
    kind: str                  # an OPERATION_KINDS entry
    part: str                  # reference of the occurrence installed
    into: str                  # reference of the occurrence that receives it
    interface: str
    direction: Vec             # installation direction of `part` in the receiving part's model frame
    acceptance: str            # an ACCEPTANCE kind
    features: tuple[str, ...]  # named features of part (then host) the acceptance refers to
    verify_joint: str | None   # joint whose free travel is verified afterwards
    tools: tuple[str, ...] = ()
    consumables: tuple[str, ...] = ()


@dataclass(frozen=True)
class Intent:
    number: str
    rev: str
    title: str
    scope: str
    excludes: tuple[str, ...]
    views: tuple[ViewRequest, ...]
    explode: Mapping[str, Vec]           # occurrence reference -> presentation offset, mm
    items: tuple[Item, ...]
    subassembly_sheets: tuple[str, ...]
    operations: tuple[Operation, ...]


def _vector(value: Any, where: str) -> Vec:
    if (not isinstance(value, list) or len(value) != 3
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value)):
        raise IntentError(f"{where} must be three finite numbers")
    return (float(value[0]), float(value[1]), float(value[2]))


def _text(value: Any, where: str) -> str:
    if not isinstance(value, (str, int)) or isinstance(value, bool) or not str(value).strip():
        raise IntentError(f"{where} must be a non-empty string")
    return str(value)


def _recorded_names(raw: Mapping[str, Any], key: str, where: str) -> tuple[str, ...]:
    values = raw.get(key) or []
    if not isinstance(values, list) or not all(isinstance(value, str) and value.strip() for value in values):
        raise IntentError(f"{where}/{key} must be a list of non-empty strings")
    return tuple(values)


def read_intent(assembly: Mapping[str, Any]) -> Intent:
    """The normalized ``drawing`` block of a parsed assembly.yaml; IntentError when absent or malformed."""
    drawing = assembly.get("drawing")
    if not isinstance(drawing, Mapping):
        raise IntentError("assembly.yaml has no drawing block; declare assembly.drawing (number, rev, title, "
                          "views, items) before drawing the assembly")
    where = "assembly.yaml drawing"
    views = []
    for index, raw in enumerate(drawing.get("views") or []):
        at = f"{where}/views/{index}"
        if not isinstance(raw, Mapping) or raw.get("kind") not in VIEW_KINDS or raw.get("direction") not in DIRECTIONS:
            raise IntentError(f"{at} needs kind {'|'.join(VIEW_KINDS)} and direction {'|'.join(DIRECTIONS)}")
        views.append(ViewRequest(_text(raw.get("id"), f"{at}/id"), raw["kind"], raw["direction"]))
    if not views:
        raise IntentError(f"{where}/views lists no view")
    if len({v.id for v in views}) != len(views):
        raise IntentError(f"{where}/views ids are not unique")
    explode: dict[str, Vec] = {}
    for index, raw in enumerate(drawing.get("explode") or []):
        at = f"{where}/explode/{index}"
        if not isinstance(raw, Mapping):
            raise IntentError(f"{at} must be a mapping with ref and offset_mm")
        ref = _text(raw.get("ref"), f"{at}/ref")
        if ref in explode:
            raise IntentError(f"{at}: {ref} has two explode offsets")
        explode[ref] = _vector(raw.get("offset_mm"), f"{at}/offset_mm")
    items = []
    for index, raw in enumerate(drawing.get("items") or []):
        at = f"{where}/items/{index}"
        if not isinstance(raw, Mapping) or not isinstance(raw.get("item"), int) or isinstance(raw.get("item"), bool) \
                or raw["item"] < 1:
            raise IntentError(f"{at}/item must be a positive integer")
        refs = raw.get("occurrences")
        if refs is not None and (not isinstance(refs, list) or not refs or not all(isinstance(r, str) for r in refs)):
            raise IntentError(f"{at}/occurrences must be a non-empty list of @id references")
        items.append(Item(raw["item"], _text(raw.get("PN"), f"{at}/PN"), None if refs is None else tuple(refs)))
    if not items:
        raise IntentError(f"{where}/items lists no item")
    operations = []
    for index, raw in enumerate(drawing.get("operations") or []):
        at = f"{where}/operations/{index}"
        if not isinstance(raw, Mapping):
            raise IntentError(f"{at} must be a mapping")
        operations.append(_operation(raw, at))
    scope = drawing.get("scope", "modeled_mechanical_assembly")
    if scope not in SCOPES:
        raise IntentError(f"{where}/scope must be one of {', '.join(SCOPES)}")
    excludes = tuple(_text(e, f"{where}/excludes") for e in drawing.get("excludes") or [])
    if scope == "complete_assembly" and excludes:
        raise IntentError(f"{where}: a complete_assembly excludes nothing; use modeled_mechanical_assembly")
    sheets = tuple(_text(s, f"{where}/subassembly_sheets") for s in drawing.get("subassembly_sheets") or [])
    return Intent(number=_text(drawing.get("number"), f"{where}/number"), rev=_text(drawing.get("rev"), f"{where}/rev"),
                  title=_text(drawing.get("title"), f"{where}/title"), scope=scope, excludes=excludes,
                  views=tuple(views), explode=explode, items=tuple(items), subassembly_sheets=sheets,
                  operations=tuple(operations))


def _operation(raw: Mapping[str, Any], at: str) -> Operation:
    kind = raw.get("kind")
    if kind not in OPERATION_KINDS:
        raise IntentError(f"{at}/kind must be one of {', '.join(OPERATION_KINDS)}")
    acceptance = raw.get("acceptance")
    if not isinstance(acceptance, Mapping) or acceptance.get("kind") not in ACCEPTANCE:
        raise IntentError(f"{at}/acceptance needs kind {'|'.join(ACCEPTANCE)}")
    features = acceptance.get("features")
    wanted = ACCEPTANCE[acceptance["kind"]]
    if not isinstance(features, list) or len(features) != wanted or not all(isinstance(f, str) and f for f in features):
        raise IntentError(f"{at}/acceptance {acceptance['kind']} names {wanted} feature(s)")
    direction = _vector(raw.get("direction"), f"{at}/direction")
    if math.hypot(*direction) < 1e-9:
        raise IntentError(f"{at}/direction must not be zero")
    joint = raw.get("verify_joint")
    return Operation(id=_text(raw.get("id"), f"{at}/id"), kind=kind, part=_text(raw.get("part"), f"{at}/part"),
                     into=_text(raw.get("into"), f"{at}/into"), interface=_text(raw.get("interface"), f"{at}/interface"),
                     direction=direction, acceptance=acceptance["kind"], features=tuple(features),
                     verify_joint=None if joint is None else _text(joint, f"{at}/verify_joint"),
                     tools=_recorded_names(raw, "tools", at), consumables=_recorded_names(raw, "consumables", at))


# --------------------------------------------------------------------------- reconciliation


@dataclass(frozen=True)
class PartsRow:
    item: int
    pn: str
    rev: str
    qty: int
    title: str
    material: str
    designation: str

    def cells(self) -> tuple[str, ...]:
        return (str(self.item), self.pn, self.rev, str(self.qty), self.title, self.material, self.designation)


@dataclass(frozen=True)
class Travel:
    """The movable joint an operation's free-movement check exercises, with its record limits."""

    joint: str
    kind: str            # "revolute" (degrees) or "prismatic" (mm)
    low: float
    high: float
    parent_item: int
    child_item: int


@dataclass(frozen=True)
class ResolvedOperation:
    operation: Operation
    part_occurrence: str
    into_occurrence: str
    part_item: int
    into_item: int
    limit: Mapping[str, Any]                       # the interface limit entry that specifies the joint
    travel: Travel | None                           # the verify_joint check, when declared
    direction: Vec                                  # unit installation direction in the assembly frame

    def measurement(self) -> dict[str, Any]:
        """What the FreeCAD measure job evaluates on the assembled model for the acceptance."""
        return {"id": self.operation.id, "kind": self.operation.acceptance, "part": self.part_occurrence,
                "into": self.into_occurrence, "direction": list(self.direction)}


def rotate(quaternion: Sequence[float], vector: Sequence[float]) -> Vec:
    """``vector`` turned by the unit quaternion (x, y, z, w), normalized."""
    x, y, z, w = quaternion
    vx, vy, vz = vector
    tx, ty, tz = 2 * (y * vz - z * vy), 2 * (z * vx - x * vz), 2 * (x * vy - y * vx)
    rx, ry, rz = vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)
    length = math.hypot(rx, ry, rz)
    return (rx / length + 0.0, ry / length + 0.0, rz / length + 0.0)


def check_acceptance(op: ResolvedOperation, measured: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Findings when the model contradicts an operation's acceptance (measured by the FreeCAD job)."""
    operation = op.operation
    where = f"operation {operation.id}"

    def fail(message: str) -> list[dict[str, Any]]:
        return [finding("assembly_instruction_incomplete", f"{where}: {message}", operation=operation.id)]

    if measured is None:
        return fail("was not measured on the assembled model")
    gap, contact, flush = measured.get("gap"), measured.get("contact"), measured.get("flush")
    if operation.acceptance == "seated" and (gap is None or gap > CONTACT_MM):
        return fail("is declared seated, but along the installation direction the model leaves "
                    + ("no contact" if gap is None else f"a {gap:.3f} mm gap"))
    if operation.acceptance == "standoff" and (gap is None or gap <= CONTACT_MM):
        return fail("is declared as a standoff, but the model " + ("shows no face along the installation direction"
                                                                     if gap is None else "seats the parts in contact"))
    if operation.acceptance == "flush" and (flush is None or abs(flush) > FLUSH_MM):
        return fail("is declared flush, but no face of the receiving part is level with the installed part's "
                    "trailing end" + ("" if flush is None else f" (nearest {flush:+.3f} mm)"))
    if operation.acceptance == "engaged" and (contact is None or contact > CONTACT_MM):
        return fail("is declared engaged, but the parts do not touch in the model"
                    + ("" if contact is None else f" ({contact:.3f} mm apart)"))
    return []


@dataclass(frozen=True)
class SheetPlan:
    number: int
    scope: str                                      # "top" or a subassembly id
    heading: str | None                             # the subassembly title, None for the top sheet
    occurrences: tuple[str, ...]                    # occurrence ids drawn on this sheet
    rows: tuple[PartsRow, ...]
    item_occurrences: Mapping[int, tuple[str, ...]]  # item -> its occurrences inside the sheet scope
    operations: tuple[ResolvedOperation, ...]


@dataclass(frozen=True)
class AssemblyPlan:
    intent: Intent
    sheets: tuple[SheetPlan, ...]
    explode: Mapping[str, Vec]           # occurrence id -> own presentation offset
    bom: Mapping[str, Mapping[str, Any]]  # PN -> {rev, qty (roll-up), title, material, designation}


def bom_rollup(rows: Iterable[Mapping[str, str]]) -> dict[str, dict[str, Any]]:
    """PN -> its BOM fields and total quantity: each row's qty times the qty of every parent row.

    ``level`` increases by one per child depth, so a row's parent is the nearest earlier row one
    level up; a part appearing under several parents sums.
    """
    totals: dict[str, dict[str, Any]] = {}
    stack: list[tuple[int, int]] = []   # (level, cumulative multiplier) of the open parents
    for row in rows:
        level, qty = int(row["level"]), int(row["qty"])
        while stack and stack[-1][0] >= level:
            stack.pop()
        multiplier = (stack[-1][1] if stack else 1) * qty
        stack.append((level, multiplier))
        entry = totals.setdefault(row["PN"], {"rev": row["rev"], "qty": 0, "title": row["title"],
                                              "material": row["material"], "designation": row.get("designation") or ""})
        entry["qty"] += multiplier
    return totals


def _pair_names(item: Any, occurrence_id: str, pn: str, singleton: bool) -> bool:
    """Whether an interface pair item (a PN or "@id") names this occurrence."""
    return item == f"@{occurrence_id}" or (item == pn and singleton)


def _limit(interface: Mapping[str, Any], kind: str, part: tuple[str, str, bool],
           into: tuple[str, str, bool]) -> Mapping[str, Any] | None:
    """The interface limit of ``kind`` joining ``part`` and ``into`` (each (occurrence id, PN, singleton))."""
    limits = interface.get("limits") or {}
    entries = limits.get(kind)
    candidates = entries if isinstance(entries, list) else [entries] if isinstance(entries, Mapping) else []
    for entry in candidates:
        if not isinstance(entry, Mapping):
            continue
        if "pair" in entry:
            pair = list(entry["pair"])
            if len(pair) == 2 and any(_pair_names(pair[a], *part) and _pair_names(pair[1 - a], *into) for a in (0, 1)):
                return entry
        elif "hole" in entry and "shaft" in entry:
            ends = []
            for side in ("hole", "shaft"):
                end = entry[side]
                ref = end.get("occurrence") or end.get("PN")
                ends.append(ref)
            if any(_pair_names(ends[a], *part) and _pair_names(ends[1 - a], *into) for a in (0, 1)):
                return entry
    return None


def reconcile(intent: Intent, geometry: Any, bom_rows: Sequence[Mapping[str, str]],
              interfaces: Sequence[Mapping[str, Any]]) -> tuple[AssemblyPlan | None, list[dict[str, Any]]]:
    """Bind the intent to the version's occurrences, BOM and interfaces; findings for every disagreement."""
    findings: list[dict[str, Any]] = []
    occurrences = {o.occurrence_id: o for o in geometry.occurrences}
    counts: dict[str, int] = {}
    for o in geometry.occurrences:
        counts[o.pn] = counts.get(o.pn, 0) + 1

    def resolve(ref: str, where: str) -> str | None:
        if ref.startswith("@"):
            if ref[1:] in occurrences and occurrences[ref[1:]].ref == ref:
                return ref[1:]
            findings.append(finding("invalid_drawing_intent", f"{where}: {ref} names no occurrence"))
            return None
        found = [o.occurrence_id for o in geometry.occurrences if o.pn == ref]
        if len(found) == 1:
            return found[0]
        findings.append(finding("invalid_drawing_intent", f"{where}: {ref} " +
                                ("names no occurrence" if not found else f"is placed {len(found)} times; name one")))
        return None

    bom_rows = list(bom_rows)
    bom = bom_rollup(bom_rows)
    bom_children = {row["PN"] for index, row in enumerate(bom_rows[:-1])
                    if int(bom_rows[index + 1]["level"]) > int(row["level"])}
    item_of: dict[str, int] = {}
    items: dict[int, tuple[str, tuple[str, ...]]] = {}
    for entry in intent.items:
        where = f"drawing/items/{entry.item}"
        if entry.item in items:
            findings.append(finding("invalid_drawing_intent", f"{where}: item {entry.item} is declared twice"))
            continue
        if any(pn == entry.pn for pn, _ in items.values()):
            findings.append(finding("invalid_drawing_intent", f"{where}: {entry.pn} already has an item; one row per PN",
                                    item=entry.item))
            continue
        if entry.refs is None:
            resolved = [resolve(entry.pn, where)]
        else:
            resolved = [resolve(ref, where) for ref in entry.refs]
            for ref, oid in zip(entry.refs, resolved):
                if oid is not None and occurrences[oid].pn != entry.pn:
                    findings.append(finding("invalid_drawing_intent", f"{where}: {ref} is an occurrence of "
                                                                      f"{occurrences[oid].pn}, not {entry.pn}"))
        ids = tuple(oid for oid in resolved if oid is not None)
        if len(set(ids)) != len(ids):
            findings.append(finding("invalid_drawing_intent", f"{where}: an occurrence is listed twice"))
        for oid in ids:
            if oid in item_of:
                findings.append(finding("assembly_item_unidentified",
                                        f"{occurrences[oid].ref} belongs to items {item_of[oid]} and {entry.item}"))
            item_of[oid] = entry.item
        items[entry.item] = (entry.pn, ids)
        row = bom.get(entry.pn)
        if row is None:
            findings.append(finding("bom_geometry_mismatch", f"item {entry.item}: {entry.pn} has no bom.csv row",
                                    item=entry.item))
        elif entry.pn not in bom_children and (row["qty"] != counts.get(entry.pn, 0) or len(ids) != counts.get(entry.pn, 0)):
            findings.append(finding("bom_geometry_mismatch",
                                    f"item {entry.item}: {entry.pn} has bom.csv quantity {row['qty']}, "
                                    f"{counts.get(entry.pn, 0)} occurrences in the assembly STEP and {len(ids)} in the item",
                                    item=entry.item))
    for o in geometry.occurrences:
        if o.occurrence_id not in item_of:
            findings.append(finding("assembly_item_unidentified", f"occurrence {o.ref} ({o.pn}) has no parts-list item"))
    for pn in sorted(set(bom) - set(counts) - bom_children):
        findings.append(finding("bom_geometry_mismatch", f"bom.csv lists {pn}, which the assembly STEP does not place"))

    explode: dict[str, Vec] = {}
    for ref, offset in intent.explode.items():
        oid = resolve(ref, "drawing/explode")
        if oid is not None:
            explode[oid] = offset

    by_interface = {i.get("id"): i for i in interfaces}
    joints = geometry.joints
    resolved_ops: list[ResolvedOperation] = []
    for operation in intent.operations:
        where = f"drawing/operations/{operation.id}"
        part, into = resolve(operation.part, where), resolve(operation.into, where)
        if part is None or into is None:
            continue
        if part == into:
            findings.append(finding("assembly_instruction_incomplete", f"{where}: part and into are both {operation.part}"))
            continue
        interface = by_interface.get(operation.interface)
        if interface is None:
            findings.append(finding("assembly_instruction_incomplete", f"{where}: interface {operation.interface} "
                                                                       "is not in interfaces.yaml"))
            continue
        ends = [(oid, occurrences[oid].pn, counts[occurrences[oid].pn] == 1) for oid in (part, into)]
        limit = _limit(interface, operation.kind, ends[0], ends[1])
        if limit is None:
            findings.append(finding("assembly_instruction_incomplete",
                                    f"{where}: {operation.interface} has no limits.{operation.kind} joining "
                                    f"{operation.part} and {operation.into}", operation=operation.id))
            continue
        travel = None
        if operation.verify_joint is not None:
            joint = joints.get(operation.verify_joint)
            if joint is None or joint["type"] == "fixed":
                findings.append(finding("assembly_instruction_incomplete", f"{where}: verify_joint "
                                                                           f"{operation.verify_joint} is not a movable joint"))
                continue
            if joint["parent"] not in item_of or joint["child"] not in item_of:
                continue
            travel = Travel(joint=joint["id"], kind=joint["type"], low=float(joint["min"]), high=float(joint["max"]),
                            parent_item=item_of[joint["parent"]], child_item=item_of[joint["child"]])
        if part not in item_of or into not in item_of:
            continue
        direction = rotate(occurrences[into].rotation, operation.direction)
        resolved_ops.append(ResolvedOperation(operation, part, into, item_of[part], item_of[into], limit, travel,
                                              direction))

    sheets: list[SheetPlan] = []
    scopes = [(TOP, None, tuple(o.occurrence_id for o in geometry.occurrences))]
    for group_id in intent.subassembly_sheets:
        group = geometry.groups.get(group_id)
        if group is None:
            findings.append(finding("invalid_drawing_intent", f"drawing/subassembly_sheets: {group_id} is not a "
                                                              "subassembly of assembly.yaml"))
            continue
        scopes.append((group_id, group[1], group[2]))
    for number, (scope, heading, members) in enumerate(scopes, start=1):
        in_scope = set(members)
        rows, per_item = [], {}
        for item in sorted(items):
            pn, ids = items[item]
            mine = tuple(oid for oid in ids if oid in in_scope)
            if not mine:
                continue
            per_item[item] = mine
            fields = bom.get(pn, {"rev": "", "title": "", "material": "", "designation": ""})
            rows.append(PartsRow(item=item, pn=pn, rev=fields["rev"], qty=len(mine), title=fields["title"],
                                 material=fields["material"], designation=fields["designation"]))
        operations = tuple(op for op in resolved_ops if {op.part_occurrence, op.into_occurrence} <= in_scope)
        sheets.append(SheetPlan(number=number, scope=scope, heading=heading, occurrences=tuple(members),
                                rows=tuple(rows), item_occurrences=per_item, operations=operations))
    if findings:
        return None, findings
    return AssemblyPlan(intent=intent, sheets=tuple(sheets), explode=explode, bom=bom), []


# --------------------------------------------------------------------------- sheet checks


def _floats(element: Any, *names: str) -> tuple[float, ...]:
    return tuple(float(element.get(name, "0")) for name in names)


def read_balloons(root: Any) -> list[dict[str, Any]]:
    """Every balloon of a sheet SVG: item, occurrence and view, printed number, circle, leader and dot."""
    balloons = []
    for group in root.iter(f"{{{SVG_NS}}}g"):
        if group.get("data-item") is None:
            continue
        circles = [c for c in group.iter(f"{{{SVG_NS}}}circle")]
        lines = [line for line in group.iter(f"{{{SVG_NS}}}line")]
        texts = ["".join(t.itertext()).strip() for t in group.iter(f"{{{SVG_NS}}}text")]
        balloon = next((c for c in circles if c.get("fill") in (None, "none")), None)
        dot = next((c for c in circles if c.get("fill") not in (None, "none")), None)
        balloons.append({
            "item": group.get("data-item"), "occurrence": group.get("data-occurrence"), "view": group.get("data-view"),
            "text": texts[0] if texts else "",
            "circle": _floats(balloon, "cx", "cy", "r") if balloon is not None else None,
            "dot": _floats(dot, "cx", "cy") if dot is not None else None,
            "leader": _floats(lines[0], "x1", "y1", "x2", "y2") if lines else None,
        })
    return balloons


def read_parts_list(root: Any, regime: str) -> list[dict[str, str]] | None:
    """The parts-list rows of a sheet SVG keyed by PARTS_LIST_FIELDS, read by column position."""
    table = next((g for g in root.iter(f"{{{SVG_NS}}}g") if g.get("id") == "table-parts-list"), None)
    if table is None:
        return None
    cells = [(float(t.get("x", "0")), float(t.get("y", "0")), "".join(t.itertext()).strip(), t.get("font-weight"))
             for t in table.iter(f"{{{SVG_NS}}}text")]
    header = sorted((c for c in cells if c[3] == "bold"), key=lambda c: c[0])
    headings = PARTS_LIST_HEADINGS[regime]
    if [c[2] for c in header] != list(headings):
        return []
    columns = [c[0] for c in header]
    rows: dict[float, dict[str, str]] = {}
    for x, y, text, weight in cells:
        if weight == "bold":
            continue
        column = min(range(len(columns)), key=lambda i: abs(columns[i] - x))
        rows.setdefault(round(y, 3), {field: "" for field in PARTS_LIST_FIELDS})[PARTS_LIST_FIELDS[column]] = text
    return [rows[y] for y in sorted(rows, reverse=True)]   # next to the header first


def _near(a: Sequence[float], b: Sequence[float], tolerance: float = ENDPOINT_TOLERANCE_MM) -> bool:
    return math.dist(a, b) <= tolerance


def check_sheet(svg_text: str, evidence: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Findings for one composed sheet against the run's evidence; an empty list means it passes.

    ``evidence``: ``sheet``, ``scope``, ``regime``, ``items`` (item -> PN, qty, occurrences in scope),
    ``bom`` (PN -> rev, qty, title, material, designation) and ``views`` (view id -> balloons flag,
    sheet ``bounds`` and the measured sheet ``anchors`` of its occurrences).
    """
    sheet = evidence["sheet"]
    root = SafeET.fromstring(svg_text, forbid_dtd=True)
    found: list[dict[str, Any]] = []

    def fail(code: str, message: str) -> None:
        found.append(finding(code, message, sheet=sheet))

    items = {int(k): v for k, v in evidence["items"].items()}
    rows = read_parts_list(root, evidence["regime"])
    if rows is None:
        fail("assembly_item_unidentified", "the sheet has no parts list")
        rows = []
    elif not rows and items:
        fail("assembly_item_unidentified", "the parts-list header does not match the regime's columns")
    listed: dict[int, dict[str, str]] = {}
    for row in rows:
        try:
            number = int(row["item"])
        except ValueError:
            fail("assembly_item_unidentified", f"parts-list row {row} has no item number")
            continue
        if number in listed:
            fail("assembly_item_unidentified", f"item {number} is listed twice")
        listed[number] = row
    for number in sorted(set(items) - set(listed)):
        fail("assembly_item_unidentified", f"item {number} ({items[number]['PN']}) is missing from the parts list")
    for number in sorted(set(listed) - set(items)):
        fail("assembly_item_unidentified", f"parts-list item {number} is not an item of this sheet's scope")
    for number in sorted(set(listed) & set(items)):
        row, expected = listed[number], items[number]
        bom = evidence["bom"].get(expected["PN"], {})
        if row["PN"] != expected["PN"]:
            fail("bom_geometry_mismatch", f"item {number} lists {row['PN']}, expected {expected['PN']}")
        if row["qty"] != str(expected["qty"]) or expected["qty"] != len(expected["occurrences"]):
            fail("bom_geometry_mismatch", f"item {number} lists quantity {row['qty']}; the sheet places "
                                          f"{len(expected['occurrences'])} occurrences")
        if evidence["scope"] == TOP and row["qty"] != str(bom.get("qty")):
            fail("bom_geometry_mismatch", f"item {number} lists quantity {row['qty']}; bom.csv rolls up {bom.get('qty')}")
        for field in ("rev", "title", "material", "designation"):
            if row[field] != str(bom.get(field, "")):
                fail("bom_geometry_mismatch", f"item {number} {field} {row[field]!r} differs from bom.csv "
                                              f"{bom.get(field, '')!r}")

    balloons = read_balloons(root)
    views = evidence["views"]
    for balloon in balloons:
        if balloon["view"] not in views or not views[balloon["view"]]["balloons"]:
            fail("assembly_item_unidentified", f"balloon {balloon['item']} is in view {balloon['view']}, "
                                               "which carries no balloons")
    for view_id, view in views.items():
        mine = [b for b in balloons if b["view"] == view_id]
        if not view["balloons"]:
            continue
        numbers = [b["item"] for b in mine]
        for number in sorted(listed, key=int):
            count = numbers.count(str(number))
            if count != 1:
                fail("assembly_item_unidentified", f"item {number} has {count} balloons in view {view_id}; expected one")
        for balloon in mine:
            label = f"balloon {balloon['item']} in view {view_id}"
            try:
                number = int(balloon["item"])
            except ValueError:
                fail("assembly_item_unidentified", f"{label} has no item number")
                continue
            if number not in listed:
                fail("assembly_item_unidentified", f"{label} names no parts-list item")
                continue
            if balloon["text"] != str(number):
                fail("assembly_item_unidentified", f"{label} prints {balloon['text']!r}")
            occurrence = balloon["occurrence"]
            if number in items and occurrence not in items[number]["occurrences"]:
                fail("assembly_item_unidentified", f"{label} points at {occurrence}, not an occurrence of item {number}")
                continue
            anchor = view["anchors"].get(occurrence)
            if anchor is None:
                fail("feature_not_presentable", f"{label}: {occurrence} has no visible surface point in the view")
                continue
            dot, leader, circle = balloon["dot"], balloon["leader"], balloon["circle"]
            if dot is None or leader is None or circle is None:
                fail("assembly_item_unidentified", f"{label} lacks its circle, leader or terminating dot")
                continue
            if not _near(dot, anchor):
                fail("assembly_item_unidentified", f"{label} ends at ({dot[0]:.2f}, {dot[1]:.2f}), not on {occurrence} "
                                                   f"at ({anchor[0]:.2f}, {anchor[1]:.2f})")
            x0, y0, x1, y1 = view["bounds"]
            if not (x0 <= dot[0] <= x1 and y0 <= dot[1] <= y1):
                fail("assembly_item_unidentified", f"{label} ends outside the view")
            start, end = leader[:2], leader[2:]
            on_circle = abs(math.dist(start, circle[:2]) - circle[2]) <= ENDPOINT_TOLERANCE_MM
            if not (_near(end, dot) and on_circle):
                fail("assembly_item_unidentified", f"{label}: its leader does not join the balloon to its dot")
    return found


# --------------------------------------------------------------------------- package CLI


def check_package(package: Path) -> dict[str, Any]:
    """Re-check every sheet of a published (or rejected) assembly package against its recorded evidence."""
    marker = package / "package.json"
    if not marker.is_file():
        marker = package / "rejected.json"
    record = json.loads(marker.read_text(encoding="utf-8"))
    evidence = [row for row in record["coverage"].get("rows", []) if row.get("kind") == "assembly_sheet"]
    if not evidence:
        return {"status": "error", "findings": [finding("invalid_drawing_intent", f"{marker} records no assembly sheets")]}
    filenames = {sheet["sheet"]: sheet.get("files", {}).get("svg", f"sheet-{sheet['sheet']}.svg")
                 for sheet in record.get("sheets", [])}
    findings: list[dict[str, Any]] = []
    for sheet in evidence:
        number = sheet["sheet"]
        filename = filenames.get(number, f"sheet-{number}.svg")
        svg_path = package / Path(filename).name
        if not svg_path.is_file():
            rejected = package / f"sheet-{number}.rejected.svg"
            if rejected.is_file():
                svg_path = rejected
            else:
                findings.append(finding("assembly_item_unidentified", f"sheet {number} SVG is missing", sheet=number))
                continue
        findings.extend(check_sheet(svg_path.read_text(encoding="utf-8"), sheet))
    return {"status": "pass" if not findings else "fail", "package": str(package), "sheets": len(evidence),
            "findings": findings}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Re-check an assembly drawing package: balloons, parts list, leaders.")
    parser.add_argument("package", type=Path, help="the --output-dir of assembly_drawing.py")
    args = parser.parse_args(argv)
    try:
        result = check_package(args.package.resolve())
    except (OSError, ValueError, KeyError) as exc:
        result = {"status": "error", "findings": [finding("invalid_drawing_intent", f"cannot read the package: {exc}")]}
    print(json.dumps(result, indent=2))
    return {"pass": 0, "fail": 1}.get(result["status"], 2)


if __name__ == "__main__":
    raise SystemExit(main())
