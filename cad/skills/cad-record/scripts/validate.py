#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["jsonschema>=4.23", "pyyaml>=6.0"]
# ///
"""Validate a CAD hardware design record and print a JSON findings report."""

from __future__ import annotations

import argparse
import csv
import functools
import hashlib
import importlib.util
import json
import os
import posixpath
import re
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assembly_data  # noqa: E402 - the sibling module, beside this script in the skill


def _load_module(name: str, path: Path) -> Any:
    """A standard-library module loaded once by path and registered in sys.modules, where dataclasses look it up."""
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"{path.name} not found at {path}")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


# cad-motion's kernel-free coupling laws, the one reader of joint couplings, profiles and mechanisms.
coupling = _load_module("cad_motion_coupling", Path(__file__).resolve().parents[2] / "cad-motion" / "scripts" / "coupling.py")
# The canonical hw/ layout (layout.json beside schemas/), the one reader of where record and output files live.
layout = _load_module("cad_record_layout", Path(__file__).resolve().parent / "layout.py")
# cad-motion's pose.py and plan.py, loaded only for a record with authored motion cases.
MOTION_SCRIPTS = Path(__file__).resolve().parents[2] / "cad-motion" / "scripts"

SCHEMAS = Path(__file__).resolve().parent.parent / "schemas"
BOM_COLUMNS = ["level", "PN", "rev", "qty", "title", "material", "process", "make_buy", "supplier", "mass"]
# Appended procurement columns, generated from part.yaml `procurement`; a BOM carries all or none of them.
BOM_PROCUREMENT_COLUMNS = ["unit", "designation", "manufacturer", "manufacturer_part_number",
                           "supplier_part_number", "specification_ref", "specification_rev"]
CSV_COLUMNS = {
    "bom.csv": (BOM_COLUMNS, BOM_COLUMNS + BOM_PROCUREMENT_COLUMNS),
    "verification.csv": (["requirement_id", "method", "criteria", "result", "evidence"],),
}
DATUM_LABEL = re.compile(r"[A-HJ-NPR-Z]{1,2}")


NONBLOCKING = frozenset({"warning", "info"})


def finding(path: str, message: str, *, severity: str = "error", code: str | None = None,
            canonical_location: str | None = None, action: str | None = None) -> dict[str, Any]:
    """One report item; a layout finding also carries its stable `code`, `canonical_location` and `action`."""
    item: dict[str, Any] = {"path": path, "message": message, "severity": severity}
    if code is not None:
        item.update(code=code, canonical_location=canonical_location, action=action)
    return item


