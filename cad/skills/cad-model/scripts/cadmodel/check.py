"""`check`: blocking and advisory geometry checks over one built version.

Definition checks (STEP read-back volume, BRep validity, solid structure, slivers) run once per PN;
assembly checks run per occurrence: every component of assembly.step must be an occurrence of the
manifest at its recorded placement, interference covers every occurrence pair (two occurrences of
one PN included), connectivity welds occurrences, and each occurrence's GLB node is judged
watertight alone. A version 1 version (written before occurrences) reads as one occurrence per PN.
"""

from __future__ import annotations

import importlib.util
import itertools
import re
import sys
import time
from functools import cache
from pathlib import Path
from typing import Any, Iterable, Mapping

from cadmodel import build, mesh, occ
from cadmodel.motion import load_pair_policy, load_pose

VERSIONS_SCRIPT = Path(__file__).resolve().parents[3] / "cad-render" / "scripts" / "versions.py"

AP242 = "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING"
READBACK_REL = 1e-6          # STEP read-back volume vs the kernel's in-memory volume
PLACEMENT_MM = 1e-6          # assembly.step component location vs the manifest placement
CONTACT_MM = 0.01            # distance at or below which two parts touch
FLOAT_GAP_MM = 2.0           # beyond this a part is disconnected rather than floating
SLIVER_FACE_MM2 = 1e-3       # faces smaller than this are slivers (advisory)
LOOSE_TOLERANCE_MM = 0.01    # vertex/edge/face tolerance above this is loose (advisory)
SCHEMA_LINE = re.compile(r"FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'")


def _rel(a: float, b: float) -> float:
    return abs(a - b) / max(abs(b), 1e-12)


def _schema(path: Path) -> str | None:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        match = SCHEMA_LINE.search(handle.read(8192))
    return match.group(1) if match else None


def _status(ok: bool, blocking: bool = True) -> str:
    return "pass" if ok else ("fail" if blocking else "warn")


