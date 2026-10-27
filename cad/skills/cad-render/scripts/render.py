#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "playwright==1.64.1",
#     "pyyaml>=6.0",
# ]
# ///
"""Render a cad-model version to product PNGs through the static three.js PBR page.

Usage:
    uv run --script render.py HW [--version latest|vN] [--views iso front side exploded closeup-PN part-PN ...]
        [--size 1600x1200] [--force] [--cache-dir DIR]

Resolves the version through HW/versions/latest.json (or HW/versions/vN/), maps each part's
part.yaml material and finish to a MeshPhysicalMaterial through assets/materials.json, serves
assets/renderer/ with the version GLB, drives headless Chromium (SwiftShader WebGL) with
Playwright, and writes:

    HW/renders/<version>/<view>.png   one per view
    HW/renders/<version>/manifest.json

Each frame is graded from its pixels and subject mask. BLANK, CLIPPED, and close-up OCCLUDED (less than 25% of the subject's isolated visible pixels remain visible) make a view unusable; NO_SHADOW and INVERTED_SHADOW are cosmetic warnings and keep the PNG.
A rerun whose source (GLB, part map, manifest, metrics, assembly.yaml), materials, and renderer hashes match a passing or warning manifest is a cache hit.

stdout: one JSON summary. Exit 0 = every view is usable (pass or warn, including cache hits), 1 = an unusable view remains after its retry ladder (renders and manifest are still written), 2 = usage or infrastructure error (nothing written).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import re
import shutil
import sys
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve()
SKILL = HERE.parent.parent
RENDERER_DIR = SKILL / "assets" / "renderer"
MATERIALS_PY = HERE.parent / "materials.py"
VERSIONS_PY = HERE.parent / "versions.py"
CONCEPT_SERVE = SKILL.parent / "cad-concept" / "scripts" / "serve.py"
# The page chrome tokens (status line) are cad-concept's; renderer/tokens.css holds the scene's.
CONCEPT_TOKENS = SKILL.parent / "cad-concept" / "assets" / "viewer" / "tokens.css"
THREE_VERSION = "0.186.1"
CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
BOOT_TIMEOUT_MS = 180_000
VIEW_NAME = re.compile(r"^(iso|front|side|exploded|(closeup|part)-[A-Z]{2,5}-[0-9]{4})$")
SIZE = re.compile(r"^([1-9][0-9]{2,3})x([1-9][0-9]{2,3})$")
DEFAULT_VIEWS = ["iso", "front", "side", "exploded"]
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".json": "application/json", ".glb": "model/gltf-binary"}
STATIC = {"/concept-tokens.css": CONCEPT_TOKENS}  # served beside assets/renderer/, outside it
SOURCE_FILES = ("glb", "part_map", "manifest", "metrics")  # version files the scene reads: cache key, inputs

# View directions from the subject towards the camera, assembly frame (mm, +Z up, front = -Y).
# Front and side keep a low elevation so the ground plane, and the shadow on it, stays in view.
DIRECTIONS = {
    "iso": (0.9, -1.3, 1.1),
    "front": (0.0, -1.0, 0.22),
    "side": (1.0, 0.0, 0.22),
    "exploded": (0.9, -1.3, 1.2),
    "closeup": (0.8, -1.0, 1.4),
    "part": (0.9, -1.3, 1.1),
}
ALTERNATE_CLOSEUP_DIRECTIONS = (
    (0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (-1.0, 0.0, 0.0),
    (0.0, 0.0, 1.0), (0.0, 0.0, -1.0), (0.8, -1.0, 1.4),
)
MIN_VISIBLE_FRACTION = 0.25  # retain at least one quarter of the isolated subject projection
MOVABLE_GAP = 0.3  # exploded gap of a moving child: fraction of its bounding-box diagonal
FIXED_GAP = 1.6  # exploded pull of a fixed child (pin, fastener) along its axis: x its length

BACKDROP_TOLERANCE = 6  # max channel difference still counted as backdrop
MIN_SUBJECT_COVERAGE = 0.005  # subject pixels / frame pixels below which a frame is blank
MIN_CONTENT_COVERAGE = 0.005  # non-backdrop pixels / frame pixels below which a frame is blank
UNUSABLE_FINDINGS = frozenset({"BLANK", "CLIPPED", "OCCLUDED"})
WARNING_FINDINGS = frozenset({"NO_SHADOW", "INVERTED_SHADOW"})
SHADOW_DELTA = 10  # a ground pixel this much darker than the backdrop (luminance) is shadow
MIN_SHADOW_RATIO = 0.04  # shadow pixels / product pixels needed for a visible ground shadow
MIN_SHADOW_DEPTH = 22  # backdrop luminance minus the 2nd-percentile shadow luminance
PART_CLEARANCE_PX = 2  # ground pixels this close to a part are anti-aliased edges, not shadow
SAMPLE_STRIDE = 2  # interior statistics read every 2nd pixel in x and y
CONTACT_BAND_PX = (3, 10)  # floor rows below a grounded rim's lower edge read as its contact shadow
FLOOR_RIM = 1  # floor-zone byte: part surface within the renderer's contact band of the floor
FLOOR_OVERHUNG = 2  # floor-zone byte: floor under a part at least the renderer's overhang height up


class InfraError(RuntimeError):
    """Usage or infrastructure failure; maps to exit 2."""


def _load_sibling(name: str, path: Path) -> Any:
    """A stdlib-only module beside this script, shared with cad-viewer by path."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise InfraError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


