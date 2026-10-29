"""`diff`: per-part volume and bounding-box deltas and exact shared / A-only / B-only volumes, and the
manufacturing state, policy and output differences of each custom-made part, reported separately."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from cadmodel import build, occ
from cadmodel.motion import load_pose


def _exact(a: Any, b: Any) -> dict[str, Any]:
    """Shared and exclusive volumes of two zero-pose part shapes (overlapping members counted once)."""
    try:
        sa, _ = occ.occupied(a)
        sb, _ = occ.occupied(b)
        return {"shared_mm3": occ.volume(occ.boolean("common", sa, [sb])),
                "a_only_mm3": occ.volume(occ.boolean("cut", sa, [sb])),
                "b_only_mm3": occ.volume(occ.boolean("cut", sb, [sa]))}
    except Exception as error:  # noqa: BLE001 - reported per part; other parts still diff
        return {"shared_mm3": None, "a_only_mm3": None, "b_only_mm3": None, "error": str(error) or type(error).__name__}


def _delta(a: list[float], b: list[float]) -> list[float]:
    return [b[i] - a[i] for i in range(3)]


def compare_part(a: dict[str, Any], b: dict[str, Any], shape_a: Any, shape_b: Any) -> dict[str, Any]:
    """The diff row of a part in both versions, from its metrics and zero-pose shapes.

    `error` when the exact Booleans failed: the part may or may not have changed.
    """
    va, vb = a["volume_mm3"], b["volume_mm3"]
    exact = _exact(shape_a, shape_b)
    if "error" in exact:
        status = "error"
    else:
        slack = occ.volume_slack(va, vb) * 10
        status = "unchanged" if exact["a_only_mm3"] <= slack and exact["b_only_mm3"] <= slack else "changed"
    box_a, box_b = a["bbox_mm"], b["bbox_mm"]
    return {"status": status,
            "volume_a_mm3": va, "volume_b_mm3": vb, "volume_delta_mm3": vb - va,
            "volume_delta_rel": (vb - va) / va if va else None,
            "bbox_delta_mm": {"min": _delta(box_a["min"], box_b["min"]), "max": _delta(box_a["max"], box_b["max"]),
                              "size": _delta(box_a["size"], box_b["size"])},
            "solids_a": a["solids"], "solids_b": b["solids"],
            **exact}


def _aspects(a: dict[str, Any], b: dict[str, Any]) -> list[str]:
    """The manufacturing facts of one PN that differ between two manifest entries."""
    def tolerance(entry: dict[str, Any]) -> tuple[Any, Any]:
        declared = entry.get("tolerance") or {}
        return declared.get("volume_rel"), declared.get("volume_abs_mm3")

    def native(entry: dict[str, Any]) -> tuple[Any, Any]:
        facts = entry.get("native") or {}
        return facts.get("kernel_volume_mm3"), facts.get("kernel_solids")

    def placement(entry: dict[str, Any]) -> tuple[Any, Any, list[list[float]]]:
        facts = entry.get("placement") or {}
        return facts.get("method"), facts.get("orientation"), facts.get("transform") or []

    (va, sa), (vb, sb) = native(a), native(b)
    (ma, oa, ta), (mb, ob, tb) = placement(a), placement(b)
    differs = {
        "state": a.get("state") != b.get("state"),
        "tolerance": tolerance(a) != tolerance(b),
        "output_policy": (a.get("mesh"), a.get("build_volume")) != (b.get("mesh"), b.get("build_volume")),
        "geometry": ((va, sa) != (vb, sb) if va is None or vb is None
                     else abs(vb - va) > occ.volume_slack(va, vb) * 10 or sa != sb),
        "placement": (ma, oa, len(ta)) != (mb, ob, len(tb))
        or any(abs(x - y) > 1e-6 for ra, rb in zip(ta, tb) for x, y in zip(ra, rb)),
    }
    return [name for name, changed in differs.items() if changed]


def compare_manufacturing(a: dict[str, Any] | None, b: dict[str, Any] | None) -> dict[str, Any]:
    """Per custom-made PN of two manifests' `manufacturing` entries: added, removed, changed (naming the
    state, tolerance, output_policy, geometry or placement aspects) or unchanged."""
    if a is None or b is None:
        return {"available": False, "message": "a version was built before manufacturing outputs"}
    rows: dict[str, Any] = {}
    for pn in sorted(set(a) | set(b)):
        if pn not in b or pn not in a:
            rows[pn] = {"status": "removed" if pn not in b else "added"}
            continue
        aspects = _aspects(a[pn], b[pn])
        rows[pn] = {"status": "changed" if aspects else "unchanged", "changed": aspects,
                    "relationship_a": (a[pn].get("state") or {}).get("relationship"),
                    "relationship_b": (b[pn].get("state") or {}).get("relationship"),
                    "volume_a_mm3": (a[pn].get("native") or {}).get("kernel_volume_mm3"),
                    "volume_b_mm3": (b[pn].get("native") or {}).get("kernel_volume_mm3")}
    return {"available": True, "changed": sorted(pn for pn, row in rows.items() if row["status"] != "unchanged"),
            "parts": rows}


def diff(hw: Path, label_a: str, label_b: str) -> tuple[int, dict[str, Any]]:
    pose = load_pose()
    started = time.perf_counter()
    hw = hw.resolve()
    folders = {label: build.version_dir(hw, label) for label in (label_a, label_b)}
    metrics = {label: build.read_json(folder / "metrics.json")["parts"] for label, folder in folders.items()}
    made = {label: build.read_json(folder / "manifest.json").get("manufacturing") for label, folder in folders.items()}
    shapes = {label: pose.load_definitions(hw, folder / "parts") for label, folder in folders.items()}
    ma, mb = metrics[label_a], metrics[label_b]
    rows: dict[str, Any] = {}
    for pn in sorted(set(ma) | set(mb)):
        if pn not in mb:
            rows[pn] = {"status": "removed", "volume_a_mm3": ma[pn]["volume_mm3"], "volume_b_mm3": 0.0,
                        "volume_delta_mm3": -ma[pn]["volume_mm3"], "shared_mm3": 0.0,
                        "a_only_mm3": ma[pn]["volume_mm3"], "b_only_mm3": 0.0}
        elif pn not in ma:
            rows[pn] = {"status": "added", "volume_a_mm3": 0.0, "volume_b_mm3": mb[pn]["volume_mm3"],
                        "volume_delta_mm3": mb[pn]["volume_mm3"], "shared_mm3": 0.0,
                        "a_only_mm3": 0.0, "b_only_mm3": mb[pn]["volume_mm3"]}
        else:
            rows[pn] = compare_part(ma[pn], mb[pn], shapes[label_a][pn].shape, shapes[label_b][pn].shape)
    listed = {status: sorted(pn for pn, r in rows.items() if r["status"] == status)
              for status in ("added", "removed", "changed", "error")}
    return 0, {"a": label_a, "b": label_b, "frame": "each PN definition in its model frame", **listed,
               "parts": rows, "manufacturing": compare_manufacturing(made[label_a], made[label_b]),
               "timings_s": {"total_s": round(time.perf_counter() - started, 3)}}
