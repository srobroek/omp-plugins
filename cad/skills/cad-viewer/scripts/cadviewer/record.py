"""Read one cad-model version of a hardware record into the viewer's scene and panel model.

Kernel-free: JSON and PyYAML (`safe_load`) only. cad-record's layout API resolves, verifies and lists built
versions. The occurrence reader normalizes the shared occurrence contract. Part colours use cad-render's
material rules so the viewer and renders share one appearance table.
"""

from __future__ import annotations

import functools
import importlib.util
import json
import math
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import ViewerError

PN_PREFIX = re.compile(r"^([A-Z]{2,5}-\d{4})(?![0-9])")

CAD_SKILLS = Path(__file__).resolve().parents[3]
CAD_RENDER_SCRIPTS = CAD_SKILLS / "cad-render" / "scripts"
LAYOUT_PY = CAD_SKILLS / "cad-record" / "scripts" / "layout.py"
@functools.cache
def _layout() -> Any:
    name = "cad_record_layout"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, LAYOUT_PY)
        if spec is None or spec.loader is None:
            raise ViewerError(f"cannot load {LAYOUT_PY}")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


@dataclass(frozen=True)
class Part:
    """One displayed occurrence: a placement of the PN definition `pn` (a legacy part's id is its PN)."""

    id: str
    pn: str
    ref: str  # `@id`, or the PN of a singleton
    product: str  # viewer node name: the instance name, `<PN> <title>` or `<PN> <title> [@id]`
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
    parts: tuple[str, ...]  # occurrence ids
    path: str


@dataclass(frozen=True)
class Version:
    hw: Path
    label: str
    product_id: str
    parts_dir: Path
    files: dict[str, Path]
    record_dir: Path
    parts: tuple[Part, ...]
    groups: tuple[Group, ...]
    metrics: dict[str, Any]
    manifest: dict[str, Any]

    def part(self, target: str) -> Part:
        """The occurrence `target` names: its id, `@id`, or a PN placed once."""
        key = target[1:] if target.startswith("@") else target
        for part in self.parts:
            if part.id == key:
                return part
        placed = [p for p in self.parts if p.pn == target]
        if len(placed) == 1:
            return placed[0]
        if placed:
            raise ViewerError(f"{self.label}: {target} is ambiguous, placed {len(placed)} times; "
                              f"name one of {', '.join(p.ref for p in placed)}")
        raise ViewerError(f"{self.label}: no part {target}; parts: {[p.ref for p in self.parts]}")

    def targets(self, target: str) -> tuple[str, ...]:
        """Occurrence ids named by a subassembly id (all its members) or one occurrence (`part`)."""
        for group in self.groups:
            if group.id == target:
                return group.parts
        return (self.part(target).id,)

    def nominal_rows(self) -> dict[str, list[list[float]]]:
        """Per-occurrence 3x4 placement rows at the pose this version was built in (manifest `pose`)."""
        rows = (self.manifest.get("pose") or {}).get("transforms")
        if not isinstance(rows, dict) or any(p.id not in rows for p in self.parts):
            raise ViewerError(f"{self.files['manifest']}: pose.transforms must name every occurrence")
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


@functools.cache
def _cad_render_module(name: str) -> Any:
    """One of cad-render's stdlib modules (`materials`, `versions`), loaded once by path."""
    path = CAD_RENDER_SCRIPTS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"cad_render_{name}", path)
    if spec is None or spec.loader is None:
        raise ViewerError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except OSError as error:
        raise ViewerError(f"cannot load {path}: {error}") from error
    return module


def version_files(hw: Path, version: str) -> Any:
    """Verified built-version files and record snapshot from cad-record layout."""
    api = _layout()
    try:
        return api.built_version(hw, version)
    except api.LayoutError as error:
        raise ViewerError(str(error)) from error


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


@functools.cache
def material_table() -> Any:
    """cad-render's MaterialTable over assets/materials.json, loaded once."""
    materials = _cad_render_module("materials")
    try:
        return materials.MaterialTable.load()
    except materials.MaterialsError as error:
        raise ViewerError(f"cad-render material table: {error}") from error


def colour_for(material: str, finish: str) -> str:
    return material_table().resolve(material, finish).pbr["color"]


def load_groups(hw: Path) -> list[tuple[str, str]]:
    """(id, title) of every assembly.yaml subassembly, in record order."""
    data = read_yaml(hw / "assembly.yaml") if (hw / "assembly.yaml").is_file() else {}
    return [(sub["id"], str(sub.get("title") or sub["id"])) for sub in (data or {}).get("subassemblies") or []
            if isinstance(sub, dict) and isinstance(sub.get("id"), str)]