def blocking(findings: Iterable[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """The findings that fail validation: errors, and any severity this validator does not define.

    Warnings and info stay in the report and never fail it. validate.py's exit code and cad-drawings
    drawing_contract both decide through this one function.
    """
    return [item for item in findings if item.get("severity") not in NONBLOCKING]


def load_yaml(path: Path, findings: list[dict[str, str]]) -> Any:
    try:
        with path.open(encoding="utf-8") as stream:
            return yaml.safe_load(stream)
    except (OSError, yaml.YAMLError) as error:
        findings.append(finding(str(path), f"cannot read YAML: {error}"))
        return None


def load_json(path: Path, findings: list[dict[str, str]]) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        findings.append(finding(str(path), f"cannot read JSON: {error}"))
        return None


@functools.cache
def schema_registry() -> Registry:
    """Every bundled schema by its $id, so `drawing.schema.json#/$defs/...` references resolve offline."""
    resources = []
    for path in sorted(SCHEMAS.glob("*.schema.json")):
        contents = json.loads(path.read_text(encoding="utf-8"))
        resources.append((contents["$id"], Resource.from_contents(contents)))
    return Registry().with_resources(resources)


def validate_document(
    data: Any, schema_name: str, path: str, findings: list[dict[str, str]]
) -> bool:
    schema_path = SCHEMAS / schema_name
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        findings.append(finding(str(schema_path), f"cannot load schema: {error}"))
        return False
    validator = Draft202012Validator(schema, registry=schema_registry(), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(data), key=lambda error: list(error.absolute_path))
    for error in errors:
        location = "/".join(str(part) for part in error.absolute_path)
        findings.append(finding(path, f"{location + ': ' if location else ''}{error.message}"))
    return not errors


def read_csv(path: Path, accepted: tuple[list[str], ...], findings: list[dict[str, str]]) -> list[dict[str, str]]:
    """Rows of a CSV whose header is exactly one of the `accepted` column lists."""
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            if reader.fieldnames not in accepted:
                orders = " or ".join(",".join(columns) for columns in accepted)
                findings.append(finding(str(path), f"expected CSV columns in order: {orders}"))
                return []
            return list(reader)
    except OSError as error:
        findings.append(finding(str(path), f"cannot read CSV: {error}"))
        return []


def procurement_cells(part: dict[str, Any]) -> dict[str, str | None]:
    """The appended BOM columns as cad-bom generates them from a part.yaml; `unit` names what qty counts."""
    procurement = part.get("procurement") or {}
    specification = procurement.get("specification") or {}
    return {
        "unit": "pcs",
        "designation": procurement.get("designation"),
        "manufacturer": procurement.get("manufacturer"),
        "manufacturer_part_number": procurement.get("manufacturer_part_number"),
        "supplier_part_number": procurement.get("supplier_part_number"),
        "specification_ref": specification.get("reference"),
        "specification_rev": specification.get("revision"),
    }


def stated_general_tolerance(policy: dict[str, Any]) -> str | float:
    """The `general_tolerance` text or number that states a structured tolerance policy."""
    if policy["kind"] == "standard":
        return f"ISO 2768-{policy['class']}"  # the only standard policy the schema admits is ISO 2768-1:1989
    return policy["linear_mm"]


def check_product_drawing(product: dict[str, Any], path: str, findings: list[dict[str, str]]) -> None:
    drawing = product.get("drawing")
    if not isinstance(drawing, dict):
        return
    name = drawing["general_tolerance_policy"]
    policy = drawing["tolerance_policies"].get(name)
    if policy is None:
        findings.append(finding(path, f"drawing/general_tolerance_policy {name!r} is not in drawing/tolerance_policies"))
    elif product["general_tolerance"] != stated_general_tolerance(policy):
        findings.append(finding(path, f"general_tolerance {product['general_tolerance']!r} does not state the {name} "
                                      f"policy; expected {stated_general_tolerance(policy)!r}"))
    family = {"iso": "ISO ", "asme": "ASME "}[product["regime"]]
    dimensioning = drawing["standards"]["dimensioning"]
    if not dimensioning.startswith(family):
        findings.append(finding(path, f"drawing/standards/dimensioning {dimensioning!r} does not belong to the "
                                      f"{product['regime']} regime"))


def check_part_drawing(part: dict[str, Any], path: str, product_drawing: dict[str, Any] | None,
                       findings: list[dict[str, str]]) -> None:
    """Cross-references inside part.yaml `drawing` and to product.yaml's tolerance policies."""
    drawing = part.get("drawing")
    if not isinstance(drawing, dict):
        return
    datums = set(drawing.get("datum_features", {}))

    def datum(where: str, ref: Any) -> None:
        if isinstance(ref, str) and DATUM_LABEL.fullmatch(ref) and ref not in datums:
            findings.append(finding(path, f"drawing/{where}: datum {ref} is not declared in drawing/datum_features"))

    frame = drawing.get("coordinate_frame", {})
    origin = frame.get("origin", {})
    for ref in [*origin.get("intersection", []), origin.get("at")]:
        datum("coordinate_frame/origin", ref)
    for axis in ("x", "y", "z"):
        for key, ref in frame.get(axis, {}).items():
            datum(f"coordinate_frame/{axis}/{key}", ref)
    for key, ref in drawing.get("manufacturing", {}).get("build_direction", {}).items():
        datum(f"manufacturing/build_direction/{key}", ref)

    views = drawing.get("views", [])
    view_ids = [view["id"] for view in views]
    for duplicate in sorted({v for v in view_ids if view_ids.count(v) > 1}):
        findings.append(finding(path, f"drawing/views: view id {duplicate} is used more than once"))
    for index, view in enumerate(views):
        for key in ("normal_to", "along_axis", "parallel_to", "perpendicular_to", "toward"):
            datum(f"views/{index}/{key}", view.get(key))
        through = view.get("through")
        for ref in through if isinstance(through, list) else [through]:
            datum(f"views/{index}/through", ref)
        if "opposite" in view and (view["opposite"] == view["id"] or view["opposite"] not in view_ids):
            findings.append(finding(path, f"drawing/views/{index}/opposite: {view['opposite']!r} is not another view"))

    policies: list[tuple[str, str]] = []
    if "tolerance_policy" in drawing:
        policies.append(("tolerance_policy", drawing["tolerance_policy"]))
    for feature, intent in drawing.get("features", {}).items():
        datum(f"features/{feature}/axial_location_from", intent.get("axial_location_from"))
        if "tolerance_policy" in intent:
            policies.append((f"features/{feature}/tolerance_policy", intent["tolerance_policy"]))
    dimensions = drawing.get("dimensions", [])
    dimension_ids = [dimension["id"] for dimension in dimensions]
    for duplicate in sorted({d for d in dimension_ids if dimension_ids.count(d) > 1}):
        findings.append(finding(path, f"drawing/dimensions: dimension id {duplicate} is used more than once"))
    for index, dimension in enumerate(dimensions):
        for ref in dimension.get("datum_frame", []):
            datum(f"dimensions/{index}/datum_frame", ref)
        tolerance = dimension.get("tolerance", {})
        if "policy" in tolerance:
            policies.append((f"dimensions/{index}/tolerance/policy", tolerance["policy"]))
        lower, upper = tolerance.get("deviation_mm", (0.0, 1.0))
        if lower >= upper:
            findings.append(finding(path, f"drawing/dimensions/{index}/tolerance/deviation_mm: lower {lower} "
                                          f"must be below upper {upper}"))
    tolerances = drawing.get("geometric_tolerances", [])
    tolerance_ids = [tolerance["id"] for tolerance in tolerances]
    for duplicate in sorted({t for t in tolerance_ids if tolerance_ids.count(t) > 1}):
        findings.append(finding(path, f"drawing/geometric_tolerances: id {duplicate} is used more than once"))
    for index, tolerance in enumerate(tolerances):
        for ref in tolerance.get("datum_frame", []):
            datum(f"geometric_tolerances/{index}/datum_frame", ref)

    # edges and surface texture are what a detail drawing specifies; a vendor item has them as supplied
    indications = [("", drawing)] + [(f"features/{f}/", intent) for f, intent in drawing.get("features", {}).items()]
    for where, owner in indications:
        if drawing["type"] != "detail":
            for field in ("edges", "surface_texture"):
                if field in owner:
                    findings.append(finding(path, f"drawing/{where}{field}: only a detail drawing specifies {field}; "
                                                  f"a {drawing['type']} item has them as supplied"))
        for kind, (lower, upper) in owner.get("edges", {}).items():
            if lower >= upper:
                findings.append(finding(path, f"drawing/{where}edges/{kind}: lower {lower} must be below upper {upper}"))

    defined = (product_drawing or {}).get("tolerance_policies", {})
    for where, name in policies:
        policy = defined.get(name)
        if policy is None:
            findings.append(finding(path, f"drawing/{where}: {name!r} is not a product.yaml drawing/tolerance_policies entry"))
        elif part["process"] not in policy["applies_to"]:
            findings.append(finding(path, f"drawing/{where}: policy {name} applies to {', '.join(policy['applies_to'])}, "
                                          f"not to process {part['process']}"))


def check_procurement(part: dict[str, Any], path: str, hw: Path, findings: list[dict[str, str]]) -> None:
    procurement = part.get("procurement")
    if not isinstance(procurement, dict):
        return
    mode = procurement["mode"]
    if mode == "catalog" and part["make_buy"] != "buy":
        findings.append(finding(path, "procurement/mode catalog requires make_buy: buy"))
    drawing_type = (part.get("drawing") or {}).get("type")
    if drawing_type is not None and (mode == "made_to_drawing") != (drawing_type == "detail"):
        findings.append(finding(path, f"procurement/mode {mode} contradicts drawing/type {drawing_type}: a made-to-drawing "
                                      "part needs a detail drawing, a catalogue item a vendor_specification or "
                                      "source_control sheet"))
    for field in sorted(set(procurement.get("open", {})) & set(procurement)):
        findings.append(finding(path, f"procurement/open/{field}: {field} is both set and declared open"))
    standard = procurement.get("standard")
    if standard is not None:
        if mode != "catalog":
            findings.append(finding(path, "procurement/standard: only a catalogue item is ordered by its standard "
                                          "designation"))
        # the designation block of a standard: its number, a dash, then the designation items (DIN 471 - 5x0.6)
        if not re.search(rf"(?<![\w.]){re.escape(standard)}\s*[-–]\s*\S", procurement.get("designation", "")):
            findings.append(finding(path, f"procurement/designation does not state the {standard} designation: "
                                          f"'{standard} - ' followed by its designation items"))
    specification = procurement.get("specification")
    if specification is None or "artifact" not in specification:
        return  # a url-only specification is a sourcing input: its frozen copy is kept outside hw/
    root = hw.resolve()
    artifact = root / specification["artifact"]
    try:
        artifact.resolve().relative_to(root)
        data = artifact.read_bytes()
    except (OSError, ValueError):
        findings.append(finding(path, f"procurement/specification/artifact {specification['artifact']!r} is not a file in hw/"))
        return
    if hashlib.sha256(data).hexdigest() != specification["sha256"]:
        findings.append(finding(path, f"procurement/specification/sha256 does not match {specification['artifact']}"))


def check_interfaces(interfaces: dict[str, Any], path: str, part_records: dict[str, Any],
                     inventory: assembly_data.Inventory | None, findings: list[dict[str, str]]) -> None:
    """Fit endpoints, heat-set pairs and clearance-requirement pairs must name existing parts, each
    resolving to one physical occurrence.

    An `@id` names an occurrence; a bare PN must have at most one occurrence. A `from`/`to` that
    starts with `@` must resolve; other `from`/`to` strings stay descriptive. A clearance
    requirement joins two distinct occurrences, and each occurrence pair has at most one.
    """

    def resolve(ref: str, where: str) -> str | None:
        """The physical identity `ref` names: an occurrence id, or the PN of a part placed nowhere."""
        if ref.startswith("@") or (inventory is not None and len(inventory.of(ref)) > 1):
            if inventory is None:
                return None
            try:
                return inventory.resolve(ref).id
            except assembly_data.UnresolvedReference as error:
                findings.append(finding(path, f"{where}: {error}"))
                return None
        if ref not in part_records:
            findings.append(finding(path, f"{where}: part {ref} does not exist"))
            return None
        return inventory.of(ref)[0].id if inventory is not None and inventory.of(ref) else ref

    def endpoint(entry: dict[str, Any], where: str) -> str | None:
        pn, occurrence = entry["PN"], entry.get("occurrence")
        if occurrence is None:
            return resolve(pn, where)
        if pn not in part_records:
            findings.append(finding(path, f"{where}: part {pn} does not exist"))
            return None
        if inventory is None:
            return None
        try:
            return inventory.endpoint(pn, occurrence).id
        except assembly_data.UnresolvedReference as error:
            findings.append(finding(path, f"{where}: {error}"))
            return None

    requirements: dict[frozenset[str | None], str] = {}  # resolved clearance pair -> the interface declaring it
    for index, interface in enumerate(interfaces["interfaces"]):
        for side in ("from", "to"):
            if interface[side].startswith("@"):
                resolve(interface[side], f"interfaces/{index}/{side}")
        if "pair" in interface:
            where, (a, b) = f"interfaces/{index}/pair", interface["pair"]
            ids = frozenset((resolve(a, where), resolve(b, where)))
            if None in ids:
                pass  # the unresolved reference is already a finding
            elif len(ids) == 1:
                findings.append(finding(path, f"{where}: {a} and {b} are the same occurrence"))
            elif ids in requirements:
                findings.append(finding(path, f"{where}: {a} / {b} already has a clearance requirement at "
                                              f"{requirements[ids]}"))
            else:
                requirements[ids] = f"interfaces/{index}"
        limits = interface.get("limits", {})
        for kind in ("press_fit", "running_fit", "locating_fit"):
            fit = limits.get(kind)
            if not isinstance(fit, dict):
                continue
            where = f"interfaces/{index}/limits/{kind}"
            if "pair" in fit:
                for ref in fit["pair"]:
                    resolve(ref, where)
            else:
                hole, shaft = endpoint(fit["hole"], where), endpoint(fit["shaft"], where)
                if hole is not None and hole == shaft:
                    findings.append(finding(path, f"{where}: hole and shaft are both on {fit['hole']['PN']}"))
        for number, entry in enumerate(limits.get("heat_set", [])):
            where = f"interfaces/{index}/limits/heat_set/{number}"
            for ref in entry["pair"]:
                resolve(ref, where)
            lower, upper = entry.get("hole_tol", (0.0, 0.0))
            if lower > upper:
                findings.append(finding(path, f"{where}/hole_tol: lower deviation {lower} exceeds upper {upper}"))


def assembly_inventory(assembly: Any, path: str, part_records: dict[str, Any],
                       findings: list[dict[str, str]]) -> assembly_data.Inventory | None:
    """The normalized occurrence inventory, or None with findings when it cannot be normalized."""
    if not isinstance(assembly, dict):
        return None
    frames = {pn: part.get("model_frame", assembly_data.DEFAULT_FRAME) for pn, (part, _) in part_records.items()}
    try:
        inventory = assembly_data.normalize(assembly, frames)
    except assembly_data.InventoryError as error:
        findings.extend(finding(path, problem) for problem in error.problems)
        return None
    for occurrence in inventory.occurrences:
        if occurrence.explicit and occurrence.pn not in part_records:
            findings.append(finding(path, f"occurrence {occurrence.ref}: part {occurrence.pn} does not exist"))
    return inventory


def check_joints(assembly: dict[str, Any], inventory: assembly_data.Inventory, path: str,
                 part_records: dict[str, Any], findings: list[dict[str, str]]) -> None:
    """Joint endpoints resolve to one occurrence each and form single-parent trees without cycles.

    A member without a joint path to the ground is not a record error: `--attach` connects it at run time.
    """
    edges: list[tuple[str, str, str]] = []
    resolved_all = True
    for joint in assembly.get("joints", []):
        if not isinstance(joint, dict):
            continue
        joint_id = joint.get("id", "joint")
        ends: dict[str, str] = {}
        for endpoint in ("parent", "child"):
            ref = joint.get(endpoint)
            if not isinstance(ref, str):
                continue
            if not ref.startswith("@"):
                if ref not in part_records:
                    findings.append(finding(path, f"{joint_id} {endpoint} part {ref!r} does not exist"))
                if not inventory.of(ref):
                    findings.append(finding(path, f"{joint_id} {endpoint} part {ref!r} is not included in any subassembly"))
                    continue
            try:
                ends[endpoint] = inventory.resolve(ref).id
            except assembly_data.UnresolvedReference as error:
                findings.append(finding(path, f"{joint_id} {endpoint}: {error}"))
        if len(ends) == 2:
            edges.append((joint_id, ends["parent"], ends["child"]))
        else:
            resolved_all = False
        try:
            lower, upper = joint["min"], joint["max"]
            if lower > upper:
                findings.append(finding(path, f"{joint_id} minimum exceeds maximum"))
            if "nominal" in joint and not lower <= joint["nominal"] <= upper:  # a coupled joint has none
                findings.append(finding(path, f"{joint_id} nominal is outside its limits"))
        except (KeyError, TypeError):
            pass
    if not resolved_all:
        return

    try:
        assembly_data.joint_tree(edges, inventory.ids, lambda oid: inventory.get(oid).ref, connected=False)
    except assembly_data.InventoryError as error:
        findings.extend(finding(path, problem) for problem in error.problems)


def check_couplings(assembly: dict[str, Any], path: str, findings: list[dict[str, str]]) -> None:
    """Joint couplings (cad-motion coupling.py) resolve, form a DAG, and keep every derived coordinate inside
    its joint's limits while the independent joints it follows move through their own limits."""
    try:
        couplings = coupling.parse(assembly)
    except coupling.CouplingError as error:
        findings.extend(finding(path, problem) for problem in error.problems)
        return
    if not couplings.laws:
        return
    movable = [joint for joint in assembly["joints"] if joint["type"] in coupling.JOINT_UNITS]
    limits = {joint["id"]: (joint["min"], joint["max"]) for joint in movable}
    nominal = {joint["id"]: joint["nominal"] for joint in movable if "nominal" in joint}
    units = {joint["id"]: coupling.JOINT_UNITS[joint["type"]] for joint in movable}
    findings.extend(finding(path, problem) for problem in couplings.range_problems(limits, nominal, units))


def check_motion_cases(hw: Path, assembly_path: str, findings: list[dict[str, str]]) -> None:
    """Each authored motion case loads against the record's joints as cad-motion motion.py loads it: its
    schema, independent joints inside their limits, and no authored `default`, which is the generated case.
    The check reads the joints and couplings only, so a member left for `--attach` does not stop it.
    Coverage stays a result of the render."""
    cases = layout.resolve(hw, "record.motion_case", ID="default").parent
    names = sorted(entry.name for entry in cases.iterdir() if entry.is_dir()) if cases.is_dir() else []
    if not names:
        return
    pose = _load_module("cad_motion_pose", MOTION_SCRIPTS / "pose.py")
    plan = _load_module("cad_motion_plan", MOTION_SCRIPTS / "plan.py")
    try:
        joints = pose.load_assembly(hw)
    except pose.MotionError as error:
        if not any(item["path"] == assembly_path for item in blocking(findings)):  # else those findings explain it
            findings.extend(finding(str(cases / name), f"motion case {name} cannot be checked against the "
                                                       f"record's joints: {error}") for name in names)
        return
    for name in names:
        if name == plan.DEFAULT_CASE:  # plan.load would generate it from a full chain rather than read a file
            findings.append(finding(str(cases / name), "case `default` is reserved for the generated plan; "
                                                       "rename the authored case"))
            continue
        try:
            plan.load(joints, hw, layout, name)
        except plan.PlanError as error:
            findings.extend(finding(str(cases / name), problem) for problem in error.problems)


def check_manufacture(part: dict[str, Any], path: str, hw: Path, findings: list[dict[str, str]]) -> None:
    """part.yaml `manufacture` belongs to a custom-made part only, and its approving decision exists."""
    manufacture = part.get("manufacture")
    if manufacture is None:
        return
    if not layout.custom_made(part):
        findings.append(finding(path, "manufacture: only a custom-made part (make_buy: make, or procurement/mode: "
                                      "made_to_drawing) has a manufacturing state"))
    decision = manufacture.get("decision")
    if decision is not None and not (hw / "decisions" / f"{decision}.md").is_file():
        findings.append(finding(path, f"manufacture/decision {decision} does not exist at decisions/{decision}.md"))


def check_flow(product: dict[str, Any], path: str, hw: Path, part_records: dict[str, Any],
               findings: list[dict[str, str]]) -> None:
    """The frozen anchor names a built version by its exact manifest, and an open change starts from it."""
    flow = product["flow"]
    frozen, change = flow.get("frozen"), flow.get("change")
    for where, item in (("frozen", frozen), ("change", change)):
        if item is not None and not (hw / "decisions" / f"{item['decision']}.md").is_file():
            findings.append(finding(path, f"flow/{where}/decision {item['decision']} does not exist at "
                                          f"decisions/{item['decision']}.md"))
    if frozen is not None:
        manifest = layout.version_dir(hw, frozen["version"]) / "manifest.json"
        if not manifest.is_file():
            findings.append(finding(path, f"flow/frozen/version {frozen['version']} is not a built version"))
        elif hashlib.sha256(manifest.read_bytes()).hexdigest() != frozen["manifest_sha256"]:
            findings.append(finding(path, f"flow/frozen/manifest_sha256 is not the sha256 of "
                                          f"versions/{frozen['version']}/manifest.json"))
    if change is not None:
        if frozen is not None and change["baseline_version"] != frozen["version"]:
            findings.append(finding(path, f"flow/change/baseline_version {change['baseline_version']} is not the "
                                          f"frozen version {frozen['version']}"))
        for pn in change["affected_parts"]:
            if pn not in part_records:
                findings.append(finding(path, f"flow/change/affected_parts: {pn} has no parts/{pn}/part.yaml"))


@functools.cache
def stages() -> tuple[str, ...]:
    """The workflow stages in order, as product.schema.json defines them."""
    schema = json.loads((SCHEMAS / "product.schema.json").read_text(encoding="utf-8"))
    return tuple(schema["$defs"]["stage"]["enum"])


def layout_strict(product: Any, hw: Path) -> bool:
    """Whether stage-graded layout findings are errors: from design_freeze on, at every stage once a
    frozen anchor (flow.frozen, or a release manifest) exists, and when the stage is missing or unknown."""
    flow = product.get("flow") if isinstance(product, dict) else None
    flow = flow if isinstance(flow, dict) else {}
    if flow.get("frozen") is not None or any((hw / "releases").glob("*/manifest.json")):
        return True
    stage = flow.get("stage")
    return stage not in stages() or stages().index(stage) >= stages().index("design_freeze")


def check_layout(hw: Path, product: Any, part_records: dict[str, Any], findings: list[dict[str, str]]) -> None:
    """Every file and directory under hw/, tracked, untracked or ignored, against cad-record layout.json."""
    references = {}
    for pn, (part, _) in part_records.items():
        artifact = ((part.get("procurement") or {}).get("specification") or {}).get("artifact")
        if isinstance(artifact, str):
            references[posixpath.normpath(f"{layout.HW}/{artifact}")] = pn
    strict = layout_strict(product, hw)
    report = layout.audit(hw, references)
    for problem in report.problems:
        severity = problem.severity if problem.severity != "stage" else "error" if strict else "warning"
        findings.append(finding(str(layout.locate(hw, problem.path)), problem.message, severity=severity,
                                code=problem.code, canonical_location=problem.canonical_location,
                                action=problem.action))
    for manifest in report.bundles:
        path = layout.locate(hw, manifest)
        validate_document(load_json(path, findings), "bundle-manifest.schema.json", str(path), findings)


def bom_totals(bom: list[dict[str, str]], levels: list[int | None]) -> dict[str, int]:
    """Assembled quantity per PN: each row's qty times the qty of every parent row above it."""
    totals: dict[str, int] = {}
    parents: list[tuple[int, int]] = []  # (level, cumulative quantity)
    for row, level in zip(bom, levels):
        try:
            qty = int(row["qty"])
        except (TypeError, ValueError, KeyError):
            continue
        if level is None:
            continue
        while parents and parents[-1][0] >= level:
            parents.pop()
        quantity = qty * (parents[-1][1] if parents else 1)
        totals[row.get("PN", "")] = totals.get(row.get("PN", ""), 0) + quantity
        parents.append((level, quantity))
    return totals


def check_release_readiness(hw: Path, verification: list[dict[str, str]],
                            part_records: Mapping[str, tuple[dict[str, Any], str]], path: str,
                            findings: list[dict[str, str]]) -> None:
    """What every release needs from the record: a verification.csv whose rows all pass or are
    waived, and no prototype (X) part revision."""
    verification_path = hw / "verification.csv"
    if not verification_path.is_file():
        findings.append(finding(path, "release requires a verification.csv"))
    else:
        for index, row in enumerate(verification, start=2):
            if row.get("result") not in {"pass", "waived"}:
                findings.append(finding(f"{verification_path}:{index}", "release verification result must be pass or waived"))
    for pn, (part, part_path) in part_records.items():
        if isinstance(part.get("rev"), str) and part["rev"].startswith("X"):
            findings.append(finding(part_path, f"release cannot include prototype revision {part['rev']} for {pn}"))


def validate_project(project_dir: Path) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    hw = project_dir / "hw" if (project_dir / "hw").is_dir() else project_dir
    required_yaml = {
        "product.yaml": "product.schema.json",
        "requirements.yaml": "requirements.schema.json",
        "interfaces.yaml": "interfaces.schema.json",
        "assembly.yaml": "assembly.schema.json",
    }
    documents: dict[str, Any] = {}
    valid: dict[str, bool] = {}
    for filename, schema in required_yaml.items():
        path = hw / filename
        if not path.is_file():
            findings.append(finding(str(path), "required record file is missing"))
            continue
        data = load_yaml(path, findings)
        documents[filename] = data
        valid[filename] = validate_document(data, schema, str(path), findings)
    product_drawing = None
    if valid.get("product.yaml"):
        check_product_drawing(documents["product.yaml"], str(hw / "product.yaml"), findings)
        product_drawing = documents["product.yaml"].get("drawing")
    concept_handoff = hw / "concept" / "handoff.json"
    if concept_handoff.is_file():
        concept_schema = Path(__file__).resolve().parents[2] / "cad-concept" / "assets" / "schemas" / "handoff.schema.json"
        if concept_schema.is_file():
            schema = load_json(concept_schema, findings)
            handoff = load_json(concept_handoff, findings)
            if schema is not None and handoff is not None:
                errors = sorted(
                    Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(handoff),
                    key=lambda error: list(error.absolute_path),
                )
                for error in errors:
                    location = "/".join(str(part) for part in error.absolute_path)
                    findings.append(finding(str(concept_handoff), f"{location + ': ' if location else ''}{error.message}"))
        else:
            findings.append(finding(str(concept_handoff), f"skipped handoff schema validation; schema not found at {concept_schema}", severity="info"))
    part_records: dict[str, tuple[dict[str, Any], str]] = {}
    parts_dir = hw / "parts"
    if not parts_dir.is_dir():
        findings.append(finding(str(parts_dir), "parts directory is missing"))
    else:
        for part_path in sorted(parts_dir.glob("*/part.yaml")):
            part = load_yaml(part_path, findings)
            if not validate_document(part, "part.schema.json", str(part_path), findings):
                continue
            if not isinstance(part, dict):
                continue
            pn = part["PN"]
            if part_path.parent.name != pn:
                findings.append(finding(str(part_path), f"directory name does not match PN {pn}"))
            if pn in part_records:
                findings.append(finding(str(part_path), f"duplicate part number {pn}"))
            for decision in part.get("decisions", []):
                decision_path = hw / "decisions" / f"{decision}.md"
                if not decision_path.is_file():
                    findings.append(finding(str(part_path), f"decision {decision} does not exist at decisions/{decision}.md"))
            check_part_drawing(part, str(part_path), product_drawing, findings)
            check_procurement(part, str(part_path), hw, findings)
            check_manufacture(part, str(part_path), hw, findings)
            part_records[pn] = (part, str(part_path))
        if not part_records:
            product = documents.get("product.yaml")
            flow = product.get("flow") if isinstance(product, dict) else None
            stage = flow.get("stage") if isinstance(flow, dict) else None
            if stage not in stages() or stages().index(stage) >= stages().index("layout"):
                findings.append(finding(str(parts_dir), "no part records found"))
    assembly_path = str(hw / "assembly.yaml")
    inventory = (assembly_inventory(documents["assembly.yaml"], assembly_path, part_records, findings)
                 if valid.get("assembly.yaml") else None)
    if valid.get("interfaces.yaml"):
        check_interfaces(documents["interfaces.yaml"], str(hw / "interfaces.yaml"), part_records, inventory, findings)

    bom = read_csv(hw / "bom.csv", CSV_COLUMNS["bom.csv"], findings)
    bom_levels: list[int | None] = []
    for index, row in enumerate(bom, start=2):
        row_path = f"{hw / 'bom.csv'}:{index}"
        normalized: dict[str, Any] = dict(row)
        for number in ("level", "qty"):
            try:
                normalized[number] = int(row[number])
            except (TypeError, ValueError):
                findings.append(finding(row_path, f"{number} must be an integer"))
                if number == "level":
                    normalized[number] = None
        bom_levels.append(normalized.get("level"))
        if row.get("mass", "") == "":
            normalized["mass"] = None
        else:
            try:
                normalized["mass"] = float(row["mass"])
            except (TypeError, ValueError):
                findings.append(finding(row_path, "mass must be a positive number or blank"))
        for field in ("rev", "title", "material", "process", "make_buy", "supplier"):
            normalized[field] = row.get(field) or None
        for field in BOM_PROCUREMENT_COLUMNS:
            if field in row:
                normalized[field] = row[field] or None
        validate_document(normalized, "bom-row.schema.json", row_path, findings)

    for position, row in enumerate(bom):
        index = position + 2
        row_path = f"{hw / 'bom.csv'}:{index}"
        level = bom_levels[position]
        has_children = level == 0 or (
            level is not None
            and position + 1 < len(bom_levels)
            and bom_levels[position + 1] is not None
            and bom_levels[position + 1] > level
        )
        pn = row.get("PN", "")
        if pn not in part_records:
            if not has_children:
                findings.append(finding(row_path, f"BOM PN {pn!r} has no matching parts/<PN>/part.yaml and is not an assembly"))
            continue
        part, part_path = part_records[pn]
        for field, part_field in (("rev", "rev"), ("title", "title"), ("material", "material"),
                                  ("process", "process"), ("make_buy", "make_buy"),
                                  ("supplier", "supplier")):
            bom_value = row.get(field) or None
            part_value = part.get(part_field)
            if bom_value != part_value:
                findings.append(finding(row_path, f"{field} {bom_value!r} does not match {part_path} ({part_value!r})"))
        try:
            mass = float(row["mass"]) if row.get("mass") else None
        except ValueError:
            mass = None
        if mass != part.get("mass_target"):
            findings.append(finding(row_path, f"mass {mass!r} does not match {part_path} mass_target ({part.get('mass_target')!r})"))
        if "unit" in row:
            for field, part_value in procurement_cells(part).items():
                bom_value = row.get(field) or None
                if bom_value != part_value:
                    findings.append(finding(row_path, f"{field} {bom_value!r} does not match {part_path} ({part_value!r})"))

    previous_level: int | None = None
    for index, level in enumerate(bom_levels, start=2):
        if level is None:
            continue
        if (previous_level is None and level not in (0, 1)) or (
            previous_level is not None and level > previous_level + 1
        ):
            findings.append(finding(f"{hw / 'bom.csv'}:{index}", "level must start at 0 or 1 and cannot skip a parent depth"))
        previous_level = level

    if inventory is not None:
        check_joints(documents["assembly.yaml"], inventory, assembly_path, part_records, findings)
        check_couplings(documents["assembly.yaml"], assembly_path, findings)
        check_motion_cases(hw, assembly_path, findings)
        totals = bom_totals(bom, bom_levels)
        for pn, count in inventory.quantities().items():
            placed = inventory.of(pn)
            if placed[0].explicit and pn in totals and totals[pn] != count:
                findings.append(finding(str(hw / "bom.csv"), f"BOM quantity of {pn} is {totals[pn]}, but assembly.yaml "
                                        f"places it {count} times ({', '.join(o.ref for o in placed)})"))

    requirements = documents.get("requirements.yaml")
    verification = read_csv(hw / "verification.csv", CSV_COLUMNS["verification.csv"], findings)
    seen_requirement_ids: set[str] = set()
    for index, row in enumerate(verification, start=2):
        row_path = f"{hw / 'verification.csv'}:{index}"
        validate_document(row, "verification-row.schema.json", row_path, findings)
        req_id = row.get("requirement_id", "")
        if req_id in seen_requirement_ids:
            findings.append(finding(row_path, f"duplicate verification for {req_id}"))
        seen_requirement_ids.add(req_id)
    if isinstance(requirements, dict):
        known = {item.get("id") for item in requirements.get("requirements", []) if isinstance(item, dict)}
        for req_id in sorted(known - seen_requirement_ids):
            findings.append(finding(str(hw / "verification.csv"), f"requirement {req_id} has no verification row"))
        for req_id in sorted(seen_requirement_ids - known):
            findings.append(finding(str(hw / "verification.csv"), f"unknown requirement {req_id}"))

    manifest_dir = hw / "releases"
    manifests = sorted(manifest_dir.glob("*/manifest.json")) if manifest_dir.is_dir() else []
    if manifests:
        product = documents.get("product.yaml")
        for path in manifests:
            manifest = load_json(path, findings)
            valid_manifest = validate_document(manifest, "release-manifest.schema.json", str(path), findings)
            if not valid_manifest or not isinstance(manifest, dict):
                continue
            if isinstance(product, dict) and manifest.get("product_id") != product.get("id"):
                findings.append(finding(str(path), "manifest product_id does not match product.yaml id"))
            if path.parent.name != manifest.get("rev"):
                findings.append(finding(str(path), "release directory name does not match manifest rev"))
            project_root = hw.parent if hw == project_dir else project_dir
            root = project_root.resolve()
            # version 1 lists project files in place. Version 2 holds byte copies, which check_layout audits
            # against the package inventory; their originals may change or go after release.
            in_place = manifest["files"] if "schema_version" not in manifest else []
            for file_name in in_place:
                candidate = root / file_name
                try:
                    candidate.resolve().relative_to(root)
                    exists = candidate.is_file()
                except (OSError, ValueError):
                    exists = False
                if not exists:
                    findings.append(finding(str(path), f"release file does not exist within project: {file_name}"))
            check_release_readiness(hw, verification, part_records, str(path), findings)
    if valid.get("product.yaml"):
        check_flow(documents["product.yaml"], str(hw / "product.yaml"), hw, part_records, findings)
    check_layout(hw, documents.get("product.yaml"), part_records, findings)
    return findings


# --- migration plan: a read-only move and rebuild report ------------------------------------------------------------

REMOVE_CODES = frozenset({"layout.transient", "layout.metadata", "layout.empty_directory"})


def sealed_owner(rel: str) -> tuple[Any, dict[str, str]] | None:
    """The sealed layout directory that project-relative `rel` names or lies in: (entry, token values)."""
    path = rel
    while path and path != layout.HW:
        found = layout.load().sealed(path)
        if found is not None:
            return found
        path = posixpath.dirname(path)
    return None


def destination_owner(destination: str) -> Any:
    """The layout entry a canonical destination belongs to: the entry it classifies as, else the entry
    with the longest literal path prefix, for a destination that keeps a placeholder (hw/drawings/<V>/...)."""
    lay = layout.load()
    for candidate in (destination.rstrip("/"), f"{destination.rstrip('/')}/{layout.MANIFEST}"):
        found = lay.classify(candidate)
        if found is not None:
            return found.entry
    prefixes = [(len(entry.path.split("{", 1)[0]), entry) for entry in lay.entries
                if destination.startswith(entry.path.split("{", 1)[0])]
    return max(prefixes, key=lambda item: item[0])[1] if prefixes else None


def plan_item(hw: Path, item: Mapping[str, Any], records: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
    """One layout finding as a plan step: what the path is, where it belongs, what must run to put it
    there, and how sure the layout is of that destination."""
    lay = layout.load()
    rel = layout.relative(hw, item["path"])
    code = item["code"]
    destination = item.get("canonical_location")
    classification = lay.stray_class(rel).name if code == "layout.stray" else code.split(".", 1)[1]
    owner = destination_owner(destination) if destination else None
    sealing = sealed_owner(rel) if owner is None else None
    writer = owner if owner is not None else sealing[0] if sealing is not None else None
    rebuild = writer.writer if writer is not None and writer.kind == "generated" else None
    if code in REMOVE_CODES:
        operation, rebuild = "remove", None
    elif destination is None:
        operation = "review"
    else:
        operation = "rebuild" if rebuild else "move"
    if operation == "remove" or (operation == "move" and classification != "data" and "<" not in destination):
        confidence = "high"  # a determined place the bytes move to unchanged, or a leftover to delete
    elif operation == "rebuild":
        # a rebuild lands it; geometry needs the PN it names to be a custom-made part record
        found = re.search(lay.tokens["PN"]["pattern"], destination)
        known = found is not None and found.group(0) in records and layout.custom_made(records[found.group(0)])
        confidence = "low" if classification == "geometry" and not known else "medium"
    else:
        confidence = "low"
    return {"path": rel, "code": code, "severity": item["severity"], "classification": classification,
            "operation": operation, "destination": destination, "rebuild": rebuild, "confidence": confidence,
            "action": item.get("action")}


def legacy_items(hw: Path) -> list[dict[str, Any]]:
    """Built versions without complete manufacturing outputs and version 1 releases: kept as they are,
    readable, but never frozen, released or reissued."""
    lay, items = layout.load(), []
    next_label = layout.next_version(hw)
    for label in layout.versions(hw):
        manifest = load_json(layout.version_dir(hw, label) / layout.MANIFEST, [])
        made = manifest.get("manufacturing") if isinstance(manifest, dict) else None
        if isinstance(made, dict) and all(isinstance(e, dict) and e.get("complete") is True for e in made.values()):
            continue
        items.append({"path": f"{layout.HW}/versions/{label}", "code": None, "severity": "info",
                      "classification": "legacy version", "operation": "keep", "destination": None,
                      "rebuild": lay.entry("version.core").writer, "confidence": "high",
                      "action": f"{label} stays readable as built, but its manufacturing outputs are missing or "
                                f"incomplete, so it cannot be frozen or released. Build {next_label} with cad-model "
                                "run to freeze. Nothing was changed."})
    for path in sorted((hw / "releases").glob(f"*/{layout.MANIFEST}")):
        manifest = load_json(path, [])
        if isinstance(manifest, dict) and "schema_version" not in manifest:
            items.append({"path": layout.relative(hw, path.parent), "code": None, "severity": "info",
                          "classification": "legacy release", "operation": "keep", "destination": None,
                          "rebuild": lay.entry("release.package").writer, "confidence": "high",
                          "action": f"Release {path.parent.name} lists project files in place (manifest version 1). "
                                    "Keep it for inspection and recovery; it is never reissued. Issue the next "
                                    "revision with release.py from a frozen version. Nothing was changed."})
    return items


def migration_plan(project_dir: Path) -> dict[str, Any]:
    """Every layout finding of the record, plus legacy versions and releases, as a move and rebuild
    plan. Reads only; nothing is moved, deleted or rebuilt."""
    hw = project_dir / "hw" if (project_dir / "hw").is_dir() else project_dir
    records = {}
    for path in sorted((hw / "parts").glob("*/part.yaml")):
        data = load_yaml(path, [])
        if isinstance(data, dict):
            records[path.parent.name] = data
    items = [plan_item(hw, item, records) for item in validate_project(project_dir) if "code" in item]
    items += legacy_items(hw)
    targets: dict[str, list[str]] = {}
    for item in items:
        if item["destination"] and "<" not in item["destination"]:
            targets.setdefault(item["destination"], []).append(item["path"])
    for item in items:
        destination = item["destination"]
        determined = bool(destination) and "<" not in destination
        item["collisions"] = [p for p in targets.get(destination, []) if p != item["path"]] if determined else []
        item["destination_exists"] = os.path.lexists(layout.locate(hw, destination.rstrip("/"))) if determined else None
    counts: dict[str, int] = {}
    for item in items:
        counts[item["operation"]] = counts.get(item["operation"], 0) + 1
    return {"plan": "migration", "next_version": layout.next_version(hw), "changed": False,
            "counts": dict(sorted(counts.items())), "items": items}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path, help="project directory containing hw/ or the hw/ directory itself")
    parser.add_argument("--migration-plan", action="store_true",
                        help="print a read-only move and rebuild plan for every stray, legacy or damaged path")
    parser.add_argument("--report", type=Path, help="with --migration-plan: write the plan here, under .cad-work/")
    args = parser.parse_args()
    if args.report is not None and not args.migration_plan:
        parser.error("--report needs --migration-plan")
    if not args.project_dir.exists() or not args.project_dir.is_dir():
        print(json.dumps({"ok": False, "findings": [finding(str(args.project_dir), "project directory does not exist")]}))
        return 2
    if args.migration_plan:
        hw = (args.project_dir / "hw" if (args.project_dir / "hw").is_dir() else args.project_dir).resolve()
        target = None
        if args.report is not None:
            try:
                target = layout.scratch_path(hw, args.report, "--report")
            except layout.LayoutError as error:
                print(json.dumps({"ok": False, "findings": [finding(str(args.report), str(error))]}))
                return 2
        text = json.dumps(migration_plan(args.project_dir), indent=2)
        if target is None:
            print(text)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text + "\n", encoding="utf-8")
            print(json.dumps({"report": layout.relative(hw, target)}))
        return 0
    findings = validate_project(args.project_dir)
    failures = blocking(findings)
    print(json.dumps({"ok": not failures, "findings": findings}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "findings": [finding("validate.py", f"infrastructure error: {error}")]}))
        raise SystemExit(2)