@cache
def _versions() -> Any:
    """cad-render's stdlib version reader: a version's occurrences, version 1 files normalized."""
    spec = importlib.util.spec_from_file_location("cad_render_versions", VERSIONS_SCRIPT)
    if spec is None or spec.loader is None:
        raise build.UsageError(f"cannot load the version reader at {VERSIONS_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def built_inventory(occurrences: Mapping[str, Any]) -> Any:
    """The version's occurrences as an assembly_data.Inventory, for reference resolution."""
    data = load_pose().assembly_data
    return data.Inventory(tuple(data.Occurrence(oid, o.pn, data.IDENTITY, o.ref.startswith("@"))
                                for oid, o in occurrences.items()))


def resolve_pairs(pairs: Iterable[tuple[str, str]], inventory: Any, option: str) -> list[tuple[str, str]]:
    """REF:REF options as sorted occurrence-id pairs."""
    resolved = []
    for a, b in pairs:
        try:
            ids = tuple(sorted((inventory.resolve(a).id, inventory.resolve(b).id)))
        except load_pose().assembly_data.UnresolvedReference as error:
            raise build.UsageError(f"{option} {a}:{b}: {error}") from None
        if ids[0] == ids[1]:
            raise build.UsageError(f"{option} {a}:{b}: both ends are one occurrence")
        resolved.append(ids)
    return resolved  # type: ignore[return-value]


def step_readback(folder: Path, manifest: dict[str, Any], parts: dict[str, Any], step: Any,
                  occurrences: Mapping[str, Any]) -> dict[str, Any]:
    """AP242 schema, names and read-back volumes per PN definition; one assembly definition per PN and
    one component per occurrence, each identified exactly and at its manifest placement."""
    pose = load_pose()
    expected = manifest["parts"]
    files = {"assembly.step": _schema(folder / "assembly.step"),
             **{info["step"]: _schema(folder / info["step"]) for info in expected.values()}}
    text = (folder / "assembly.step").read_text(encoding="utf-8", errors="replace")
    definitions = step.definitions
    rows = {}
    for pn, info in sorted(expected.items()):
        kernel_v = info["kernel_volume_mm3"]
        part_v = occ.volume(parts[pn].shape) if pn in parts else None
        asm_v = occ.volume(definitions[pn].shape) if pn in definitions else None
        rows[pn] = {
            "expected_name": info["product"],
            "part_step_name": parts[pn].name if pn in parts else None,
            "assembly_name": definitions[pn].name if pn in definitions else None,
            "kernel_volume_mm3": kernel_v,
            "part_step_volume_mm3": part_v,
            "assembly_volume_mm3": asm_v,
            "part_step_rel_error": _rel(part_v, kernel_v) if part_v is not None else None,
            "assembly_rel_error": _rel(asm_v, kernel_v) if asm_v is not None else None,
            "kernel_solids": info["kernel_solids"],
            "part_step_solids": occ.count(parts[pn].shape, "SOLID") if pn in parts else None,
        }
        row = rows[pn]
        row["ok"] = (row["part_step_name"] == row["assembly_name"] == info["product"]
                     and row["part_step_rel_error"] is not None and row["part_step_rel_error"] <= READBACK_REL
                     and row["assembly_rel_error"] is not None and row["assembly_rel_error"] <= READBACK_REL
                     and row["part_step_solids"] == row["kernel_solids"])
    placed_rows: dict[str, Any] = {}
    unbound: list[str] = []
    for component in step.components:
        oid = component.occurrence if component.occurrence is not None else component.pn
        built = occurrences.get(oid)
        if built is None or built.pn != component.pn or oid in placed_rows:
            unbound.append(component.name)
            continue
        target = pose.Rigid(tuple(tuple(r[:3]) for r in built.transform), tuple(r[3] for r in built.transform))
        error_mm = max(abs(a - b) for a, b in zip(component.location.trans, target.trans))
        error_rot = max(abs(a - b) for ra, rb in zip(component.location.rot, target.rot) for a, b in zip(ra, rb))
        placed_rows[oid] = {"ref": built.ref, "PN": built.pn, "component": component.name,
                            "placement_error_mm": error_mm, "rotation_error": error_rot,
                            "ok": error_mm <= PLACEMENT_MM and error_rot <= pose.PLACEMENT_TOL_ROT}
    missing = sorted(o.ref for oid, o in occurrences.items() if oid not in placed_rows)
    extra = sorted(set(definitions) - set(expected))
    top_ok = f"PRODUCT('{manifest['top_product']}'" in text
    schema_ok = all(s is not None and s.startswith(AP242) for s in files.values())
    ok = (schema_ok and all(r["ok"] for r in rows.values()) and not extra and top_ok and not unbound and not missing
          and all(r["ok"] for r in placed_rows.values()))
    return {"status": _status(ok), "blocking": True, "schema": files, "top_product": manifest["top_product"],
            "top_product_found": top_ok, "unexpected_products": extra, "definitions": len(definitions),
            "components": len(step.components), "unbound_components": unbound, "missing_occurrences": missing,
            "tolerance_rel": READBACK_REL, "placement_tolerance_mm": PLACEMENT_MM, "parts": rows,
            "occurrences": placed_rows}


def brep_validity(parts: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    """BRepCheck on the kernel's in-memory shape (from the runner) and on the STEP read-back.

    Both count: the STEP round trip can turn an invalid open-shell solid into a valid shell.
    """
    rows = {}
    for pn, part in sorted(parts.items()):
        built = manifest["parts"][pn]
        step_errors = occ.check_statuses(part.shape)
        rows[pn] = {"valid": built["kernel_valid"] and not step_errors, "kernel_valid": built["kernel_valid"],
                    "kernel_errors": built["kernel_errors"], "step_valid": not step_errors, "step_errors": step_errors}
    return {"status": _status(all(r["valid"] for r in rows.values())), "blocking": True, "parts": rows}


def solid_structure(parts: dict[str, Any], expected: dict[str, int], baseline: dict[str, Any] | None,
                    baseline_label: str | None) -> dict[str, Any]:
    unknown = sorted(set(expected) - set(parts))
    rows = {}
    for pn, part in sorted(parts.items()):
        solids, shells = occ.count(part.shape, "SOLID"), occ.count(part.shape, "SHELL")
        if pn in expected:
            want, source = expected[pn], "expected"
        elif baseline is not None and pn in baseline:
            want, source = baseline[pn]["solids"], baseline_label
        else:
            want, source = None, None
        rows[pn] = {"solids": solids, "shells": shells, "expected_solids": want, "baseline": source,
                    "ok": solids > 0 and (want is None or solids == want)}
    return {"status": _status(all(r["ok"] for r in rows.values()) and not unknown), "blocking": True,
            "unknown_parts": unknown, "parts": rows}


def pair_geometry(placed: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    """Clearance and shared volume of every occurrence pair at the built pose; `error` when OCP fails.

    `placed` maps an occurrence id to its placed shape; two occurrences of one PN are a pair like
    any other. The measurement is cad-motion's `pose.interference`, the rule `sweep.py` applies to
    every pose.
    """
    pose = load_pose()
    found: dict[tuple[str, str], dict[str, Any]] = {}
    for a, b in itertools.combinations(sorted(placed), 2):
        try:
            gap, shared = pose.interference(placed[a], placed[b])
        except Exception as error:  # noqa: BLE001 - OCP raises Standard_Failure on broken input
            found[(a, b)] = {"clearance_mm": None, "interference_mm3": None, "error": str(error) or type(error).__name__}
            continue
        found[(a, b)] = {"clearance_mm": gap, "interference_mm3": shared}
    return found


class _Unrecorded:
    """Reference resolution without an assembly record: a PN names its singleton; no @id exists."""

    @staticmethod
    def attachable(ref: str, where: str = "") -> str:
        if ref.startswith("@"):
            raise build.UsageError(f"{where}{ref}: no assembly record to resolve an occurrence reference")
        return ref

    @staticmethod
    def pn(occurrence_id: str) -> str:
        return occurrence_id


def declared_press_fits(hw: Path, assembly: Any = None) -> list[dict[str, Any]]:
    """cad-motion pair_policy's press fits, `pair` as sorted occurrence ids, classified with cad-fits."""
    policy = load_pair_policy()
    try:
        return policy.declared_press_fits(hw, policy.read_interfaces(hw), assembly or _Unrecorded())
    except policy.PolicyError as error:
        raise build.UsageError(str(error)) from error


def declared_heat_sets(hw: Path, assembly: Any = None) -> list[dict[str, Any]]:
    """cad-motion pair_policy's heat-set inserts, `pair` as sorted occurrence ids."""
    policy = load_pair_policy()
    try:
        return policy.declared_heat_sets(hw, policy.read_interfaces(hw), assembly or _Unrecorded())
    except policy.PolicyError as error:
        raise build.UsageError(str(error)) from error


def interference(geometry: dict[tuple[str, str], dict[str, Any]], named: list[tuple[str, str]] | None,
                 joint_pairs: set[tuple[str, str]], allowed: set[tuple[str, str]],
                 declared: Iterable[dict[str, Any]] = (), heat_sets: Iterable[dict[str, Any]] = (),
                 refs: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Only a classified declared interference fit or a declared heat-set insert on exactly that
    occurrence pair excuses overlap. `refs` maps an occurrence id to its copyable reference."""
    threshold = load_pose().INTERFERENCE_MM3
    refs = refs or {}
    declarations = sorted(declared, key=lambda item: (item["pair"], item["source"]))
    inserts = sorted(heat_sets, key=lambda item: (item["pair"], item["source"]))
    declared_allowed = {tuple(item["pair"]) for item in declarations if item["classification"] == "interference"}
    effective_allowed = allowed | declared_allowed | {tuple(item["pair"]) for item in inserts}
    pairs = sorted(set(geometry) if named is None else {tuple(sorted(p)) for p in named})
    selected = set(pairs)
    unknown = [list(p) for p in pairs if p not in geometry]
    unknown_allowed = [list(p) for p in sorted(effective_allowed) if p not in geometry]
    rows: dict[str, list[dict[str, Any]]] = {"pairs": [], "joint_pairs": []}
    for pair in pairs:
        if pair not in geometry:
            continue
        g = geometry[pair]
        measured = g["interference_mm3"] is not None
        hit = not measured or g["interference_mm3"] > threshold
        entry = {"pair": list(pair), "refs": [refs.get(p, p) for p in pair], **g, "interferes": hit,
                 "allowed": pair in effective_allowed, "ok": not hit or (measured and pair in effective_allowed)}
        rows["joint_pairs" if pair in joint_pairs else "pairs"].append(entry)
    declared_fit_findings = []
    for item in declarations:
        pair = tuple(item["pair"])
        if item["classification"] != "interference" or pair not in selected:
            continue
        measurement = geometry.get(pair)
        if measurement is not None and measurement["interference_mm3"] is not None \
                and measurement["interference_mm3"] <= threshold:
            declared_fit_findings.append({**item, "type": "declared_fit_not_realized", **measurement,
                                          "threshold_mm3": threshold})
    every = rows["pairs"] + rows["joint_pairs"]
    measured_rows = [e for e in every if e["clearance_mm"] is not None]
    smallest = min(measured_rows, key=lambda e: e["clearance_mm"], default=None)
    ok = all(e["ok"] for e in every) and not unknown and not unknown_allowed and not declared_fit_findings
    return {"status": _status(ok), "blocking": True, "selection": "all" if named is None else "named",
            "threshold_mm3": threshold, "unknown_pairs": unknown, "unknown_allowed": unknown_allowed,
            "declared_pairs": declarations, "declared_heat_sets": inserts, "declared_fit_findings": declared_fit_findings,
            "min_clearance": {"pair": smallest["pair"], "clearance_mm": smallest["clearance_mm"]} if smallest else None,
            **rows}


def rigid_bodies(ids: Iterable[str], joints: Iterable[dict[str, Any]]) -> dict[str, str]:
    """Each occurrence's rigid body, named by its smallest id: a fixed joint (or --attach) welds its two occurrences."""
    parent = {oid: oid for oid in ids}

    def root(oid: str) -> str:
        while parent.setdefault(oid, oid) != oid:
            oid = parent[oid]
        return oid

    for joint in joints:
        if joint["type"] == "fixed":
            low, high = sorted(root(oid) for oid in joint["pair"])
            parent[high] = low
    return {oid: root(oid) for oid in list(parent)}


def connection(geometry: dict[tuple[str, str], dict[str, Any]], ids: Iterable[str],
               joints: list[dict[str, Any]]) -> dict[str, Any]:
    """Whether each occurrence is held: fixed pairs touch, and each occurrence touches or floats across a movable joint.

    Occurrences welded by fixed joints or --attach form one rigid body: the two occurrences of every
    fixed joint must touch, and a gap within a body is never a joint clearance. A float (CONTACT_MM
    to FLOAT_GAP_MM) passes only when a movable joint links the occurrence's body to the nearest
    occurrence's body.
    """
    ids = sorted(ids)
    body = rigid_bodies(ids, joints)
    links = {frozenset((body[j["pair"][0]], body[j["pair"][1]])): j["joint"] for j in joints if j["type"] != "fixed"}
    rows = {}
    for oid in ids:
        near = [(g["clearance_mm"], b if a == oid else a) for (a, b), g in geometry.items()
                if oid in (a, b) and g["clearance_mm"] is not None]
        if not near:
            rows[oid] = {"status": "alone", "nearest": None, "distance_mm": None, "ok": len(geometry) == 0}
            continue
        dist, other = min(near)
        status = "touching" if dist <= CONTACT_MM else ("floating" if dist <= FLOAT_GAP_MM else "disconnected")
        joint = links.get(frozenset((body[oid], body[other])))
        ok = status == "touching" or (status == "floating" and joint is not None)
        rows[oid] = {"status": status, "nearest": other, "distance_mm": dist, "joint_connected": joint is not None,
                     "joint": joint, "ok": ok}
    fixed = []
    for j in joints:
        if j["type"] == "fixed":
            gap = geometry.get(tuple(j["pair"]), {}).get("clearance_mm")
            fixed.append({"joint": j["joint"], "pair": j["pair"], "distance_mm": gap,
                          "ok": gap is not None and gap <= CONTACT_MM})
    ok = all(r["ok"] for r in rows.values()) and all(f["ok"] for f in fixed)
    return {"status": _status(ok), "blocking": True, "contact_mm": CONTACT_MM, "float_gap_mm": FLOAT_GAP_MM,
            "parts": rows, "fixed_joints": fixed}


def slivers_and_tolerances(parts: dict[str, Any]) -> dict[str, Any]:
    rows = {}
    for pn, part in sorted(parts.items()):
        areas = occ.face_areas(part.shape)
        tol = occ.max_tolerance(part.shape)
        slivers = sum(1 for a in areas if a < SLIVER_FACE_MM2)
        rows[pn] = {"min_face_area_mm2": min(areas, default=0.0), "sliver_faces": slivers, "max_tolerance_mm": tol,
                    "loose": tol > LOOSE_TOLERANCE_MM, "ok": slivers == 0 and tol <= LOOSE_TOLERANCE_MM}
    return {"status": _status(all(r["ok"] for r in rows.values()), blocking=False), "blocking": False,
            "sliver_face_mm2": SLIVER_FACE_MM2, "loose_tolerance_mm": LOOSE_TOLERANCE_MM, "parts": rows}


def mesh_watertight(folder: Path, part_map: Mapping[str, Any], ids: Iterable[str]) -> dict[str, Any]:
    """Per occurrence: its GLB node's mesh is a closed 2-manifold, never welded to another instance."""
    names = mesh.node_names(part_map)
    rows = mesh.watertight(folder / "assembly.glb", {oid: names.get(oid, "") for oid in ids})
    return {"status": _status(all(r["watertight"] for r in rows.values())), "blocking": True, "parts": rows}


def check(hw: Path, label: str, named: list[tuple[str, str]] | None, allowed: Iterable[tuple[str, str]],
          expected_solids: dict[str, int]) -> tuple[int, dict[str, Any]]:
    """`named` and `allowed` pairs are references (`@id`, or a PN placed once) into the built version."""
    pose = load_pose()
    versions = _versions()
    started = time.perf_counter()
    hw = hw.resolve()
    folder = build.version_dir(hw, label)
    manifest = build.read_json(folder / "manifest.json")
    part_map = build.read_json(folder / "part-map.json")
    try:
        occurrences = versions.built_occurrences(part_map, manifest)
    except versions.VersionError as error:
        raise build.UsageError(f"{folder}: {error}") from error
    inventory = built_inventory(occurrences)
    refs = {oid: o.ref for oid, o in occurrences.items()}
    named_pairs = resolve_pairs(named, inventory, "--pair") if named is not None else None
    allowed_pairs = set(resolve_pairs(allowed, inventory, "--allow-interference"))
    parts = pose.load_definitions(hw, folder / "parts")
    step = pose.read_assembly_step(folder / "assembly.step")
    placed = {}
    for component in step.components:
        oid = component.occurrence if component.occurrence is not None else component.pn
        if oid in occurrences:
            placed[oid] = pose.placed(step.definitions[component.pn].shape, component.location)
    previous = build.previous_label(hw, label)
    baseline = build.read_json(hw / "versions" / previous / "metrics.json")["parts"] if previous else None
    joints = manifest["joint_pairs"]
    joint_pairs = {tuple(entry["pair"]) for entry in joints}
    geometry = pair_geometry(placed)
    assembly = pose.load_assembly(hw)
    declared = declared_press_fits(hw, assembly)
    heat_sets = declared_heat_sets(hw, assembly)
    checks = {
        "step_readback": step_readback(folder, manifest, parts, step, occurrences),
        "brep_validity": brep_validity(parts, manifest),
        "solid_structure": solid_structure(parts, expected_solids, baseline, previous),
        "interference": interference(geometry, named_pairs, joint_pairs, allowed_pairs, declared, heat_sets, refs),
        "connection": connection(geometry, placed, joints),
        "slivers_tolerances": slivers_and_tolerances(parts),
        "mesh_watertight": mesh_watertight(folder, part_map, occurrences),
    }
    blocking = sorted(name for name, c in checks.items() if c["blocking"] and c["status"] == "fail")
    warnings = sorted(name for name, c in checks.items() if c["status"] == "warn")
    result = {"status": "fail" if blocking else "pass", "label": label, "pose": "nominal",
              "baseline": previous, "blocking_failures": blocking, "warnings": warnings,
              "occurrences": {oid: o.pn for oid, o in occurrences.items()}, "checks": checks,
              "timings_s": {"total_s": round(time.perf_counter() - started, 3)}}
    return (1 if blocking else 0), result
