"""`diff`: per-part volume and bounding-box deltas and exact shared / A-only / B-only volumes."""

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


def diff(hw: Path, label_a: str, label_b: str) -> tuple[int, dict[str, Any]]:
    pose = load_pose()
    started = time.perf_counter()
    hw = hw.resolve()
    folders = {label: build.version_dir(hw, label) for label in (label_a, label_b)}
    metrics = {label: build.read_json(folder / "metrics.json")["parts"] for label, folder in folders.items()}
    shapes = {label: pose.load_parts(hw, parts_dir=folder / "parts") for label, folder in folders.items()}
    ma, mb = metrics[label_a], metrics[label_b]
    rows: dict[str, Any] = {}
    for pn in sorted(set(ma) | set(mb)):
        if pn not in mb:
            rows[pn] = {"status": "removed", "volume_a_mm3": ma[pn]["volume_mm3"], "volume_b_mm3": 0.0,
                        "volume_delta_mm3": -ma[pn]["volume_mm3"], "shared_mm3": 0.0,
                        "a_only_mm3": ma[pn]["volume_mm3"], "b_only_mm3": 0.0}
            continue
        if pn not in ma:
            rows[pn] = {"status": "added", "volume_a_mm3": 0.0, "volume_b_mm3": mb[pn]["volume_mm3"],
                        "volume_delta_mm3": mb[pn]["volume_mm3"], "shared_mm3": 0.0,
                        "a_only_mm3": 0.0, "b_only_mm3": mb[pn]["volume_mm3"]}
            continue
        va, vb = ma[pn]["volume_mm3"], mb[pn]["volume_mm3"]
        exact = _exact(shapes[label_a][pn].shape, shapes[label_b][pn].shape)
        slack = occ.volume_slack(va, vb) * 10
        unchanged = (exact.get("a_only_mm3") is not None and exact["a_only_mm3"] <= slack and exact["b_only_mm3"] <= slack)
        box_a, box_b = ma[pn]["bbox_mm"], mb[pn]["bbox_mm"]
        rows[pn] = {"status": "unchanged" if unchanged else "changed",
                    "volume_a_mm3": va, "volume_b_mm3": vb, "volume_delta_mm3": vb - va,
                    "volume_delta_rel": (vb - va) / va if va else None,
                    "bbox_delta_mm": {"min": _delta(box_a["min"], box_b["min"]), "max": _delta(box_a["max"], box_b["max"]),
                                      "size": _delta(box_a["size"], box_b["size"])},
                    "solids_a": ma[pn]["solids"], "solids_b": mb[pn]["solids"],
                    **exact}
    return 0, {"a": label_a, "b": label_b, "frame": "assembly coordinates at the zero pose",
               "added": sorted(pn for pn, r in rows.items() if r["status"] == "added"),
               "removed": sorted(pn for pn, r in rows.items() if r["status"] == "removed"),
               "changed": sorted(pn for pn, r in rows.items() if r["status"] == "changed"),
               "parts": rows, "timings_s": {"total_s": round(time.perf_counter() - started, 3)}}