material_rules = _load_sibling("cad_render_materials", MATERIALS_PY)
version_layout = _load_sibling("cad_render_versions", VERSIONS_PY)


# --------------------------------------------------------------------------- version inputs


@dataclass
class Version:
    label: str
    files: dict[str, Path]  # cad-model's version files, versions.FILES keys
    part_map: dict[str, Any]
    manifest: dict[str, Any]
    metrics: dict[str, Any]


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise InfraError(f"cannot read {path}: {exc}") from exc


def resolve_version(hw: Path, version: str) -> Version:
    try:
        found = version_layout.resolve(hw, version)
    except version_layout.VersionError as exc:
        raise InfraError(str(exc)) from exc
    files = found.files
    return Version(found.label, files, _json(files["part_map"]), _json(files["manifest"]), _json(files["metrics"]))


def part_records(hw: Path, pns: list[str]) -> dict[str, dict[str, Any]]:
    import yaml

    records = {}
    for pn in pns:
        path = hw / "parts" / pn / "part.yaml"
        try:
            record = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as exc:
            raise InfraError(f"{path}: {exc}") from exc
        if not isinstance(record, dict) or not record.get("material"):
            raise InfraError(f"{path}: no material")
        records[pn] = record
    return records


def load_assembly(hw: Path) -> tuple[dict[str, Any], bytes]:
    import yaml

    path = hw / "assembly.yaml"
    try:
        raw = path.read_bytes()
        data = yaml.safe_load(raw) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise InfraError(f"{path}: {exc}") from exc
    return data, raw


# --------------------------------------------------------------------------- geometry


Vec = tuple[float, float, float]


def _apply(t: list[list[float]], p: Vec) -> Vec:
    return tuple(t[r][0] * p[0] + t[r][1] * p[1] + t[r][2] * p[2] + t[r][3] for r in range(3))  # type: ignore[return-value]


def _rotate(t: list[list[float]], v: Vec) -> Vec:
    return tuple(t[r][0] * v[0] + t[r][1] * v[1] + t[r][2] * v[2] for r in range(3))  # type: ignore[return-value]


def _unit(v: Vec) -> Vec | None:
    n = math.sqrt(sum(c * c for c in v))
    return None if n < 1e-9 else (v[0] / n, v[1] / n, v[2] / n)


def to_glb(v: Vec, scale: float = 1.0) -> list[float]:
    """Assembly frame (+Z up, mm) to the cad-model GLB frame (+Y up): (x, z, -y) * scale."""
    return [v[0] * scale, v[2] * scale, -v[1] * scale]


