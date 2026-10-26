"""Read one cad-model version of a hardware record into the viewer's scene and panel model.

Kernel-free: JSON and PyYAML (`safe_load`) only. Paths follow cad-model's version layout
(`skill://cad-model/references/outputs.md`): `latest.json` names the newest version; an older
label resolves to the same documented layout under `versions/<label>/`.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import ViewerError

LABEL = re.compile(r"^v[1-9][0-9]*$")
PN_PREFIX = re.compile(r"^([A-Z]{2,5}-\d{4})(?![0-9])")

# Material appearance in the 3D view (not UI chrome): the same process colours as
# cad-design's review renders, refined by material family where part.yaml names one.
PROCESS_COLOURS = {"fdm": "#3a3f44", "cnc": "#c4c9cf", "purchased": "#6f747a"}
MATERIAL_COLOURS = (("alumin", "#c4c9cf"), ("stainless", "#8d939b"), ("steel", "#6f747a"), ("brass", "#b59a5b"))
FALLBACK_COLOUR = "#9aa3ad"


@dataclass(frozen=True)
class Part:
    pn: str
    product: str  # STEP product name and viewer node name, PN first
    title: str
    material: str
    process: str
    colour: str
    group: str | None  # subassembly id, or None for a top-level part
    path: str  # OCP viewer tree path


@dataclass(frozen=True)
class Group:
    id: str
    title: str
    parts: tuple[str, ...]
    path: str


@dataclass(frozen=True)
class Version:
    hw: Path
    label: str
    product_id: str
    parts_dir: Path
    files: dict[str, Path]  # assembly_step, glb, metrics, part_map, manifest
    parts: tuple[Part, ...]
    groups: tuple[Group, ...]
    metrics: dict[str, Any]
    manifest: dict[str, Any]

    def part(self, pn: str) -> Part:
        for part in self.parts:
            if part.pn == pn:
                return part
        raise ViewerError(f"{self.label}: no part {pn}; parts: {[p.pn for p in self.parts]}")

    def targets(self, target: str) -> tuple[str, ...]:
        """PNs named by a PN or a subassembly id."""
        for group in self.groups:
            if group.id == target:
                return group.parts
        return (self.part(target).pn,)

    def nominal_rows(self) -> dict[str, list[list[float]]]:
        """Per-part 3x4 placement rows at the pose this version was built in (manifest `pose`)."""
        rows = (self.manifest.get("pose") or {}).get("transforms")
        if not isinstance(rows, dict) or any(p.pn not in rows for p in self.parts):
            raise ViewerError(f"{self.files['manifest']}: pose.transforms must name every part")
        return rows


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ViewerError(f"cannot read {path}: {error}") from error


def read_yaml(path: Path) -> Any:
    import yaml

    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise ViewerError(f"cannot read {path}: {error}") from error


def version_files(hw: Path, version: str) -> tuple[str, dict[str, Path], Path]:
    """(label, files, parts_dir) for `latest` or a `vN` label."""
    versions = hw / "versions"
    latest = read_json(versions / "latest.json") if (versions / "latest.json").is_file() else None
    if version == "latest":
        if latest is None:
            raise ViewerError(f"{versions / 'latest.json'} not found; build a version with cad-model run first")
        label = str(latest.get("label", ""))
    elif LABEL.match(version):
        label = version
    else:
        raise ViewerError(f"version must be latest or vN, got {version!r}")
    if latest is not None and latest.get("label") == label:
        keys = ("assembly_step", "glb", "metrics", "part_map", "manifest")
        missing = [k for k in keys if not isinstance(latest.get(k), str)]
        if missing:
            raise ViewerError(f"{versions / 'latest.json'}: missing {missing}")
        files = {k: hw / latest[k] for k in keys}
    else:
        folder = versions / label
        files = {"assembly_step": folder / "assembly.step", "glb": folder / "assembly.glb",
                 "metrics": folder / "metrics.json", "part_map": folder / "part-map.json",
                 "manifest": folder / "manifest.json"}
    absent = [str(p) for p in files.values() if not p.is_file()]
    if absent:
        raise ViewerError(f"version {label}: missing {absent}")
    return label, files, files["assembly_step"].parent / "parts"


def load_part_map(path: Path) -> dict[str, str]:
    """PN -> product name from cad-model `part-map.json`; every product name starts with its PN."""
    data = read_json(path)
    parts = data.get("parts") if isinstance(data, dict) else None
    if not isinstance(parts, dict) or not parts:
        raise ViewerError(f"{path}: expected a non-empty `parts` mapping")
    products: dict[str, str] = {}
    for pn, entry in parts.items():
        product = entry.get("product") if isinstance(entry, dict) else None
        if not isinstance(product, str) or not product:
            raise ViewerError(f"{path}: parts.{pn}.product must be a non-empty string")
        match = PN_PREFIX.match(product)
        if not match or match.group(1) != pn:
            raise ViewerError(f"{path}: parts.{pn}.product {product!r} does not start with {pn}")
        products[pn] = product
    return products


def colour_for(material: str, process: str) -> str:
    lowered = material.lower()
    for key, colour in MATERIAL_COLOURS:
        if key in lowered:
            return colour
    return PROCESS_COLOURS.get(process, FALLBACK_COLOUR)


def load_groups(hw: Path) -> list[tuple[str, str, list[str]]]:
    data = read_yaml(hw / "assembly.yaml") if (hw / "assembly.yaml").is_file() else {}
    groups = []
    for sub in (data or {}).get("subassemblies") or []:
        if isinstance(sub, dict) and isinstance(sub.get("id"), str):
            groups.append((sub["id"], str(sub.get("title") or sub["id"]),
                           [pn for pn in sub.get("parts") or [] if isinstance(pn, str)]))
    return groups


def load_version(hw: Path, version: str = "latest") -> Version:
    hw = hw.resolve()
    label, files, parts_dir = version_files(hw, version)
    products = load_part_map(files["part_map"])
    manifest = read_json(files["manifest"])
    product_id = str(manifest.get("product_id") or "assembly")
    grouped: dict[str, str] = {}
    groups = []
    for gid, title, members in load_groups(hw):
        present = tuple(pn for pn in members if pn in products and pn not in grouped)
        grouped.update({pn: gid for pn in present})
        if present:
            groups.append(Group(gid, title, present, f"/{product_id}/{gid}"))
    parts = []
    for pn in sorted(products):
        record_path = hw / "parts" / pn / "part.yaml"
        record = read_yaml(record_path) if record_path.is_file() else {}
        record = record if isinstance(record, dict) else {}
        material, process = str(record.get("material") or ""), str(record.get("process") or "")
        group = grouped.get(pn)
        path = f"/{product_id}/{group}/{products[pn]}" if group else f"/{product_id}/{products[pn]}"
        title = str(record.get("title") or products[pn][len(pn):].strip())
        parts.append(Part(pn, products[pn], title, material, process, colour_for(material, process), group, path))
    return Version(hw, label, product_id, parts_dir, files, tuple(parts), tuple(groups),
                   read_json(files["metrics"]), manifest)


# --------------------------------------------------------------------------- check findings


def _mm(value: Any) -> str:
    return f"{value:.3f} mm" if isinstance(value, (int, float)) else "n/a"


def connection_text(row: dict[str, Any]) -> str:
    status, nearest = row.get("status"), row.get("nearest")
    if status == "touching":
        return f"touches {nearest}"
    if status == "alone":
        return "no other part to touch"
    joint = " (joint-connected)" if row.get("joint_connected") else ""
    return f"touches no other part; {_mm(row.get('distance_mm'))} from {nearest}{joint}"


def part_findings(check: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    """Per-PN findings from a cad-model `check` result: one entry per failed or warned row."""
    checks = check.get("checks") if isinstance(check, dict) else None
    if not isinstance(checks, dict):
        raise ViewerError("check JSON has no `checks` mapping")
    found: dict[str, list[dict[str, str]]] = {}

    def add(pn: str, name: str, severity: str, message: str) -> None:
        found.setdefault(pn, []).append({"check": name, "severity": severity, "message": message})

    for name, result in checks.items():
        severity = "warn" if result.get("status") == "warn" or not result.get("blocking", True) else "fail"
        if name == "interference":
            for entry in [*result.get("pairs", []), *result.get("joint_pairs", [])]:
                if not entry.get("ok", True):
                    a, b = entry["pair"]
                    volume = entry.get("interference_mm3")
                    add(a, name, severity, f"interferes with {b}: {volume:.3f} mm3")
                    add(b, name, severity, f"interferes with {a}: {volume:.3f} mm3")
            continue
        for pn, row in (result.get("parts") or {}).items():
            if name == "connection":
                if row.get("status") != "touching":
                    add(pn, name, "warn" if row.get("ok") else severity, connection_text(row))
            elif name == "mesh_watertight":
                if not row.get("watertight", True):
                    add(pn, name, severity, f"GLB mesh not watertight (Euler number {row.get('euler_number')})")
            elif not row.get("ok", row.get("valid", True)):
                add(pn, name, severity, _row_message(name, row))
    return found


def _row_message(name: str, row: dict[str, Any]) -> str:
    if name == "step_readback":
        worst = max(row.get("part_step_rel_error") or 0.0, row.get("assembly_rel_error") or 0.0)
        return f"STEP read-back volume differs by {worst:.2e} relative"
    if name == "brep_validity":
        return f"B-rep invalid: {row.get('kernel_errors') or row.get('step_errors')}"
    if name == "solid_structure":
        return f"{row.get('solids')} solids, expected {row.get('expected')}"
    if name == "slivers_tolerances":
        return (f"{row.get('sliver_faces', 0)} sliver faces, max tolerance "
                f"{_mm(row.get('max_tolerance_mm'))}")
    return json.dumps(row, sort_keys=True)[:160]


# --------------------------------------------------------------------------- panel model


def _union_bbox(rows: list[dict[str, Any]]) -> dict[str, list[float]] | None:
    boxes = [r.get("bbox_mm") for r in rows if isinstance(r.get("bbox_mm"), dict)]
    if not boxes:
        return None
    low = [min(b["min"][i] for b in boxes) for i in range(3)]
    high = [max(b["max"][i] for b in boxes) for i in range(3)]
    return {"min": low, "max": high, "size": [high[i] - low[i] for i in range(3)]}


def _finite(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and math.isfinite(value) else None


def panel_model(version: Version, check: dict[str, Any] | None) -> dict[str, Any]:
    """The JSON the side panel renders for one version."""
    if check is not None and check.get("label") not in (None, version.label):
        raise ViewerError(f"check JSON is for {check.get('label')}, not {version.label}")
    findings = part_findings(check) if check is not None else {}
    connections = ((check or {}).get("checks") or {}).get("connection", {}).get("parts", {})
    metric_parts = version.metrics.get("parts") or {}
    parts = []
    for part in version.parts:
        m = metric_parts.get(part.pn) or {}
        parts.append({
            "pn": part.pn, "product": part.product, "title": part.title, "material": part.material,
            "process": part.process, "colour": part.colour, "group": part.group, "path": part.path,
            "connection": connections.get(part.pn),
            "findings": findings.get(part.pn, []),
            "metrics": {"volume_mm3": _finite(m.get("volume_mm3")), "mass_g": _finite(m.get("mass_g")),
                        "mass_target_g": _finite(m.get("mass_target_g")), "bbox_mm": m.get("bbox_mm"),
                        "holes": m.get("holes")},
        })
    totals = version.metrics.get("totals") or {}
    return {
        "label": version.label, "product_id": version.product_id, "hw": str(version.hw),
        "groups": [{"id": g.id, "title": g.title, "parts": list(g.parts), "path": g.path} for g in version.groups],
        "parts": parts,
        "totals": {"volume_mm3": _finite(totals.get("volume_mm3")), "mass_g": _finite(totals.get("mass_g")),
                   "parts_without_density": totals.get("parts_without_density") or [],
                   "bbox_mm": _union_bbox(list(metric_parts.values()))},
        "check": None if check is None else {
            "status": check.get("status"), "blocking_failures": check.get("blocking_failures") or [],
            "warnings": check.get("warnings") or [], "pose": check.get("pose")},
    }
