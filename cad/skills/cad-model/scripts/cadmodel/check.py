"""`check`: blocking and advisory geometry checks over one built version."""

from __future__ import annotations

import importlib.util
import itertools
import re
import sys
import time
from decimal import Decimal, InvalidOperation
from functools import cache
from pathlib import Path
from typing import Any, Iterable

import yaml

from cadmodel import build, mesh, occ
from cadmodel.motion import load_pose

FITS_SCRIPT = Path(__file__).resolve().parents[3] / "cad-fits" / "scripts" / "fits.py"

AP242 = "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING"
READBACK_REL = 1e-6          # STEP read-back volume vs the kernel's in-memory volume
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


def step_readback(folder: Path, manifest: dict[str, Any], parts: dict[str, Any], placed: dict[str, Any]) -> dict[str, Any]:
    expected = manifest["parts"]
    files = {"assembly.step": _schema(folder / "assembly.step"),
             **{info["step"]: _schema(folder / info["step"]) for info in expected.values()}}
    text = (folder / "assembly.step").read_text(encoding="utf-8", errors="replace")
    rows = {}
    for pn, info in sorted(expected.items()):
        kernel_v = info["kernel_volume_mm3"]
        part_v = occ.volume(parts[pn].shape) if pn in parts else None
        asm_v = occ.volume(placed[pn].shape) if pn in placed else None
        rows[pn] = {
            "expected_name": info["product"],
            "part_step_name": parts[pn].name if pn in parts else None,
            "assembly_name": placed[pn].name if pn in placed else None,
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
    extra = sorted(set(placed) - set(expected))
    top_ok = f"PRODUCT('{manifest['top_product']}'" in text
    schema_ok = all(s is not None and s.startswith(AP242) for s in files.values())
    ok = schema_ok and all(r["ok"] for r in rows.values()) and not extra and top_ok
    return {"status": _status(ok), "blocking": True, "schema": files, "top_product": manifest["top_product"],
            "top_product_found": top_ok, "unexpected_products": extra, "tolerance_rel": READBACK_REL, "parts": rows}


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
    """Clearance and shared volume of every pair at the nominal pose; `error` when OCP fails.

    The measurement is cad-motion's `pose.interference`, the rule `sweep.py` applies to every pose.
    """
    pose = load_pose()
    found: dict[tuple[str, str], dict[str, Any]] = {}
    for a, b in itertools.combinations(sorted(placed), 2):
        try:
            gap, shared = pose.interference(placed[a].shape, placed[b].shape)
        except Exception as error:  # noqa: BLE001 - OCP raises Standard_Failure on broken input
            found[(a, b)] = {"clearance_mm": None, "interference_mm3": None, "error": str(error) or type(error).__name__}
            continue
        found[(a, b)] = {"clearance_mm": gap, "interference_mm3": shared}
    return found


@cache
def _fits_module() -> Any:
    """Load cad-fits' single ISO 286 classifier for check-time record interpretation."""
    spec = importlib.util.spec_from_file_location("cadmodel_fit_classifier", FITS_SCRIPT)
    if spec is None or spec.loader is None:
        raise build.UsageError(f"cannot load fit classifier at {FITS_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _interfaces(hw: Path) -> list[Any]:
    """The interfaces list of hw/interfaces.yaml; empty when the file is absent."""
    path = hw / "interfaces.yaml"
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, yaml.YAMLError) as error:
        raise build.UsageError(f"{path}: cannot read interfaces: {error}") from error
    if not isinstance(document, dict) or not isinstance(document.get("interfaces"), list):
        raise build.UsageError(f"{path}: expected an interfaces list")
    return document["interfaces"]


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _fit_parts(fit: dict[str, Any], where: str) -> tuple[list[str], dict[str, Any] | None]:
    """The hole and shaft PNs of a fit, and its feature endpoints when it declares them instead of a pair."""
    endpoints = {side: fit[side] for side in ("hole", "shaft") if side in fit}
    if "pair" in fit and not endpoints:
        pair = fit["pair"]
        if not isinstance(pair, list) or len(pair) != 2 or not all(_text(pn) for pn in pair) or pair[0] == pair[1]:
            raise build.UsageError(f"{where}: expected fit and two distinct part numbers")
        return list(pair), None
    if "pair" not in fit and len(endpoints) == 2 and all(
            isinstance(e, dict) and _text(e.get("PN")) and isinstance(e.get("feature"), str) and e["feature"]
            for e in endpoints.values()) and endpoints["hole"]["PN"] != endpoints["shaft"]["PN"]:
        return [endpoints["hole"]["PN"], endpoints["shaft"]["PN"]], {
            side: {key: endpoints[side][key] for key in ("PN", "feature", "region") if key in endpoints[side]}
            for side in ("hole", "shaft")}
    raise build.UsageError(f"{where}: expected fit with either a part pair or hole and shaft endpoints "
                           "{PN, feature} on two distinct parts")


def declared_press_fits(hw: Path) -> list[dict[str, Any]]:
    """Read press-fit declarations and classify them with cad-fits' ISO 286 tables.

    A fit names its parts as a `pair` or as feature-specific `hole` and `shaft` endpoints; an
    endpoint declaration is reported with its `endpoints`.
    """
    path = hw / "interfaces.yaml"
    interfaces = _interfaces(hw)
    fits = _fits_module() if interfaces else None
    declared = []
    for index, interface in enumerate(interfaces):
        if not isinstance(interface, dict):
            continue
        limits = interface.get("limits")
        press = limits.get("press_fit") if isinstance(limits, dict) else None
        if press is None:
            continue
        source = f"interfaces.yaml#/interfaces/{index}/limits/press_fit"
        if not isinstance(press, dict):
            raise build.UsageError(f"{path}:{source}: expected a fit and part pair")
        designation = press.get("fit")
        if not isinstance(designation, str):
            raise build.UsageError(f"{path}:{source}: expected fit and two distinct part numbers")
        pair, endpoints = _fit_parts(press, f"{path}:{source}")
        parts = designation.split(maxsplit=1)
        if len(parts) != 2:
            raise build.UsageError(f"{path}:{source}: fit must contain a nominal size and ISO fit")
        try:
            fit_data = fits.evaluate(Decimal(parts[0]), parts[1]).get("fit")
            if not isinstance(fit_data, dict):
                raise build.UsageError(f"{path}:{source}: expected an ISO hole/shaft fit, got {designation!r}")
            classified = fit_data["type"]
        except (InvalidOperation, ValueError, fits.FitError, KeyError) as error:
            raise build.UsageError(f"{path}:{source}: cannot classify {designation!r}: {error}") from error
        entry = {"pair": sorted(pair), "fit": designation, "classification": classified,
                 "interface": interface.get("id"), "source": source}
        if endpoints is not None:
            entry["endpoints"] = endpoints
        declared.append(entry)
    return declared


def declared_heat_sets(hw: Path) -> list[dict[str, Any]]:
    """Read heat-set insert declarations, `limits.heat_set: [{pair: [host PN, insert PN], hole_d, insert, source}]`.

    An installed insert overlaps its bore by design, so each pair is allowed to interfere; unlike a
    press fit, no measured overlap is required, because a model may draw the insert at its bore size.
    """
    path = hw / "interfaces.yaml"
    declared = []
    for index, interface in enumerate(_interfaces(hw)):
        limits = interface.get("limits") if isinstance(interface, dict) else None
        entries = limits.get("heat_set") if isinstance(limits, dict) else None
        if entries is None:
            continue
        if not isinstance(entries, list):
            raise build.UsageError(f"{path}:interfaces.yaml#/interfaces/{index}/limits/heat_set: expected a list")
        for number, entry in enumerate(entries):
            source = f"interfaces.yaml#/interfaces/{index}/limits/heat_set/{number}"
            pair = entry.get("pair") if isinstance(entry, dict) else None
            hole_d = entry.get("hole_d") if isinstance(entry, dict) else None
            if (not isinstance(pair, list) or len(pair) != 2 or not all(_text(pn) for pn in pair) or pair[0] == pair[1]
                    or isinstance(hole_d, bool) or not isinstance(hole_d, (int, float)) or hole_d <= 0
                    or not isinstance(entry.get("insert"), str) or not entry["insert"]):
                raise build.UsageError(f"{path}:{source}: expected pair [host PN, insert PN], a positive hole_d "
                                       "and an insert designation")
            declared.append({"pair": sorted(pair), "host": pair[0], "insert": entry["insert"], "hole_d": hole_d,
                             "interface": interface.get("id"), "source": source})
    return declared


def interference(geometry: dict[tuple[str, str], dict[str, Any]], named: list[tuple[str, str]] | None,
                 joint_pairs: set[tuple[str, str]], allowed: set[tuple[str, str]],
                 declared: Iterable[dict[str, Any]] = (), heat_sets: Iterable[dict[str, Any]] = ()) -> dict[str, Any]:
    """Only a classified declared interference fit or a declared heat-set insert excuses overlap."""
    threshold = load_pose().INTERFERENCE_MM3
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
        entry = {"pair": list(pair), **g, "interferes": hit, "allowed": pair in effective_allowed,
                 "ok": not hit or (measured and pair in effective_allowed)}
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


def rigid_bodies(pns: Iterable[str], joints: Iterable[dict[str, Any]]) -> dict[str, str]:
    """Each part's rigid body, named by its smallest PN: a fixed joint (or --attach) welds its two parts."""
    parent = {pn: pn for pn in pns}

    def root(pn: str) -> str:
        while parent.setdefault(pn, pn) != pn:
            pn = parent[pn]
        return pn

    for joint in joints:
        if joint["type"] == "fixed":
            low, high = sorted(root(pn) for pn in joint["pair"])
            parent[high] = low
    return {pn: root(pn) for pn in list(parent)}


def connection(geometry: dict[tuple[str, str], dict[str, Any]], pns: Iterable[str],
               joints: list[dict[str, Any]]) -> dict[str, Any]:
    """Whether each part is held: fixed pairs touch, and each part touches or floats across a movable joint.

    Parts welded by fixed joints or --attach form one rigid body: the two parts of every fixed joint
    must touch, and a gap within a body is never a joint clearance. A float (CONTACT_MM to
    FLOAT_GAP_MM) passes only when a movable joint links the part's body to the nearest part's body.
    """
    pns = sorted(pns)
    body = rigid_bodies(pns, joints)
    links = {frozenset((body[j["pair"][0]], body[j["pair"][1]])): j["joint"] for j in joints if j["type"] != "fixed"}
    rows = {}
    for pn in pns:
        near = [(g["clearance_mm"], b if a == pn else a) for (a, b), g in geometry.items()
                if pn in (a, b) and g["clearance_mm"] is not None]
        if not near:
            rows[pn] = {"status": "alone", "nearest": None, "distance_mm": None, "ok": len(geometry) == 0}
            continue
        dist, other = min(near)
        status = "touching" if dist <= CONTACT_MM else ("floating" if dist <= FLOAT_GAP_MM else "disconnected")
        joint = links.get(frozenset((body[pn], body[other])))
        ok = status == "touching" or (status == "floating" and joint is not None)
        rows[pn] = {"status": status, "nearest": other, "distance_mm": dist, "joint_connected": joint is not None,
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


def mesh_watertight(folder: Path, pns: Iterable[str]) -> dict[str, Any]:
    rows = mesh.watertight(folder / "assembly.glb", pns)
    return {"status": _status(all(r["watertight"] for r in rows.values())), "blocking": True, "parts": rows}


def check(hw: Path, label: str, named: list[tuple[str, str]] | None, allowed: Iterable[tuple[str, str]],
          expected_solids: dict[str, int]) -> tuple[int, dict[str, Any]]:
    pose = load_pose()
    started = time.perf_counter()
    hw = hw.resolve()
    folder = build.version_dir(hw, label)
    manifest = build.read_json(folder / "manifest.json")
    parts = pose.load_parts(hw, parts_dir=folder / "parts")
    placed = pose.load_parts(hw, step=folder / "assembly.step")
    previous = build.previous_label(hw, label)
    baseline = build.read_json(hw / "versions" / previous / "metrics.json")["parts"] if previous else None
    joints = manifest["joint_pairs"]
    joint_pairs = {tuple(entry["pair"]) for entry in joints}
    geometry = pair_geometry(placed)
    declared = declared_press_fits(hw)
    heat_sets = declared_heat_sets(hw)
    checks = {
        "step_readback": step_readback(folder, manifest, parts, placed),
        "brep_validity": brep_validity(parts, manifest),
        "solid_structure": solid_structure(parts, expected_solids, baseline, previous),
        "interference": interference(geometry, named, joint_pairs, {tuple(sorted(p)) for p in allowed}, declared,
                                     heat_sets),
        "connection": connection(geometry, placed, joints),
        "slivers_tolerances": slivers_and_tolerances(parts),
        "mesh_watertight": mesh_watertight(folder, manifest["parts"]),
    }
    blocking = sorted(name for name, c in checks.items() if c["blocking"] and c["status"] == "fail")
    warnings = sorted(name for name, c in checks.items() if c["status"] == "warn")
    result = {"status": "fail" if blocking else "pass", "label": label, "pose": "nominal",
              "baseline": previous, "blocking_failures": blocking, "warnings": warnings, "checks": checks,
              "timings_s": {"total_s": round(time.perf_counter() - started, 3)}}
    return (1 if blocking else 0), result