def explode_offsets(joints: list[dict[str, Any]], root: str, transforms: dict[str, Any],
                    bboxes: dict[str, Any], toward: Vec) -> dict[str, Vec]:
    """Exploded offset per part (assembly mm), following the joint tree from `root`.

    A moving child slides out of its joint, along the unit vector from the posed joint origin
    to its posed bounding-box centre, by MOVABLE_GAP of its diagonal. A fixed child (pin,
    fastener) is pulled along its posed joint axis, on the side facing `toward`, by FIXED_GAP of
    its longest bounding-box side. Every child carries its parent's offset.
    """
    identity = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
    offsets: dict[str, Vec] = {root: (0.0, 0.0, 0.0)}
    children: dict[str, list[dict[str, Any]]] = {}
    for joint in joints:
        children.setdefault(joint["parent"], []).append(joint)
    stack = [root]
    while stack:
        parent = stack.pop()
        t_parent = transforms.get(parent, identity)
        for joint in children.get(parent, []):
            child = joint["child"]
            if child in offsets or child not in bboxes:
                continue
            box = bboxes[child]
            size = box["size"]
            axis = _unit(_rotate(t_parent, tuple(joint["axis"]))) or (0.0, 0.0, 1.0)
            if joint.get("type") == "fixed":
                sign = 1.0 if sum(a * b for a, b in zip(axis, toward)) >= 0 else -1.0
                step = tuple(sign * c * FIXED_GAP * max(size) for c in axis)
            else:
                origin = _apply(t_parent, tuple(joint["origin"]))
                centre = _apply(transforms.get(child, identity),
                                tuple((lo + hi) / 2 for lo, hi in zip(box["min"], box["max"])))
                outward = _unit(tuple(c - o for c, o in zip(centre, origin))) or axis
                gap = MOVABLE_GAP * math.sqrt(sum(s * s for s in size))
                step = tuple(c * gap for c in outward)
            offsets[child] = tuple(p + s for p, s in zip(offsets[parent], step))  # type: ignore[assignment]
            stack.append(child)
    return offsets


# --------------------------------------------------------------------------- quality


@dataclass(frozen=True)
class Frame:
    """An 8-bit RGBA frame (top-down rows), its class mask (0 empty, 1 other part, 2 subject),
    and its floor zones (FLOOR_RIM on part surface standing on the floor, FLOOR_OVERHUNG on floor
    under a part high above it, else 0), one byte per pixel each."""

    width: int
    height: int
    rgba: bytes
    mask: bytes
    floor: bytes

    def __post_init__(self) -> None:
        pixels = self.width * self.height
        if len(self.rgba) != pixels * 4 or len(self.mask) != pixels or len(self.floor) != pixels:
            raise ValueError("rgba must be width*height*4 bytes, mask and floor width*height bytes")


@dataclass
class Quality:
    passed: bool
    failures: list[str]
    warnings: list[str] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)


def _luma(r: int, g: int, b: int) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _near_class_rows(frame: Frame, radius: int, classes: set[int]) -> list[int]:
    """Per row, a bit mask of pixels within `radius` px of a selected mask class."""
    to_bits = bytes.maketrans(bytes(range(3)), bytes(ord("1") if i in classes else ord("0") for i in range(3)))
    w = frame.width
    rows = []
    for y in range(frame.height):
        line = frame.mask[y * w:(y + 1) * w].translate(to_bits)
        rows.append(int(line[::-1], 2) if b"1" in line else 0)
    wide = []
    for bits in rows:
        out = bits
        for s in range(1, radius + 1):
            out |= (bits << s) | (bits >> s)
        wide.append(out)
    near = []
    for y in range(frame.height):
        out = 0
        for dy in range(-radius, radius + 1):
            if 0 <= y + dy < frame.height:
                out |= wide[y + dy]
        near.append(out)
    return near


def _near_part_rows(frame: Frame, radius: int) -> list[int]:
    """Per row, a bit mask of pixels within `radius` px of any part pixel (bit x = column x)."""
    return _near_class_rows(frame, radius, {1, 2})