def legacy_groups(hw: Path) -> dict[str, str]:
    """PN -> first subassembly listing it in `parts`: the grouping a version 1 manifest did not record."""
    data = read_yaml(hw / "assembly.yaml") if (hw / "assembly.yaml").is_file() else {}
    grouped: dict[str, str] = {}
    for sub in (data or {}).get("subassemblies") or []:
        if isinstance(sub, dict) and isinstance(sub.get("id"), str):
            for pn in sub.get("parts") or []:
                if isinstance(pn, str):
                    grouped.setdefault(pn, sub["id"])
    return grouped


def load_version(hw: Path, version: str = "latest") -> Version:
    hw = hw.resolve()
    label, folder, record_dir = version_files(hw, version)
    files = {"assembly_step": folder / "assembly.step", "glb": folder / "assembly.glb",
             "metrics": folder / "metrics.json", "part_map": folder / "part-map.json",
             "manifest": folder / "manifest.json"}
    products = load_part_map(files["part_map"])
    manifest = read_json(files["manifest"])
    reader = _cad_render_module("versions")
    try:
        occurrences = reader.built_occurrences(read_json(files["part_map"]), manifest, legacy_groups(record_dir))
    except reader.VersionError as error:
        raise ViewerError(f"{label}: {error}") from error
    product_id = str(manifest.get("product_id") or "assembly")
    groups = []
    for gid, title in load_groups(record_dir):
        members = tuple(oid for oid in sorted(occurrences) if occurrences[oid].group == gid)
        if members:
            groups.append(Group(gid, title, members, f"/{product_id}/{gid}"))
    parts = []
    for oid in sorted(occurrences):
        built = occurrences[oid]
        pn = built.pn
        record_path = record_dir / "parts" / pn / "part.yaml"
        record = read_yaml(record_path) if record_path.is_file() else {}
        record = record if isinstance(record, dict) else {}
        material, process = str(record.get("material") or ""), str(record.get("process") or "")
        finish = str(record.get("finish") or "")
        group = built.group if any(g.id == built.group for g in groups) else None
        node = products[pn] if built.ref == pn else f"{products[pn]} [{built.ref}]"
        path = f"/{product_id}/{group}/{node}" if group else f"/{product_id}/{node}"
        title = str(record.get("title") or products[pn][len(pn):].strip())
        parts.append(Part(oid, pn, built.ref, node, title, material, process,
                          colour_for(material, finish), group, path))
    return Version(hw, label, product_id, folder / "parts", files, record_dir, tuple(parts), tuple(groups),
                   read_json(files["metrics"]), manifest)


# --------------------------------------------------------------------------- version list


def latest_label(hw: Path) -> str | None:
    """Return cad-record layout's latest built version label, or None when latest is absent."""
    api = _layout()
    try:
        return api.latest(hw)
    except api.LayoutError:
        return None


def version_list(hw: Path) -> list[dict[str, Any]]:
    """Every built label from cad-record layout, newest first for the viewer picker."""
    return [_version_entry(hw, label) for label in reversed(_layout().versions(hw))]


def version_bundles(hw: Path, kind: str, label: str) -> list[Path]:
    """Bundle directories for a built version, resolved and validated by cad-record layout."""
    api = _layout()
    try:
        root = api.bundle_dir(hw, kind, label, "assembly").parent
    except api.LayoutError:
        return []
    if not root.is_dir():
        return []
    folders = []
    for path in sorted(root.iterdir(), key=lambda entry: entry.name):
        if not path.is_dir() or path.is_symlink():
            continue
        try:
            folders.append(api.bundle_dir(hw, kind, label, path.name))
        except api.LayoutError:
            continue
    return folders


def version_previews(hw: Path, label: str) -> dict[str, list[dict[str, Any]]]:
    """Verified bundle subjects and relative image paths for this version's preview picker."""
    api = _layout()
    previews: dict[str, list[dict[str, Any]]] = {kind: [] for kind in ("renders", "captures", "drawings")}
    for kind in previews:
        for folder in version_bundles(hw, kind, label):
            if not (folder / "manifest.json").is_file() or api.verify(folder):
                continue
            if kind == "drawings":
                images = [folder / "sheet-1.png"]
            elif kind == "captures":
                images = sorted(folder.glob("*.png"), key=lambda path: path.name)
            else:
                images = sorted(folder.glob("*.png"), key=lambda path: path.name)
            files = [image.relative_to(hw).as_posix() for image in images if image.is_file()]
            if files:
                previews[kind].append({"subject": folder.name, "files": files,
                                       "views": [Path(path).stem for path in files]})
    return previews


