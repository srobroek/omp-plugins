"""Design rules over the cad-record documents: clearance margins, retention, process feasibility and
visibility bindings.

The rules take parsed record documents, already schema-valid when validate.py calls them, and return
`RuleFinding`s; validate.py turns those into report findings with a path and a stage-graded severity.
`load_clearance_margins` is the one reader of the clearance margin: cad-model check and cad-motion sweep
load this module by path as `cad_record_design_rules` and register it in `sys.modules` before running it.
It needs PyYAML and the standard library only.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

import yaml

DEFAULT_CLEARANCE_MARGIN_MM = 0.1  # the user's "0.5 required -> 0.6 designed"
DEFAULT_MIN_VISIBLE_FRACTION = 0.5

TORQUE_CODE = "retention.torque_path"
AXIAL_CODE = "retention.axial_retainer"
TRANSPARENT_FDM_CODE = "feasibility.transparent_fdm"  # structured: a part declares itself transparent
TRANSPARENCY_CLAIM_CODE = "feasibility.transparency_claim"  # prose names something see-through
VISIBILITY_CODE = "visibility.binding"

# Retention types provided by a separate piece of hardware: it must be a modelled occurrence, because a
# decision record naming set screws that were never modelled left the engine's flywheel unretained.
TORQUE_HARDWARE = frozenset({"key", "set_screw", "pin"})
AXIAL_HARDWARE = frozenset({"circlip", "set_screw", "nut", "pin", "cap"})
# "Press or slip" fits, in cad-record's fit vocabulary; a running fit is a motion fit and is exempt.
RETAINED_FITS = ("press_fit", "locating_fit")

# A transparency claim in prose. It only ever raises a warning that asks for a structured `transparency`.
# Bare "clear" is too common ("clear of", "clear coat", "a clear window for the cable"), so it counts only
# next to a material, as an attribute of a cover-like part, or as what such a part "is".
_POLYMER = r"petg|pla|abs|asa|pc|polycarbonate|pmma|acrylic|resin|filament|plastic|polymer|material"
_COVER = r"window|cover|lid|panel|case|housing|enclosure|dome|lens|bezel|shield"
TRANSPARENT_TEXT = re.compile(
    rf"\b(?:transparent|see[- ]through|glass[- ]clear|optically[- ]clear|crystal[- ]clear)\b"
    rf"|\bvisible\s+through\b"
    rf"|\bglass[- ](?:{_COVER})s?\b"
    rf"|\bclear[- ](?:{_POLYMER}|{_COVER})s?\b(?!\s+for\b)"
    rf"|\b(?:{_POLYMER})\s*\(?\s*clear\b(?!\s+of\b)"
    rf"|\b(?:{_COVER})s?\s+(?:is|are|be|stays?|remains?)\s+clear\b(?!\s+of\b)",
    re.IGNORECASE,
)
# A negation just before a match ("not transparent", "non-transparent", "never see-through") cancels it.
_NEGATED = re.compile(r"(?:\b(?:not|never)\s+(?:[\w-]+\s+){0,2}|\bnon-?\s*)$", re.IGNORECASE)

Resolve = Callable[[str], "str | None"]  # a part_ref -> its occurrence id, or None when it resolves to none


@dataclass(frozen=True)
class RuleFinding:
    """One rule violation: its stable code, its location inside the record document, and the fix."""

    code: str
    location: str
    message: str


# --- clearance margin -------------------------------------------------------------------------------


@dataclass(frozen=True)
class ClearanceMargins:
    """The effective clearance margin of every clearance requirement.

    Below a requirement's minimum is a failure; at or above it but below minimum + margin is a `margin`
    warning, never a failure.
    """

    default_mm: float
    by_interface: Mapping[str, float]  # clearance interface id -> its margin_mm, else default_mm

    def for_interface(self, interface_id: str | None) -> float:
        """The margin of clearance interface `interface_id`; None names a global minimum, which has the
        default. Any other id raises KeyError."""
        if interface_id is None:
            return self.default_mm
        return self.by_interface[interface_id]


def _margin(value: Any, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{where} must be a finite number >= 0, got {value!r}")
    return float(value)


def _mapping(value: Any, where: str) -> Mapping[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError(f"{where} must be a mapping, got {type(value).__name__}")
    return value


def clearance_margins(product: Any, interfaces: Any) -> ClearanceMargins:
    """The margins product.yaml `design.clearance_margin_mm` and each clearance interface's `margin_mm` give.

    `product` and `interfaces` are the parsed documents, or None when the file is absent. Raises
    ValueError on a malformed value instead of falling back to the default.
    """
    design = _mapping(_mapping(product, "product.yaml").get("design"), "product.yaml design")
    default = (_margin(design["clearance_margin_mm"], "product.yaml design.clearance_margin_mm")
               if "clearance_margin_mm" in design else DEFAULT_CLEARANCE_MARGIN_MM)
    entries = _mapping(interfaces, "interfaces.yaml").get("interfaces") or []
    if not isinstance(entries, list):
        raise ValueError("interfaces.yaml interfaces must be a list")
    by_interface: dict[str, float] = {}
    for index, entry in enumerate(entries):
        entry = _mapping(entry, f"interfaces.yaml interfaces/{index}")
        if "margin_mm" in entry and "min_clearance_mm" not in entry:
            raise ValueError(f"interfaces.yaml interfaces/{index}: margin_mm needs min_clearance_mm")
        if "min_clearance_mm" in entry:
            by_interface[str(entry.get("id"))] = (
                _margin(entry["margin_mm"], f"interfaces.yaml interfaces/{index}/margin_mm")
                if "margin_mm" in entry else default)
    return ClearanceMargins(default, MappingProxyType(by_interface))


def _read_yaml(path: Path) -> Any:
    if not path.is_file():
        return None
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise ValueError(f"cannot read {path}: {error}") from error


def load_clearance_margins(record_dir: Path) -> ClearanceMargins:
    """`clearance_margins` of `record_dir`'s product.yaml and interfaces.yaml: hw/, or the `record/`
    snapshot of the version being checked."""
    return clearance_margins(_read_yaml(record_dir / "product.yaml"), _read_yaml(record_dir / "interfaces.yaml"))


# --- retention --------------------------------------------------------------------------------------


def _unresolved_parts(retention: Mapping[str, Any], resolve: Resolve) -> list[str]:
    return [ref for ref in retention.get("parts", []) if resolve(ref) is None]


def _hardware_problem(retention: Mapping[str, Any], hardware: frozenset[str], resolve: Resolve) -> str | None:
    """Why a retention's hardware is not modelled, or None when it is."""
    missing = _unresolved_parts(retention, resolve)
    if missing:
        return f"parts {', '.join(missing)} do not resolve to one modelled occurrence each"
    if retention["type"] in hardware and not retention.get("parts"):
        return f"a {retention['type']} needs `parts` naming the modelled hardware occurrences"
    return None