def _support_shadow(frame: Frame, subject: int) -> tuple[float, float]:
    """Measure contact shading near a close-up subject against support surface brightness."""
    w, h, rgba, mask = frame.width, frame.height, frame.rgba, frame.mask
    support_lumas = []
    for i, cls in enumerate(mask):
        if cls == 1:
            offset = i * 4
            support_lumas.append(_luma(rgba[offset], rgba[offset + 1], rgba[offset + 2]))
    if not support_lumas:
        return 0.0, 0.0
    support_lumas.sort()
    baseline = support_lumas[len(support_lumas) // 2]
    near_subject = _near_class_rows(frame, CONTACT_BAND_PX[1], {2})
    away_from_subject = _near_class_rows(frame, PART_CLEARANCE_PX, {2})
    shaded = []
    for y in range(0, h, SAMPLE_STRIDE):
        near = near_subject[y]
        clear = away_from_subject[y]
        for x in range(0, w, SAMPLE_STRIDE):
            i = y * w + x
            if mask[i] != 1 or not (near >> x) & 1 or (clear >> x) & 1:
                continue
            offset = i * 4
            luma = _luma(rgba[offset], rgba[offset + 1], rgba[offset + 2])
            if luma <= baseline - SHADOW_DELTA:
                shaded.append(luma)
    ratio = len(shaded) * SAMPLE_STRIDE * SAMPLE_STRIDE / subject if subject else 0.0
    shaded.sort()
    depth = baseline - shaded[len(shaded) // 50] if shaded else 0.0
    return ratio, depth

def _contact_lumas(frame: Frame) -> list[float]:
    """Luminance of the floor CONTACT_BAND_PX rows below each grounded-rim pixel whose column
    runs on as open floor (no part pixel) through the band: the rim's contact shadow."""
    w, h, rgba, mask = frame.width, frame.height, frame.rgba, frame.mask
    lo, hi = CONTACT_BAND_PX
    out = []
    for y in range(h - hi):
        row = frame.floor[y * w:(y + 1) * w]
        if FLOOR_RIM not in row:
            continue
        for x in range(w):
            if row[x] != FLOOR_RIM or any(mask[(y + d) * w + x] for d in range(1, hi + 1)):
                continue
            for d in range(lo, hi + 1):
                i = ((y + d) * w + x) * 4
                out.append(_luma(rgba[i], rgba[i + 1], rgba[i + 2]))
    return out


def assess(frame: Frame, *, closeup: bool = False, isolated: bool = False,
           visible_fraction: float | None = None) -> Quality:
    """Classify composition defects as unusable and shadow findings as cosmetic warnings."""
    w, h, rgba, mask = frame.width, frame.height, frame.rgba, frame.mask
    total = w * h
    subject = mask.count(2)
    parts = subject if isolated else subject + mask.count(1)

    samples = Counter()
    for y in range(0, h, SAMPLE_STRIDE):
        for x in range(0, w, SAMPLE_STRIDE):
            i = y * w + x
            if mask[i] == 0:
                samples[rgba[i * 4:i * 4 + 3]] += 1
    backdrop = samples.most_common(1)[0][0] if samples else bytes(3)
    bl = _luma(*backdrop)

    content = 0
    sampled = 0
    for y in range(0, h, SAMPLE_STRIDE):
        for x in range(0, w, SAMPLE_STRIDE):
            i = (y * w + x) * 4
            sampled += 1
            if max(abs(rgba[i] - backdrop[0]), abs(rgba[i + 1] - backdrop[1]), abs(rgba[i + 2] - backdrop[2])) > BACKDROP_TOLERANCE:
                content += 1
    content_cov = content / sampled
    subject_cov = subject / total

    edges = {
        "top": mask[:w].count(2),
        "bottom": mask[(h - 1) * w:].count(2),
        "left": sum(1 for y in range(h) if mask[y * w] == 2),
        "right": sum(1 for y in range(h) if mask[y * w + w - 1] == 2),
    }
    margins = None
    if subject:
        spans = [(y, row.find(2), row.rfind(2)) for y in range(h) if 2 in (row := mask[y * w:(y + 1) * w])]
        margins = {"top": spans[0][0], "bottom": h - 1 - spans[-1][0],
                   "left": min(s[1] for s in spans), "right": w - 1 - max(s[2] for s in spans)}

    near = _near_part_rows(frame, PART_CLEARANCE_PX)
    shadow_lumas = []
    overhung_lumas = []
    for y in range(0, h, SAMPLE_STRIDE):
        row_near = near[y]
        for x in range(0, w, SAMPLE_STRIDE):
            i = y * w + x
            if mask[i] or (row_near >> x) & 1:
                continue
            luma = _luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2])
            if luma <= bl - SHADOW_DELTA:
                shadow_lumas.append(luma)
            if frame.floor[i] == FLOOR_OVERHUNG:
                overhung_lumas.append(luma)
    shadow_px = len(shadow_lumas) * SAMPLE_STRIDE * SAMPLE_STRIDE
    shadow_ratio = shadow_px / (subject if closeup and subject else parts) if (subject or parts) else 0.0
    floor_depth = bl - shadow_lumas[len(shadow_lumas) // 50] if shadow_lumas else 0.0
    depth = floor_depth
    # Contact depth: the median of the band below grounded rims. Overhang depth: the shadow core
    # (2nd-percentile luminance) on floor under a part high above it.
    contact_lumas = sorted(_contact_lumas(frame))
    contact_depth = bl - contact_lumas[len(contact_lumas) // 2] if contact_lumas else None
    overhung_lumas.sort()
    overhang_depth = bl - overhung_lumas[len(overhung_lumas) // 50] if overhung_lumas else None
    support_ratio, support_depth = _support_shadow(frame, subject) if closeup else (0.0, 0.0)
    if closeup and support_ratio > shadow_ratio:
        shadow_ratio = support_ratio

    findings = []
    if subject_cov < MIN_SUBJECT_COVERAGE or content_cov < MIN_CONTENT_COVERAGE:
        findings.append("BLANK")
    else:
        if any(edges.values()):
            findings.append("CLIPPED")
        if closeup and visible_fraction is not None and visible_fraction < MIN_VISIBLE_FRACTION:
            findings.append("OCCLUDED")
        min_depth = SHADOW_DELTA if closeup or isolated else MIN_SHADOW_DEPTH
        floor_pass = (shadow_ratio >= MIN_SHADOW_RATIO and floor_depth >= min_depth) or (
            not closeup and not isolated and contact_depth is not None and contact_depth >= min_depth
        )
        support_pass = closeup and support_ratio >= 0.025 and support_depth >= SHADOW_DELTA
        if not floor_pass and not support_pass:
            findings.append("NO_SHADOW")
        if not isolated and contact_depth is not None and overhang_depth is not None and contact_depth <= overhang_depth:
            findings.append("INVERTED_SHADOW")
    failures = [finding for finding in findings if finding in UNUSABLE_FINDINGS]
    warnings = [finding for finding in findings if finding in WARNING_FINDINGS]
    metrics = {
        "backdrop_rgb": list(backdrop),
        "subject_coverage": round(subject_cov, 5),
        "content_coverage": round(content_cov, 5),
        "visible_subject_fraction": None if visible_fraction is None else round(visible_fraction, 5),
        "subject_edge_px": edges,
        "subject_margin_px": margins,
        "shadow_ratio": round(shadow_ratio, 4),
        "shadow_depth": round(depth, 1),
        "floor_shadow_depth": round(floor_depth, 1),
        "contact_depth": None if contact_depth is None else round(contact_depth, 1),
        "overhang_depth": None if overhang_depth is None else round(overhang_depth, 1),
        "support_shadow_ratio": round(support_ratio, 4),
        "support_shadow_depth": round(support_depth, 1),
        "thresholds": {"min_subject_coverage": MIN_SUBJECT_COVERAGE, "min_content_coverage": MIN_CONTENT_COVERAGE,
                       "min_visible_fraction": MIN_VISIBLE_FRACTION,
                       "min_shadow_ratio": 0.025 if closeup else MIN_SHADOW_RATIO,
                       "min_shadow_depth": SHADOW_DELTA if closeup or isolated else MIN_SHADOW_DEPTH,
                       "shadow_delta": SHADOW_DELTA, "contact_band_px": list(CONTACT_BAND_PX)},
    }
    return Quality(not failures, failures, warnings, metrics)



# --------------------------------------------------------------------------- scene and cache


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def renderer_sha256() -> str:
    digest = hashlib.sha256()
    for path in sorted([*RENDERER_DIR.rglob("*"), HERE, *STATIC.values()]):
        if path.is_file():
            digest.update(path.name.encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


def view_kind(name: str) -> str:
    """Return the scene behavior for a named view."""
    if name.startswith("closeup-"):
        return "closeup"
    if name.startswith("part-"):
        return "part"
    return name


def parse_views(tokens: list[str], pns: list[str]) -> list[str]:
    views = []
    for token in tokens:
        if not VIEW_NAME.match(token):
            raise InfraError(f"unknown view {token!r}; use iso, front, side, exploded, closeup-<PN>, or part-<PN>")
        if token.startswith(("closeup-", "part-")) and token.split("-", 1)[1] not in pns:
            raise InfraError(f"{token}: no part {token.split('-', 1)[1]} in this version")
        if token not in views:
            views.append(token)
    return views


def build_scene(hw: Path, version: Version, views: list[str], size: tuple[int, int],
                table: material_rules.MaterialTable) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Returns (scene payload for the page, materials per PN, cache key).

    The key's source hash covers every version file the scene reads (GLB, part map, manifest
    pose and ground, metrics bboxes) and assembly.yaml, whose joints shape the explode; part.yaml
    enters through the resolved materials."""
    parts_map = version.part_map["parts"]
    pns = sorted(parts_map)
    records = part_records(hw, pns)
    materials = {}
    for pn in pns:
        rec = records[pn]
        rule = table.resolve(str(rec["material"]), str(rec.get("finish") or ""))
        materials[pn] = {"part_material": rec["material"], "part_finish": rec.get("finish"),
                         "rule": rule.id, "label": rule.label, "pbr": rule.pbr}

    assembly, assembly_raw = load_assembly(hw)
    joints = [j for j in assembly.get("joints") or [] if j.get("parent") in parts_map and j.get("child") in parts_map]
    root = version.manifest.get("ground") or pns[0]
    offsets = explode_offsets(joints, root, version.manifest.get("pose", {}).get("transforms", {}),
                              {pn: version.metrics["parts"][pn]["bbox_mm"] for pn in pns},
                              DIRECTIONS["exploded"])
    view_specs = []
    for name in views:
        kind = view_kind(name)
        view_specs.append({"name": name, "direction": to_glb(DIRECTIONS[kind]),
                           "subject": [name.split("-", 1)[1]] if kind in {"closeup", "part"} else None,
                           "explode": kind == "exploded", "isolated": kind == "part"})
    scene = {
        "version": version.label,
        "glb": "/render/model.glb",
        "image": {"width": size[0], "height": size[1]},
        "parts": [{"pn": pn, "node_indices": parts_map[pn]["node_indices"],
                   "material": {"id": materials[pn]["rule"], "pbr": materials[pn]["pbr"]}} for pn in pns],
        "views": view_specs,
        "explode": {pn: to_glb(offsets[pn], 0.001) for pn in pns if pn in offsets},
    }
    assembly_sha = sha256(assembly_raw)
    sources = {name: sha256(version.files[name].read_bytes()) for name in SOURCE_FILES}
    key = {
        "source_sha256": sha256(canonical({**sources, "assembly_yaml": assembly_sha})),
        "materials_sha256": sha256(canonical({pn: [m["rule"], m["pbr"]] for pn, m in materials.items()})),
        "renderer_sha256": renderer_sha256(),
        "image": f"{size[0]}x{size[1]}",
    }
    extra = {"explode_offsets_mm": {pn: [round(c, 3) for c in offsets[pn]] for pn in pns if pn in offsets},
             "assembly_yaml_sha256": assembly_sha,
             "assembly_yaml_matches_version": assembly_sha == version.manifest.get("assembly_yaml_sha256")}
    return scene, materials, {"key": key, **extra}


def cache_hit(out_dir: Path, key: dict[str, Any], views: list[str]) -> dict[str, Any] | None:
    path = out_dir / "manifest.json"
    if not path.is_file():
        return None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None
    if manifest.get("status") not in {"pass", "warn"} or manifest.get("cache_key") != key:
        return None
    for view in views:
        entry = manifest.get("views", {}).get(view)
        png = out_dir / f"{view}.png"
        if not entry or not png.is_file() or sha256(png.read_bytes()) != entry.get("sha256"):
            return None
    return manifest


# --------------------------------------------------------------------------- server


def load_concept_serve() -> Any:
    spec = importlib.util.spec_from_file_location("cad_concept_serve", CONCEPT_SERVE)
    if spec is None or spec.loader is None:
        raise InfraError(f"cannot load {CONCEPT_SERVE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_server(scene: dict[str, Any], glb: Path, cache_dir: Path) -> ThreadingHTTPServer:
    serve = load_concept_serve()
    vendor = serve.VendorCache(cache_dir, serve.vendor_integrity(RENDERER_DIR / "index.html"))
    payload = {"/render/scene.json": (canonical(scene), CONTENT_TYPES[".json"]),
               "/render/model.glb": (glb.read_bytes(), CONTENT_TYPES[".glb"]),
               **{route: (path.read_bytes(), CONTENT_TYPES[path.suffix]) for route, path in STATIC.items()}}

    class Handler(BaseHTTPRequestHandler):
        server_version = "cad-render/1"

        def log_message(self, fmt: str, *args: object) -> None:
            pass

        def _send(self, status: HTTPStatus, body: bytes, ctype: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            path = unquote(urlsplit(self.path).path)
            if path in payload:
                self._send(HTTPStatus.OK, *payload[path])
                return
            if path.startswith("/vendor/"):
                try:
                    self._send(HTTPStatus.OK, vendor.get(path), CONTENT_TYPES[".js"])
                except LookupError:
                    self._send(HTTPStatus.NOT_FOUND, b"not a pinned module", "text/plain")
                except OSError as exc:
                    self._send(HTTPStatus.BAD_GATEWAY, str(exc).encode(), "text/plain")
                return
            file = (RENDERER_DIR / ("index.html" if path in ("", "/") else path.lstrip("/"))).resolve()
            if not file.is_relative_to(RENDERER_DIR) or not file.is_file():
                self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
                return
            self._send(HTTPStatus.OK, file.read_bytes(), CONTENT_TYPES.get(file.suffix, "application/octet-stream"))

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    return server


# --------------------------------------------------------------------------- render


def capture_views(url: str, views: list[str], size: tuple[int, int]) -> tuple[dict[str, Any], dict[str, Any], dict[str, float]]:
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import sync_playwright

    results: dict[str, Any] = {}
    timings: dict[str, float] = {}
    errors: list[str] = []
    started = time.monotonic()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=CHROMIUM_ARGS)
            try:
                page = browser.new_page(viewport={"width": size[0], "height": size[1]}, device_scale_factor=1)
                page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
                page.on("console", lambda msg: msg.type == "error" and errors.append(f"console: {msg.text}"))
                timings["browser_start_s"] = round(time.monotonic() - started, 3)
                page.goto(url, wait_until="load")
                # index.html marks the body `error` when render.js or a pinned module fails to load,
                # and window.cadRender then never appears: stop waiting at once and say why.
                page.wait_for_function("window.cadRender !== undefined || document.body.dataset.state === 'error'",
                                       timeout=BOOT_TIMEOUT_MS)
                if page.evaluate("window.cadRender === undefined"):
                    raise InfraError(f"renderer page did not start: {page.text_content('#status')}; "
                                     f"page errors: {errors}")
                info = page.evaluate("window.cadRender.ready")
                timings["load_s"] = round(time.monotonic() - started - timings["browser_start_s"], 3)
                info["chromium"] = browser.version
                for view in views:
                    t0 = time.monotonic()
                    results[view] = page.evaluate("name => window.cadRender.capture(name)", view)
                    timings[view] = round(time.monotonic() - t0, 3)
            finally:
                browser.close()
    except PlaywrightError as exc:
        raise InfraError(f"browser: {exc.message}; page errors: {errors}") from exc
    if errors:
        raise InfraError(f"renderer page reported errors: {errors}")
    if info.get("unmapped_meshes"):
        raise InfraError(f"GLB meshes owned by no part-map PN: {info['unmapped_meshes']}")
    return info, results, timings


def camera_record(camera: dict[str, Any]) -> dict[str, Any]:
    def asm(v: list[float]) -> list[float]:
        return [round(v[0] * 1000, 2), round(-v[2] * 1000, 2), round(v[1] * 1000, 2)]

    return {"position_mm": asm(camera["position"]), "target_mm": asm(camera["target"]),
            "up": [round(camera["up"][0], 4), round(-camera["up"][2], 4), round(camera["up"][1], 4)],
            "fov_deg": camera["fov_deg"], "aspect": round(camera["aspect"], 4),
            "frame": "assembly (mm, +Z up)"}


def grade(results: dict[str, Any]) -> tuple[dict[str, Any], dict[str, bytes], bool]:
    """Per-view manifest records and PNG bytes; every frame graded from its own pixels."""
    views: dict[str, Any] = {}
    pngs: dict[str, bytes] = {}
    passed = True
    for name, r in results.items():
        header, _, b64 = r["png"].partition(",")
        if header != "data:image/png;base64":
            raise InfraError(f"view {name}: capture is not a PNG data URL")
        pngs[name] = base64.b64decode(b64)
        frame = Frame(r["width"], r["height"], *(base64.b64decode(r[k]) for k in ("rgba", "mask", "floor")))
        quality = assess(frame, closeup=view_kind(name) == "closeup", isolated=view_kind(name) == "part")
        passed &= quality.passed
        views[name] = {"png": f"{name}.png", "sha256": sha256(pngs[name]), "subject": r["subject"],
                       "explode": r["explode"], "camera": camera_record(r["camera"]),
                       "quality": {"status": "pass" if quality.passed else "fail",
                                   "failures": quality.failures, **quality.metrics},
                       "page_render_ms": r["render_ms"]}
    return views, pngs, passed


def publish(out_dir: Path, pngs: dict[str, bytes], manifest: dict[str, Any]) -> None:
    """Write into a hidden partial folder, then swap it in for any previous render set."""
    stamp = time.monotonic_ns()
    partial = out_dir.parent / f".{out_dir.name}.partial-{stamp}"
    old = out_dir.parent / f".{out_dir.name}.old-{stamp}"
    partial.mkdir(parents=True)
    try:
        for name, data in pngs.items():
            (partial / f"{name}.png").write_bytes(data)
        (partial / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        if out_dir.exists():
            out_dir.rename(old)
        partial.rename(out_dir)
    except OSError as exc:
        shutil.rmtree(partial, ignore_errors=True)
        raise InfraError(f"cannot write {out_dir}: {exc}") from exc
    shutil.rmtree(old, ignore_errors=True)


def parse_size(text: str) -> tuple[int, int]:
    match = SIZE.match(text)
    if not match:
        raise InfraError(f"--size must be WIDTHxHEIGHT (100-9999 px), got {text!r}")
    return int(match.group(1)), int(match.group(2))


def default_cache_dir() -> Path:
    return load_concept_serve().default_cache_dir()


def run(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    wall = time.monotonic()
    hw = args.hw.resolve()
    size = parse_size(args.size)
    version = resolve_version(hw, args.version)
    views = parse_views(args.views, sorted(version.part_map["parts"]))
    try:
        table = material_rules.MaterialTable.load()
    except material_rules.MaterialsError as exc:
        raise InfraError(str(exc)) from exc
    scene, materials, keyed = build_scene(hw, version, views, size, table)
    out_dir = hw / "renders" / version.label

    if not args.force:
        hit = cache_hit(out_dir, keyed["key"], views)
        if hit is not None:
            return 0, {"status": "pass", "cache": "hit", "version": version.label, "out_dir": str(out_dir),
                       "pngs": {v: str(out_dir / f"{v}.png") for v in views},
                       "wall_s": round(time.monotonic() - wall, 3),
                       "rendered_wall_s": hit.get("wall_s", {}).get("total_s")}

    server = make_server(scene, version.files["glb"], args.cache_dir or default_cache_dir())
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        info, results, timings = capture_views(f"http://127.0.0.1:{port}/", views, size)
    finally:
        server.shutdown()
        server.server_close()

    view_records, pngs, passed = grade(results)
    for name, record in view_records.items():
        record["wall_s"] = timings[name]
    for pn, record in materials.items():
        record["applied"] = results[views[0]]["materials"][pn]
    manifest = {
        "version": version.label,
        "status": "pass" if passed else "fail",
        "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "views": view_records,
        "materials": materials,
        "renderer": {"name": "cad-render three.js PBR", "three": THREE_VERSION, "three_revision": info["three"],
                     "playwright": importlib.metadata.version("playwright"), "chromium": info["chromium"],
                     "webgl": "SwiftShader (ANGLE)", "studio": info["studio"]},
        "image": {"width": size[0], "height": size[1]},
        "cache_key": keyed["key"],
        "inputs": {**{name: str(version.files[name].relative_to(hw)) for name in SOURCE_FILES},
                   "assembly_yaml_sha256": keyed["assembly_yaml_sha256"],
                   "assembly_yaml_matches_version": keyed["assembly_yaml_matches_version"]},
        "explode_offsets_mm": keyed["explode_offsets_mm"],
        "server_port": port,
        "wall_s": {**{k: v for k, v in timings.items() if k.endswith("_s")},
                   "total_s": round(time.monotonic() - wall, 3)},
    }
    publish(out_dir, pngs, manifest)
    summary = {"status": manifest["status"], "cache": "miss", "version": version.label, "out_dir": str(out_dir),
               "pngs": {v: str(out_dir / f"{v}.png") for v in views},
               "failures": {v: r["quality"]["failures"] for v, r in view_records.items() if r["quality"]["failures"]},
               "wall_s": manifest["wall_s"], "view_wall_s": timings}
    return (0 if passed else 1), summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="render.py", description=__doc__.splitlines()[0])
    parser.add_argument("hw", type=Path, help="the project's hw/ directory")
    parser.add_argument("--version", default="latest", help="latest or vN")
    parser.add_argument("--views", nargs="+", default=DEFAULT_VIEWS,
                        help="iso front side exploded closeup-<PN> part-<PN> (default: iso front side exploded)")
    parser.add_argument("--size", default="1600x1200", help="frame size WIDTHxHEIGHT")
    parser.add_argument("--force", action="store_true", help="render even when the cache matches")
    parser.add_argument("--cache-dir", type=Path, help="pinned three.js module cache (default: cad-concept's)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    try:
        code, summary = run(args)
    except InfraError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}))
        return 2
    except Exception as exc:  # an unexpected failure is infrastructure, never a quality verdict
        print(json.dumps({"status": "error", "error": f"{type(exc).__name__}: {exc}"}))
        return 2
    print(json.dumps(summary, indent=2))
    return code


if __name__ == "__main__":
    sys.exit(main())