def _version_entry(hw: Path, label: str) -> dict[str, Any]:
    entry: dict[str, Any] = {"label": label, "built_utc": None, "parts": None, "error": None,
                             "previews": {kind: [] for kind in ("renders", "captures", "drawings")}}
    api = _layout()
    try:
        folder = api.version_dir(hw, label)
        entry["previews"] = version_previews(hw, label)
        manifest_path = folder / "manifest.json"
        problems = api.verify(folder)
        if problems:
            raise ViewerError(f"{label} fails its manifest: {'; '.join(problems)}")
        manifest = read_json(manifest_path)
    except (ViewerError, OSError, api.LayoutError) as error:
        entry["error"] = str(error)
        return entry
    if not isinstance(manifest, dict):
        entry["error"] = f"{manifest_path}: expected a JSON object"
        return entry
    created = manifest.get("created_utc")
    entry["built_utc"] = created if isinstance(created, str) else datetime.fromtimestamp(
        manifest_path.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    placed = manifest.get("occurrences") if isinstance(manifest.get("occurrences"), dict) else manifest.get("parts")
    entry["parts"] = len(placed) if isinstance(placed, dict) else None
    return entry


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


def holes(pn: str, value: Any) -> list[dict[str, Any]]:
    """metrics.json `parts.<PN>.holes` as the panel lists them: id, diameter, through or blind, depth.

    A missing field and `[]` both mean none listed; cad-model's order (diameter, then position)
    is kept. An entry without a finite positive diameter or a boolean `through` is a contract error.
    """
    if value is None:
        return []
    if not isinstance(value, list):
        raise ViewerError(f"metrics.json parts.{pn}.holes must be a list")
    rows = []
    for index, entry in enumerate(value):
        where = f"metrics.json parts.{pn}.holes[{index}]"
        diameter = _finite(entry.get("diameter_mm")) if isinstance(entry, dict) else None
        if diameter is None or diameter <= 0 or not isinstance(entry.get("through"), bool):
            raise ViewerError(f"{where}: needs a positive diameter_mm and a boolean through")
        rows.append({"id": str(entry.get("id") or f"H{index + 1}"), "diameter_mm": diameter,
                     "through": entry["through"], "depth_mm": _finite(entry.get("depth_mm"))})
    return rows


def panel_model(version: Version, check: dict[str, Any] | None) -> dict[str, Any]:
    """The JSON the side panel renders for one version."""
    if check is not None and check.get("label") not in (None, version.label):
        raise ViewerError(f"check JSON is for {check.get('label')}, not {version.label}")
    findings = part_findings(check) if check is not None else {}
    connections = ((check or {}).get("checks") or {}).get("connection", {}).get("parts", {})
    metric_parts = version.metrics.get("parts") or {}
    parts = []
    placed = version.metrics.get("occurrences") or {}  # schema_version 2: nominal-pose geometry per occurrence
    for part in version.parts:
        m = metric_parts.get(part.pn) or {}
        spatial = placed.get(part.id) or m  # a version 1 part is modeled in place: its PN box is its spatial box
        parts.append({
            "id": part.id, "ref": part.ref,
            "pn": part.pn, "product": part.product, "title": part.title, "material": part.material,
            "process": part.process, "colour": part.colour, "group": part.group, "path": part.path,
            "connection": connections.get(part.id),
            # Occurrence checks key by occurrence id, definition checks by PN; a legacy id is its PN.
            "findings": findings.get(part.id, []) + (findings.get(part.pn, []) if part.id != part.pn else []),
            "metrics": {"volume_mm3": _finite(m.get("volume_mm3")), "mass_g": _finite(m.get("mass_g")),
                        "mass_target_g": _finite(m.get("mass_target_g")), "bbox_mm": spatial.get("bbox_mm"),
                        "holes": holes(part.pn, m.get("holes"))},
        })
    totals = version.metrics.get("totals") or {}
    return {
        "label": version.label, "product_id": version.product_id, "hw": str(version.hw),
        "groups": [{"id": g.id, "title": g.title, "parts": list(g.parts), "path": g.path} for g in version.groups],
        "parts": parts,
        "totals": {"volume_mm3": _finite(totals.get("volume_mm3")), "mass_g": _finite(totals.get("mass_g")),
                   "parts_without_density": totals.get("parts_without_density") or [],
                   "bbox_mm": _union_bbox(list(placed.values()) if placed else list(metric_parts.values()))},
        "check": None if check is None else {
            "status": check.get("status"), "blocking_failures": check.get("blocking_failures") or [],
            "warnings": check.get("warnings") or [], "pose": check.get("pose")},
    }