def torque_path_findings(assembly: Mapping[str, Any], resolve: Resolve) -> list[RuleFinding]:
    """Every rotating joint says whether it carries drive torque, and every connection inside a drive
    train says how.

    Each revolute declares `torque`: `transmitted` when its child carries drive torque (a crank, camshaft,
    gear or pulley shaft, coupled or not), or `none` for a hand-positioned or free-running joint. A drive
    train is the child of every revolute not declared `none` (an undeclared one counts, so one run reports
    all of its fixed joints) and that child's fixed-joint descendants. Each fixed joint inside it declares
    `torque`, and a fixed joint declared `transmitted` names its `torque_path`. A hardware torque path names
    the modelled hardware.
    """
    joints = [joint for joint in assembly.get("joints", []) if isinstance(joint, Mapping)]
    fixed_by_parent: dict[str, list[Mapping[str, Any]]] = {}
    for joint in joints:
        parent = resolve(joint["parent"])
        if joint["type"] == "fixed" and parent is not None:
            fixed_by_parent.setdefault(parent, []).append(joint)
    in_drive_train: set[str] = set()  # fixed joint ids inside a drive train
    stack = [oid for oid in (resolve(joint["child"]) for joint in joints
                             if joint["type"] == "revolute" and joint.get("torque") != "none") if oid]
    seen: set[str] = set()
    while stack:
        oid = stack.pop()
        if oid in seen:
            continue
        seen.add(oid)
        for joint in fixed_by_parent.get(oid, []):
            in_drive_train.add(joint["id"])
            child = resolve(joint["child"])
            if child is not None:
                stack.append(child)

    findings = []
    for joint in joints:
        where = f"joints/{joint['id']}"
        if "torque" not in joint:
            if joint["type"] == "revolute":
                findings.append(RuleFinding(TORQUE_CODE, where, (
                    f"{joint['id']} turns {joint['child']} but declares no torque: set `torque: transmitted` when "
                    "its child carries drive torque (a crank, camshaft, gear or pulley shaft), or `torque: none` "
                    "for a hand-positioned or free-running joint")))
            elif joint["id"] in in_drive_train:
                findings.append(RuleFinding(TORQUE_CODE, where, (
                    f"{joint['id']} fixes {joint['child']} inside a drive train but declares no torque: set "
                    "`torque: transmitted` with a `torque_path` (key, set_screw, d_flat, press_fit, spline, clamp, "
                    "pin, adhesive), or `torque: none` when it carries no drive torque")))
            continue
        if joint["torque"] != "transmitted":
            continue
        path = joint.get("torque_path")
        if path is None:
            if joint["type"] == "fixed":
                findings.append(RuleFinding(TORQUE_CODE, where, (
                    f"{joint['id']} transmits torque to {joint['child']} without a `torque_path`: declare the key, "
                    "set screw, D-flat, press fit, spline, clamp, pin or adhesive that carries it")))
            continue
        problem = _hardware_problem(path, TORQUE_HARDWARE, resolve)
        if problem is not None:
            findings.append(RuleFinding(TORQUE_CODE, f"{where}/torque_path", f"{joint['id']} torque_path: {problem}"))
    return findings


