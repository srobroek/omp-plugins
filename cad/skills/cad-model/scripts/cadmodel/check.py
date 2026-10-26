"""`check`: blocking and advisory geometry checks over one built version."""

from __future__ import annotations

import itertools
import re
import time
from pathlib import Path
from typing import Any, Iterable

from cadmodel import build, mesh, occ
from cadmodel.motion import load_pose

AP242 = "AP242_MANAGED_MODEL_BASED_3D_ENGINEERING"
READBACK_REL = 1e-6          # STEP read-back volume vs the kernel's in-memory volume
CONTACT_MM = 0.01            # distance at or below which two parts touch
FLOAT_GAP_MM = 2.0           # beyond this a part is disconnected rather than floating
INTERFERENCE_MM3 = 1e-3      # shared volume above this is interference
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
    return {"status": _status(all(r["ok"] for r in rows.values())), "blocking": True, "parts": rows}


def pair_geometry(placed: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    """Clearance and shared volume for every pair at the nominal pose; `error` when OCP fails."""
    found: dict[tuple[str, str], dict[str, Any]] = {}
    for a, b in itertools.combinations(sorted(placed), 2):
        sa, sb = placed[a].shape, placed[b].shape
        try:
            gap = occ.distance(sa, sb)
            shared = 0.0
            if gap <= CONTACT_MM and occ.boxes_overlap(sa, sb, CONTACT_MM):
                shared = max(0.0, occ.volume(occ.boolean("common", sa, [sb])))
        except Exception as error:  # noqa: BLE001 - OCP raises Standard_Failure on broken input
            found[(a, b)] = {"clearance_mm": None, "interference_mm3": None, "error": str(error) or type(error).__name__}
            continue
        found[(a, b)] = {"clearance_mm": gap, "interference_mm3": shared}
    return found


def interference(geometry: dict[tuple[str, str], dict[str, Any]], named: list[tuple[str, str]] | None,
                 joint_pairs: set[tuple[str, str]], allowed: set[tuple[str, str]]) -> dict[str, Any]:
    pairs = sorted(geometry) if named is None else sorted({tuple(sorted(p)) for p in named})
    unknown = [list(p) for p in pairs if p not in geometry]
    rows: dict[str, list[dict[str, Any]]] = {"pairs": [], "joint_pairs": []}
    for pair in pairs:
        if pair not in geometry:
            continue
        g = geometry[pair]
        hit = g["interference_mm3"] is None or g["interference_mm3"] > INTERFERENCE_MM3
        entry = {"pair": list(pair), **g, "interferes": hit, "allowed": pair in allowed,
                 "ok": not hit or pair in allowed}
        rows["joint_pairs" if pair in joint_pairs else "pairs"].append(entry)
    every = rows["pairs"] + rows["joint_pairs"]
    measured = [e for e in every if e["clearance_mm"] is not None]
    smallest = min(measured, key=lambda e: e["clearance_mm"], default=None)
    ok = all(e["ok"] for e in every) and not unknown
    return {"status": _status(ok), "blocking": True, "selection": "all" if named is None else "named",
            "threshold_mm3": INTERFERENCE_MM3, "unknown_pairs": unknown,
            "min_clearance": {"pair": smallest["pair"], "clearance_mm": smallest["clearance_mm"]} if smallest else None,
            **rows}


def connection(geometry: dict[tuple[str, str], dict[str, Any]], pns: Iterable[str],
               joint_pairs: set[tuple[str, str]]) -> dict[str, Any]:
    rows = {}
    jointed = {pn for pair in joint_pairs for pn in pair}
    for pn in sorted(pns):
        near = [(g["clearance_mm"], b if a == pn else a) for (a, b), g in geometry.items()
                if pn in (a, b) and g["clearance_mm"] is not None]
        if not near:
            rows[pn] = {"status": "alone", "nearest": None, "distance_mm": None, "ok": len(geometry) == 0}
            continue
        dist, other = min(near)
        status = "touching" if dist <= CONTACT_MM else ("floating" if dist <= FLOAT_GAP_MM else "disconnected")
        ok = status == "touching" or (status == "floating" and pn in jointed)
        rows[pn] = {"status": status, "nearest": other, "distance_mm": dist, "joint_connected": pn in jointed, "ok": ok}
    return {"status": _status(all(r["ok"] for r in rows.values())), "blocking": True,
            "contact_mm": CONTACT_MM, "float_gap_mm": FLOAT_GAP_MM, "parts": rows}


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
    joint_pairs = {tuple(p) for p in manifest["joint_pairs"]}
    geometry = pair_geometry(placed)
    checks = {
        "step_readback": step_readback(folder, manifest, parts, placed),
        "brep_validity": brep_validity(parts, manifest),
        "solid_structure": solid_structure(parts, expected_solids, baseline, previous),
        "interference": interference(geometry, named, joint_pairs, {tuple(sorted(p)) for p in allowed}),
        "connection": connection(geometry, placed, joint_pairs),
        "slivers_tolerances": slivers_and_tolerances(parts),
        "mesh_watertight": mesh_watertight(folder, manifest["parts"]),
    }
    blocking = sorted(name for name, c in checks.items() if c["blocking"] and c["status"] == "fail")
    warnings = sorted(name for name, c in checks.items() if c["status"] == "warn")
    result = {"status": "fail" if blocking else "pass", "label": label, "pose": "nominal",
              "baseline": previous, "blocking_failures": blocking, "warnings": warnings, "checks": checks,
              "timings_s": {"total_s": round(time.perf_counter() - started, 3)}}
    return (1 if blocking else 0), result