def axial_retainer_findings(interfaces: Mapping[str, Any], resolve: Resolve) -> list[RuleFinding]:
    """Every press or slip fit (`press_fit`, `locating_fit`) declares what holds it axially."""
    findings = []
    for index, interface in enumerate(interfaces.get("interfaces", [])):
        limits = interface.get("limits") or {}
        for kind in RETAINED_FITS:
            fit = limits.get(kind)
            if not isinstance(fit, Mapping):
                continue
            where = f"interfaces/{index}/limits/{kind}"
            label = f"{interface['id']} {kind} {fit['fit']}"
            retainer = fit.get("axial_retainer")
            if retainer is None:
                findings.append(RuleFinding(AXIAL_CODE, where, (
                    f"{label} has no `axial_retainer`: declare the shoulder, circlip, set screw, nut, pin, cap, "
                    "capture, press fit or adhesive that keeps it from walking along its axis")))
                continue
            if retainer["type"] == "press_fit" and kind != "press_fit":
                findings.append(RuleFinding(AXIAL_CODE, f"{where}/axial_retainer",
                                            f"{label}: a clearance or transition fit cannot be its own press-fit "
                                            "retainer; name the feature or hardware that holds it"))
                continue
            problem = _hardware_problem(retainer, AXIAL_HARDWARE, resolve)
            if problem is not None:
                findings.append(RuleFinding(AXIAL_CODE, f"{where}/axial_retainer", f"{label} axial_retainer: {problem}"))
    return findings


# --- process feasibility ----------------------------------------------------------------------------


def transparency_claimed(text: Any) -> bool:
    """Whether prose names something see-through, such as "clear PETG", "the covers are clear" or "visible
    through"; a negated mention ("not transparent", "non-transparent", "never see-through") does not count."""
    if not isinstance(text, str):
        return False
    return any(not _NEGATED.search(text[max(0, match.start() - 40):match.start()])
               for match in TRANSPARENT_TEXT.finditer(text))


def part_feasibility_findings(part: Mapping[str, Any]) -> list[RuleFinding]:
    """An FDM part cannot be transparent: FDM prints translucent at best, as layer lines and infill scatter
    light. A declared `transparency: transparent` is a `TRANSPARENT_FDM_CODE` contradiction; an undeclared
    one that the material or finish prose names is a `TRANSPARENCY_CLAIM_CODE` request to declare it."""
    if part.get("process") != "fdm":
        return []
    transparency = part.get("transparency")
    if transparency == "transparent":
        return [RuleFinding(TRANSPARENT_FDM_CODE, "transparency", (
            f"{part['PN']} is FDM but declares transparency: transparent; FDM prints translucent, not see-through. "
            "Record a decision: make the see-through element a purchased or machined part (cast acrylic, "
            "polycarbonate), or accept `transparency: translucent`"))]
    if transparency is not None:
        return []
    for field in ("material", "finish"):
        if transparency_claimed(part.get(field)):
            return [RuleFinding(TRANSPARENCY_CLAIM_CODE, field, (
                f"{part['PN']} is FDM and its {field} reads as see-through, but FDM prints translucent. Declare "
                "`transparency` (translucent, or opaque), or make the see-through element a purchased or "
                "machined part declared `transparency: transparent`"))]
    return []


def requirement_feasibility_findings(requirements: Mapping[str, Any], product: Mapping[str, Any],
                                     parts: Iterable[Mapping[str, Any]]) -> list[RuleFinding]:
    """A requirement whose prose asks for something see-through, in a product planned for FDM, while no
    non-FDM part declares `transparency: transparent`: a `TRANSPARENCY_CLAIM_CODE` prompt, from INTENT on
    (product.yaml `manufacturing.processes`), before any part exists."""
    parts = list(parts)
    processes = set((product.get("manufacturing") or {}).get("processes", []))
    processes |= {part.get("process") for part in parts}
    if "fdm" not in processes:
        return []
    if any(part.get("process") != "fdm" and part.get("transparency") == "transparent" for part in parts):
        return []
    findings = []
    for index, requirement in enumerate(requirements.get("requirements", [])):
        criteria = (requirement.get("verification") or {}).get("criteria")
        if transparency_claimed(requirement.get("text")) or transparency_claimed(criteria):
            findings.append(RuleFinding(TRANSPARENCY_CLAIM_CODE, f"requirements/{index}", (
                f"{requirement['id']} reads as asking for a see-through element, but the product is planned for "
                "FDM, which prints translucent, and no purchased or machined part declares `transparency: "
                "transparent`. Ask the user, record the decision, then declare that part or reword the requirement")))
    return findings


# --- visibility bindings ----------------------------------------------------------------------------


@dataclass(frozen=True)
class VisibilityBinding:
    """One "show the motion" check: from `view`, rendering only `window` and `targets`, each
    target's own visible share of its projected area must reach `min_visible_fraction`; the check
    fails when any target falls short. Only `transparency: transparent` window parts are see-through."""

    requirement: str
    index: int
    view: str
    window: tuple[str, ...]
    targets: tuple[str, ...]
    min_visible_fraction: float


def visibility_bindings(requirements: Mapping[str, Any]) -> list[VisibilityBinding]:
    """Every requirement's `visibility` bindings, in record order, with the defaults applied."""
    return [
        VisibilityBinding(requirement["id"], index, binding["view"], tuple(binding["window"]),
                          tuple(binding["targets"]),
                          float(binding.get("min_visible_fraction", DEFAULT_MIN_VISIBLE_FRACTION)))
        for requirement in requirements.get("requirements", [])
        for index, binding in enumerate(requirement.get("visibility", []))
    ]


def visibility_findings(requirements: Mapping[str, Any], resolve: Resolve) -> list[RuleFinding]:
    """Each binding's window and target parts resolve to occurrences, and no part is both."""
    findings = []
    for number, requirement in enumerate(requirements.get("requirements", [])):
        for index, binding in enumerate(requirement.get("visibility", [])):
            where = f"requirements/{number}/visibility/{index}"
            resolved: dict[str, set[str]] = {}
            for side in ("window", "targets"):
                resolved[side] = set()
                for ref in binding[side]:
                    oid = resolve(ref)
                    if oid is None:
                        findings.append(RuleFinding(VISIBILITY_CODE, f"{where}/{side}",
                                                    f"{requirement['id']} visibility {side} part {ref} does not "
                                                    "resolve to one occurrence"))
                    else:
                        resolved[side].add(oid)
            both = resolved["window"] & resolved["targets"]
            if both:
                findings.append(RuleFinding(VISIBILITY_CODE, where,
                                            f"{requirement['id']} visibility names {', '.join(sorted(both))} as "
                                            "both window and target"))
    return findings
