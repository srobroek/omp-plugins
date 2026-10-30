#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "playwright==1.64.1",
#     "pyyaml>=6.0",
# ]
# ///
"""Render verified cad-model versions to product PNG bundles via the static three.js PBR page.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-render/scripts/render.py HW [--version latest|vN] [--views iso front side exploded] [--subject S]
        [--size 1600x1200] [--jobs N] [--cache-dir DIR] [--replace] [--out-dir .cad-work/PATH]
    uv run --script skill://cad-flow/scripts/run.py cad-render/scripts/render.py HW --version vN --motion SPEC.json
        --out-dir .cad-work/PATH [--size 1280x720] [--cache-dir DIR]

Resolves a verified built version through cad-record's layout API, maps each part's part.yaml
material and finish to a MeshPhysicalMaterial through assets/materials.json, serves assets/renderer/
with the version GLB, and drives headless Chromium (SwiftShader WebGL) with Playwright. Published
renders are immutable bundles at HW/renders/<version>/<subject>/; explicit output directories are
scratch-only under .cad-work/.

Scene objects are occurrences: one per placed instance, with its own GLB node; materials stay per
PN. A close-up or part view names one occurrence: `closeup-@ring-head`, or `closeup-LMP-0004` for a
PN placed once; a bare PN placed several times is ambiguous and refused.

Each frame is graded from its pixels and subject mask. BLANK, CLIPPED, and close-up OCCLUDED (less than 25% of the subject's isolated visible pixels remain visible) make a view unusable; NO_SHADOW and INVERTED_SHADOW are cosmetic warnings and keep the PNG.
A verified bundle for an identical recipe is reused, including with `--replace`; `--replace` only renders again when the recipe differs.

Motion frames (`--motion`, written by cad-motion motion.py render): every spec frame moves each
occurrence by a rigid delta from the version's built pose; cad-render derives no kinematics. One
camera per group of frames, fitted to the bounds the group sweeps, so the framing holds while the
parts move; the floor shadow is left out (its bake costs 128 shadow maps per pose). It writes
frames/frame-NNNN.png, contact-sheet.png and motion-render.json (cameras, and the parity of the node
world placements against the spec's expected ones within 1e-9) into --out-dir; motion.py publishes
them. Exit 1 = a parity failure.

stdout: one JSON summary. Exit 0 = every view is usable (pass or warn, including cache hits), 1 = an unusable view remains after its retry ladder (renders and manifest are still written), 2 = usage or infrastructure error (nothing written).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import importlib.metadata
import importlib.util
import inspect
import os
import json
import math
import re
import sys
import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve()
_parity_spec = importlib.util.spec_from_file_location("cad_render_parity_policy", HERE.parent / "parity_policy.py")
if _parity_spec is None or _parity_spec.loader is None:
    raise RuntimeError(f"cannot load {HERE.parent / 'parity_policy.py'}")
parity_policy = importlib.util.module_from_spec(_parity_spec)
_parity_spec.loader.exec_module(parity_policy)
SKILL = HERE.parent.parent
RENDERER_DIR = SKILL / "assets" / "renderer"
MATERIALS_PY = HERE.parent / "materials.py"
VERSIONS_PY = HERE.parent / "versions.py"  # occurrence normalization only; paths belong to cad-record.
LAYOUT_PY = SKILL.parent / "cad-record" / "scripts" / "layout.py"
CONCEPT_SERVE = SKILL.parent / "cad-concept" / "scripts" / "serve.py"
# The page chrome tokens (status line) are cad-concept's; renderer/tokens.css holds the scene's.
CONCEPT_TOKENS = SKILL.parent / "cad-concept" / "assets" / "viewer" / "tokens.css"
THREE_VERSION = "0.186.1"
CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
                 *( ["--num-raster-threads=1"] if os.environ.get("CAD_RENDER_RASTER_THREADS") == "1" else [])]
BOOT_TIMEOUT_MS = 180_000
VIEW_NAME = re.compile(r"^(iso|front|side|exploded|(closeup|part)-([A-Z]{2,5}-[0-9]{4}|@[a-z][a-z0-9_-]*))$")
SIZE = re.compile(r"^([1-9][0-9]{2,3})x([1-9][0-9]{2,3})$")
DEFAULT_VIEWS = ["iso", "front", "side", "exploded"]
DEFAULT_JOBS = 1
MAX_JOBS = 8
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".json": "application/json", ".glb": "model/gltf-binary"}
STATIC = {"/concept-tokens.css": CONCEPT_TOKENS}  # served beside assets/renderer/, outside it
SOURCE_FILES = ("glb", "part_map", "manifest", "metrics")  # version files the scene reads: cache key, inputs


def _load_layout() -> Any:
    name = "cad_record_layout"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, LAYOUT_PY)
        if spec is None or spec.loader is None:
            raise InfraError(f"cannot load {LAYOUT_PY}")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


layout = _load_layout()
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
version_reader = _load_sibling("cad_render_versions", VERSIONS_PY)


# --------------------------------------------------------------------------- version inputs


@dataclass
class Version:
    label: str
    folder: Path
    record: Path
    files: dict[str, Path]
    part_map: dict[str, Any]
    manifest: dict[str, Any]
    metrics: dict[str, Any]
    occurrences: dict[str, Any]


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise InfraError(f"cannot read {path}: {exc}") from exc


def resolve_version(hw: Path, requested: str) -> Version:
    try:
        built = layout.built_version(hw, requested)
    except layout.LayoutError as exc:
        raise InfraError(str(exc)) from exc
    return load_version(hw, built)


def load_version(hw: Path, built: tuple[str, Path, Path]) -> Version:
    label, folder, record = built
    files = {"assembly_step": folder / "assembly.step", "glb": folder / "assembly.glb",
             "metrics": folder / "metrics.json", "part_map": folder / "part-map.json",
             "manifest": folder / "manifest.json"}
    missing = [str(path) for path in files.values() if not path.is_file()]
    if missing:
        raise InfraError(f"{label} is missing renderer inputs {missing}")
    part_map, manifest = _json(files["part_map"]), _json(files["manifest"])
    try:
        version_reader.validate_version_manifest(manifest)
        occurrences = version_reader.built_occurrences(part_map, manifest)
    except version_reader.VersionError as exc:
        raise InfraError(f"{label}: {exc}") from exc
    return Version(label, folder, record, files, part_map, manifest, _json(files["metrics"]), occurrences)
def record_yaml(path: Path) -> dict[str, Any]:
    import yaml
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise InfraError(f"{path}: {exc}") from exc
    if not isinstance(value, dict):
        raise InfraError(f"{path}: expected a YAML mapping")
    return value



def part_records(record_dir: Path, pns: list[str]) -> dict[str, dict[str, Any]]:
    records = {}
    for pn in pns:
        path = record_dir / "parts" / pn / "part.yaml"
        record = record_yaml(path)
        if not record.get("material"):
            raise InfraError(f"{path}: no material")
        records[pn] = record
    return records


def load_assembly(record_dir: Path) -> tuple[dict[str, Any], bytes]:
    path = record_dir / "assembly.yaml"
    try:
        raw = path.read_bytes()
        data = record_yaml(path)
    except OSError as exc:
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


def explode_offsets(joints: list[dict[str, Any]], root: str, motions: dict[str, Any], transforms: dict[str, Any],
                    bboxes: dict[str, Any], toward: Vec) -> dict[str, Vec]:
    """Exploded offset per occurrence (assembly mm), following the joint tree from `root`.

    Joint axes and origins are in the zero-pose assembly frame, so the parent's motion D (not its
    placement T = D P) carries them; `bboxes` are in each definition's frame, so the child's
    placement T carries its centre. A moving child slides out of its joint, along the unit vector
    from the posed joint origin to its posed bounding-box centre, by MOVABLE_GAP of its diagonal.
    A fixed child (pin, fastener) is pulled along its posed joint axis, on the side facing
    `toward`, by FIXED_GAP of its longest bounding-box side. Every child carries its parent's offset.
    """
    identity = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
    offsets: dict[str, Vec] = {root: (0.0, 0.0, 0.0)}
    children: dict[str, list[dict[str, Any]]] = {}
    for joint in joints:
        children.setdefault(joint["parent"], []).append(joint)
    stack = [root]
    while stack:
        parent = stack.pop()
        d_parent = motions.get(parent, identity)
        for joint in children.get(parent, []):
            child = joint["child"]
            if child in offsets or child not in bboxes:
                continue
            box = bboxes[child]
            size = box["size"]
            axis = _unit(_rotate(d_parent, tuple(joint["axis"]))) or (0.0, 0.0, 1.0)
            if joint.get("type") == "fixed":
                sign = 1.0 if sum(a * b for a, b in zip(axis, toward)) >= 0 else -1.0
                step = tuple(sign * c * FIXED_GAP * max(size) for c in axis)
            else:
                origin = _apply(d_parent, tuple(joint["origin"]))
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


def view_subject(name: str, occurrences: dict[str, str]) -> str:
    """The occurrence id a close-up or part view names: `@id`, or a PN placed exactly once.

    `occurrences` maps occurrence id -> PN; a legacy singleton's id is its PN, an explicit id never is."""
    kind, ref = name.split("-", 1)
    if ref.startswith("@"):
        if occurrences.get(ref[1:], ref[1:]) != ref[1:]:
            return ref[1:]
        raise InfraError(f"{name}: no occurrence {ref} in this version")
    found = [oid for oid, pn in occurrences.items() if pn == ref]
    if len(found) == 1:
        return found[0]
    if not found:
        raise InfraError(f"{name}: no part {ref} in this version")
    raise InfraError(f"{name}: {ref} is placed {len(found)} times; name one: "
                     + ", ".join(f"{kind}-@{oid}" for oid in found))


def parse_views(tokens: list[str], occurrences: dict[str, str]) -> list[str]:
    """The requested views, deduplicated; a close-up or part view must name one occurrence (`view_subject`)."""
    views = []
    for token in tokens:
        if not VIEW_NAME.match(token):
            raise InfraError(f"unknown view {token!r}; use iso, front, side, exploded, closeup-<REF>, or part-<REF> "
                             "with REF a PN placed once or @occurrence")
        if token.startswith(("closeup-", "part-")):
            view_subject(token, occurrences)
        if token not in views:
            views.append(token)
    return views


def build_scene(hw: Path, version: Version, views: list[str], size: tuple[int, int],
                table: material_rules.MaterialTable) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Returns (scene payload for the page, materials per PN, cache key).

    Scene parts are occurrences, keyed by occurrence id; materials are per PN. The key's source
    hash covers every version file the scene reads (GLB, part map, manifest pose, joints and
    ground, metrics bboxes) and assembly.yaml, whose joints shape a version 1 explode; part.yaml
    enters through the resolved materials."""
    occurrences = {oid: version.occurrences[oid] for oid in sorted(version.occurrences)}
    pns = sorted({o.pn for o in occurrences.values()})
    records = part_records(version.record, pns)
    materials = {}
    for pn in pns:
        rec = records[pn]
        rule = table.resolve(str(rec["material"]), str(rec.get("finish") or ""))
        materials[pn] = {"part_material": rec["material"], "part_finish": rec.get("finish"),
                         "rule": rule.id, "label": rule.label, "pbr": rule.pbr}

    assembly, assembly_raw = load_assembly(version.record)
    try:
        joints = version_reader.built_joints(version.manifest, assembly.get("joints") or [])
    except version_reader.VersionError as exc:
        raise InfraError(f"{version.label}: {exc}") from exc
    joints = [j for j in joints if j.get("parent") in occurrences and j.get("child") in occurrences]
    root = version.manifest.get("ground") or next(iter(occurrences))
    offsets = explode_offsets(joints, root, {oid: o.motion for oid, o in occurrences.items()},
                              {oid: o.transform for oid, o in occurrences.items()},
                              {oid: version.metrics["parts"][o.pn]["bbox_mm"] for oid, o in occurrences.items()},
                              DIRECTIONS["exploded"])
    by_pn = {oid: o.pn for oid, o in occurrences.items()}
    view_specs = []
    for name in views:
        kind = view_kind(name)
        view_specs.append({"name": name, "direction": to_glb(DIRECTIONS[kind]),
                           "subject": [view_subject(name, by_pn)] if kind in {"closeup", "part"} else None,
                           "explode": kind == "exploded", "isolated": kind == "part"})
    scene = {
        "version": version.label,
        "glb": "/render/model.glb",
        "image": {"width": size[0], "height": size[1]},
        "parts": [{"id": oid, "pn": o.pn, "ref": o.ref, "node_indices": list(o.node_indices),
                   "material": {"id": materials[o.pn]["rule"], "pbr": materials[o.pn]["pbr"]}}
                  for oid, o in occurrences.items()],
        "views": view_specs,
        "explode": {oid: to_glb(offsets[oid], 0.001) for oid in occurrences if oid in offsets},
    }
    assembly_sha = sha256(assembly_raw)
    sources = {name: sha256(version.files[name].read_bytes()) for name in SOURCE_FILES}
    key = {
        "source_sha256": sha256(canonical({**sources, "assembly_yaml": assembly_sha})),
        "materials_sha256": sha256(canonical({pn: [m["rule"], m["pbr"]] for pn, m in materials.items()})),
        "renderer_sha256": renderer_sha256(),
        "image": f"{size[0]}x{size[1]}",
        "parity": parity_policy.cache_key(),
    }
    extra = {"explode_offsets_mm": {oid: [round(c, 3) for c in offsets[oid]] for oid in occurrences if oid in offsets},
             "assembly_yaml_sha256": assembly_sha,
             "assembly_yaml_matches_version": assembly_sha == version.manifest.get("assembly_yaml_sha256")}
    return scene, materials, {"key": key, **extra}

def cache_hit(out_dir: Path, key: dict[str, Any], views: list[str]) -> dict[str, Any] | None:
    """A cache hit requires a verified published bundle and every requested PNG hash."""
    if layout.verify(out_dir):
        return None
    path = out_dir / "render.json"
    if not path.is_file():
        return None
    try:
        metadata = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if metadata.get("status") not in {"pass", "warn"} or metadata.get("cache_key") != key:
        return None
    for view in views:
        entry = metadata.get("views", {}).get(view)
        png = out_dir / f"{view}.png"
        if not entry or not png.is_file() or sha256(png.read_bytes()) != entry.get("sha256"):
            return None
    return metadata




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



def camera_record(camera: dict[str, Any]) -> dict[str, Any]:
    def asm(v: list[float]) -> list[float]:
        return [round(v[0] * 1000, 2), round(-v[2] * 1000, 2), round(v[1] * 1000, 2)]

    return {"position_mm": asm(camera["position"]), "target_mm": asm(camera["target"]),
            "up": [round(camera["up"][0], 4), round(-camera["up"][2], 4), round(camera["up"][1], 4)],
            "fov_deg": camera["fov_deg"], "aspect": round(camera["aspect"], 4),
            "frame": "assembly (mm, +Z up)"}


def _frame_from_capture(result: dict[str, Any]) -> Frame:
    if not result.get("png", "").startswith("data:image/png;base64,"):
        raise InfraError(f"view {result.get('view', '?')}: capture is not a PNG data URL")
    def pixels(key: str) -> bytes:
        value = result[key]
        return base64.b64decode(value) if isinstance(value, str) else value
    return Frame(result["width"], result["height"], *(pixels(key) for key in ("rgba", "mask", "floor")))


async def _capture_attempt(page: Any, name: str, options: dict[str, Any], attempt: int) -> dict[str, Any]:
    return await page.evaluate("({name, options, attempt}) => window.cadRender.capture(name, options, attempt)",
                               {"name": name, "options": options, "attempt": attempt})


async def _retry_view(name: str, capture: Callable[[dict[str, Any], int], Any]) -> tuple[dict[str, Any], Quality, list[dict[str, Any]]]:
    attempts: list[dict[str, Any]] = []
    capture_wall_ms = render_ms = encode_ms = 0.0
    closeup = view_kind(name) == "closeup"
    isolated = view_kind(name) == "part"

    attempt_index = 0

    async def attempt(strategy: str, options: dict[str, Any] | None = None) -> tuple[dict[str, Any], Quality]:
        nonlocal capture_wall_ms, render_ms, encode_ms, attempt_index
        started = time.monotonic()
        captured = capture(options or {}, attempt_index)
        attempt_index += 1
        result = await captured if inspect.isawaitable(captured) else captured
        capture_wall_ms += (time.monotonic() - started) * 1000
        render_ms += float(result.get("render_ms", 0))
        encode_ms += float(result.get("encode_ms", 0))
        quality = assess(_frame_from_capture(result), closeup=closeup and not bool(options and options.get("isolated")),
                         isolated=isolated or bool(options and options.get("isolated")),
                         visible_fraction=result.get("visible_subject_fraction"))
        attempts.append({"strategy": strategy, "camera": camera_record(result["camera"]),
                         "camera_options": options or {}, "metrics": quality.metrics,
                         "failures": quality.failures, "warnings": quality.warnings})
        return result, quality

    result, quality = await attempt("original")
    strategy = "original"
    if quality.failures and closeup:
        candidates = [(result, quality, {}, "original")]
        for direction in ALTERNATE_CLOSEUP_DIRECTIONS:
            options = {"direction": to_glb(direction), "frameScale": 1.0}
            candidate, candidate_quality = await attempt("alternate-camera", options)
            candidates.append((candidate, candidate_quality, options, "alternate-camera"))
        result, quality, best_options, strategy = max(
            candidates, key=lambda item: (not item[1].failures,
                                          item[0].get("visible_subject_fraction", 0) or 0))
        if quality.failures:
            result, quality = await attempt("ghosted-context", {**best_options, "ghost": True})
            strategy = "ghosted-context"
        if quality.failures:
            result, quality = await attempt("isolated-part", {"isolated": True})
            strategy = "isolated-part"
            result["retry_note"] = "Context close-up unusable after alternate cameras and ghosted context; isolated component shown instead."
    elif quality.failures:
        if "CLIPPED" in quality.failures:
            result, quality = await attempt("reframe", {"frameScale": 0.8})
            strategy = "reframe"
        if quality.failures and "BLANK" in quality.failures:
            result, quality = await attempt("blank-retry", {"direction": to_glb(DIRECTIONS[view_kind(name)])})
            strategy = "blank-retry"
    result["retry"] = {"strategy": strategy, "attempts": attempts}
    result["_capture_timing_ms"] = {"playwright_call": round(capture_wall_ms, 1),
                                     "renderer": round(render_ms, 1), "png_encode": round(encode_ms, 1)}
    return result, quality, attempts


async def _open_capture_page(browser_context: Any, url: str, errors: list[str]) -> tuple[Any, dict[str, Any]]:
    page = await browser_context.new_page()
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
    page.on("console", lambda msg: errors.append(f"console: {msg.text}") if msg.type == "error" else None)
    await page.goto(url, wait_until="load")
    await page.wait_for_function("window.cadRender !== undefined || document.body.dataset.state === 'error'",
                                 timeout=BOOT_TIMEOUT_MS)
    if await page.evaluate("window.cadRender === undefined"):
        raise InfraError(f"renderer page did not start: {await page.text_content('#status')}; page errors: {errors}")
    return page, await page.evaluate("window.cadRender.ready")


async def _capture_page_views(page: Any, names: list[str]) -> tuple[dict[str, Any], dict[str, float]]:
    results: dict[str, Any] = {}
    timings: dict[str, float] = {}
    for name in names:
        t0 = time.monotonic()
        result, quality, _ = await _retry_view(name, lambda options, attempt: _capture_attempt(page, name, options, attempt))
        result["_quality"] = quality
        results[name] = result
        timings[name] = round(time.monotonic() - t0, 3)
    return results, timings


def capture_views(url: str, views: list[str], size: tuple[int, int], jobs: int = DEFAULT_JOBS) -> tuple[dict[str, Any], dict[str, Any], dict[str, float]]:
    import asyncio
    from playwright.async_api import Error as PlaywrightError
    from playwright.async_api import async_playwright

    if not 1 <= jobs <= MAX_JOBS:
        raise InfraError(f"--jobs must be between 1 and {MAX_JOBS}")
    results: dict[str, Any] = {}
    timings: dict[str, float] = {}
    errors: list[str] = []
    info: dict[str, Any] = {}
    started = time.monotonic()

    async def capture() -> None:
        nonlocal info

        async def collect(awaitables: list[Any]) -> list[Any]:
            tasks = [asyncio.create_task(awaitable) for awaitable in awaitables]
            try:
                return await asyncio.gather(*tasks)
            except BaseException:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                raise

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=CHROMIUM_ARGS)
            browser_context = await browser.new_context(
                viewport={"width": size[0], "height": size[1]}, device_scale_factor=1)
            try:
                timings["browser_start_s"] = round(time.monotonic() - started, 3)
                worker_count = min(jobs, len(views))
                chunks = [views[index::worker_count] for index in range(worker_count)]
                load_started = time.monotonic()
                pages = await collect([_open_capture_page(browser_context, url, errors) for _ in chunks])
                timings["load_s"] = round(time.monotonic() - load_started, 3)
                worker_results = await collect([_capture_page_views(page, chunk)
                                                for (page, _), chunk in zip(pages, chunks)])
                info = pages[0][1]
                info["chromium"] = browser.version
                for name in views:
                    for group_results, group_timings in worker_results:
                        if name in group_results:
                            results[name] = group_results[name]
                            timings[name] = group_timings[name]
                            break
            finally:
                await browser_context.close()
                await browser.close()
    try:
        asyncio.run(capture())
    except PlaywrightError as exc:
        raise InfraError(f"browser: {exc.message}; page errors: {errors}") from exc
    if errors:
        raise InfraError(f"renderer page reported errors: {errors}")
    if info.get("unmapped_meshes"):
        raise InfraError(f"GLB meshes owned by no part-map PN: {info['unmapped_meshes']}")
    return info, results, timings


def grade(results: dict[str, Any]) -> tuple[dict[str, Any], dict[str, bytes], bool]:
    """Per-view manifest records and PNG bytes; every frame graded from its own pixels."""
    views: dict[str, Any] = {}
    pngs: dict[str, bytes] = {}
    passed = True
    for name, result in results.items():
        _, _, b64 = result["png"].partition(",")
        pngs[name] = base64.b64decode(b64)
        quality: Quality = result["_quality"]
        passed &= quality.passed
        views[name] = {
            "png": f"{name}.png", "sha256": sha256(pngs[name]), "subject": result["subject"],
            "explode": result["explode"], "camera": camera_record(result["camera"]),
            "retry": result["retry"],
            "quality": {"status": "fail" if quality.failures else ("warn" if quality.warnings else "pass"),
                        "failures": quality.failures, "warnings": quality.warnings, **quality.metrics},
            "capture_ms": result["_capture_timing_ms"],
            "page_render_ms": result["render_ms"],
        }
        if result.get("retry_note"):
            views[name]["retry"]["note"] = result["retry_note"]
    return views, pngs, passed


# --------------------------------------------------------------------------- motion frames

MOTION_CAMERAS = ("iso", "front", "side")  # the directions a motion plan segment may name
PARITY_TOL = 1e-9  # m, and per quaternion component: a node's world placement against the spec's


def _indices(value: Any, count: int, where: str) -> list[int]:
    if not isinstance(value, list) or not all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < count
                                              for i in value):
        raise InfraError(f"{where} must list frame indices 0..{count - 1}")
    return value


def motion_spec(path: Path, version: Version) -> dict[str, Any]:
    """A cad-motion motion.py frames spec, checked against the version it was planned on.

    `frames[i].deltas` moves every occurrence by a rigid delta from the built pose (GLB metres,
    translation and quaternion); `groups` share one camera (`camera` view, fitted over the `fit`
    frames) and render their `render` frames; `check` holds the expected node world placements of a
    few frames; `sheet` lays out the contact sheet tiles, each a rendered frame and two caption lines."""
    spec = _json(path)
    if not isinstance(spec, dict) or spec.get("schema") != 1:
        raise InfraError(f"{path}: not a cad-motion motion spec (schema 1)")
    if spec.get("version") != version.label:
        raise InfraError(f"{path} was planned on {spec.get('version')!r}, not {version.label}")
    frames, groups, sheet = spec.get("frames"), spec.get("groups"), spec.get("sheet")
    if not isinstance(frames, list) or not frames or not isinstance(groups, list) or not groups \
            or not isinstance(sheet, dict):
        raise InfraError(f"{path}: a motion spec needs frames, groups and sheet")
    occurrences = set(version.occurrences)
    for index, frame in enumerate(frames):
        deltas = frame.get("deltas") if isinstance(frame, dict) else None
        if not isinstance(deltas, dict) or set(deltas) != occurrences:
            raise InfraError(f"{path}: frame {index} must move exactly the version's occurrences")
    rendered: list[int] = []
    for number, group in enumerate(groups):
        if not isinstance(group, dict) or group.get("camera") not in MOTION_CAMERAS or not group.get("id"):
            raise InfraError(f"{path}: groups[{number}] needs an id and a camera in {list(MOTION_CAMERAS)}")
        if not _indices(group.get("fit"), len(frames), f"groups[{number}].fit"):
            raise InfraError(f"{path}: groups[{number}].fit is empty")
        rendered += _indices(group.get("render"), len(frames), f"groups[{number}].render")
    if len(set(rendered)) != len(rendered):
        raise InfraError(f"{path}: a frame is rendered by two groups")
    tiles = sheet.get("tiles")
    if not isinstance(tiles, list) or not all(isinstance(t, dict) and t.get("frame") in rendered
                                              and isinstance(t.get("lines"), list) and len(t["lines"]) == 2
                                              for t in tiles):
        raise InfraError(f"{path}: every sheet tile needs a rendered frame and two caption lines")
    if not isinstance(sheet.get("columns"), int) or not isinstance(sheet.get("tile_width"), int):
        raise InfraError(f"{path}: sheet needs integer columns and tile_width")
    check = spec.get("check") or {}
    if not isinstance(check, dict) or any(not key.isdigit() or int(key) not in rendered
                                          or set(value) != occurrences for key, value in check.items()):
        raise InfraError(f"{path}: check must map rendered frame indices to every occurrence's placement")
    return spec


def _png(data_url: str, what: str) -> bytes:
    if not data_url.startswith("data:image/png;base64,"):
        raise InfraError(f"{what}: the page returned no PNG data URL")
    return base64.b64decode(data_url.partition(",")[2])


def capture_motion(url: str, spec: dict[str, Any], size: tuple[int, int], out_dir: Path) -> dict[str, Any]:
    """Render every group's frames to disk, retaining hashes and the few images needed for a sheet."""
    from playwright.async_api import Error as PlaywrightError
    from playwright.async_api import async_playwright

    frames, checks = spec["frames"], spec.get("check") or {}
    frame_dir = out_dir / "frames"
    frame_dir.mkdir(parents=True)
    out: dict[str, Any] = {"cameras": [], "frame_hashes": {}, "frame_count": 0, "worlds": {},
                           "sheet": None, "info": {}, "timings": {}}
    errors: list[str] = []
    started = time.monotonic()

    async def capture() -> None:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=CHROMIUM_ARGS)
            context = await browser.new_context(viewport={"width": size[0], "height": size[1]}, device_scale_factor=1)
            try:
                page, info = await _open_capture_page(context, url, errors)
                out["info"] = {**info, "chromium": browser.version}
                out["timings"]["load_s"] = round(time.monotonic() - started, 3)
                tiles = {tile["frame"] for tile in spec["sheet"]["tiles"]}
                data_urls: dict[int, str] = {}
                frames_started = time.monotonic()
                for group in spec["groups"]:
                    camera = await page.evaluate(
                        "(a) => window.cadRender.motionCamera(a.poses, a.direction, a.seed)",
                        {"poses": [frames[i]["deltas"] for i in group["fit"]],
                         "direction": to_glb(DIRECTIONS[group["camera"]]), "seed": str(group["id"])})
                    out["cameras"].append(camera)
                    for index in group["render"]:
                        result = await page.evaluate("(a) => window.cadRender.captureMotion(a.deltas, a.check)",
                                                     {"deltas": frames[index]["deltas"], "check": str(index) in checks})
                        png = _png(result["png"], f"frame {index}")
                        (frame_dir / f"frame-{index:04d}.png").write_bytes(png)
                        out["frame_hashes"][index] = sha256(png)
                        out["frame_count"] += 1
                        if index in tiles:
                            data_urls[index] = result["png"]
                        if str(index) in checks:
                            out["worlds"][index] = result["world"]
                out["timings"]["frames_s"] = round(time.monotonic() - frames_started, 3)
                sheet = spec["sheet"]
                if sheet["tiles"]:
                    result = await page.evaluate(
                        "(a) => window.cadRender.contactSheet(a.tiles, a.columns, a.width)",
                        {"tiles": [{"png": data_urls[t["frame"]], "lines": t["lines"]} for t in sheet["tiles"]],
                         "columns": sheet["columns"], "width": sheet["tile_width"]})
                    out["sheet"] = {"png": _png(result["png"], "contact sheet"), "size": [result["width"], result["height"]],
                                    "tiles": result["tiles"]}
            finally:
                await context.close()
                await browser.close()

    try:
        asyncio.run(capture())
    except PlaywrightError as exc:
        raise InfraError(f"browser: {exc.message}; page errors: {errors}") from exc
    if errors:
        raise InfraError(f"renderer page reported errors: {errors}")
    if out["info"].get("unmapped_meshes"):
        raise InfraError(f"GLB meshes owned by no part-map occurrence: {out['info']['unmapped_meshes']}")
    return out


def motion_parity(spec: dict[str, Any], worlds: dict[int, dict[str, Any]]) -> dict[str, Any]:
    """Rendered node world placements against the spec's expected ones (cad-motion's Chain)."""
    translation = rotation = 0.0
    worst = None
    for key, expected in (spec.get("check") or {}).items():
        actual = worlds[int(key)]
        for oid, want in expected.items():
            got = actual[oid]
            dt = max(abs(a - b) for a, b in zip(got["translation"], want["translation"]))
            sign = 1.0 if sum(a * b for a, b in zip(got["quaternion"], want["quaternion"])) >= 0 else -1.0
            dq = max(abs(sign * a - b) for a, b in zip(got["quaternion"], want["quaternion"]))
            if max(dt, dq) >= max(translation, rotation):
                worst = {"frame": int(key), "occurrence": oid}
            translation, rotation = max(translation, dt), max(rotation, dq)
    passed = translation <= PARITY_TOL and rotation <= PARITY_TOL
    return {"status": "pass" if passed else "fail", "frames": sorted(int(k) for k in spec.get("check") or {}),
            "max_translation_m": translation, "max_quaternion_component": rotation, "tolerance": PARITY_TOL,
            "worst": worst}


def run_motion(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    """`--motion SPEC`: scratch frames, contact sheet and motion-render.json for cad-motion motion.py."""
    wall = time.monotonic()
    if args.views is not None or args.subject != "assembly" or args.replace or args.jobs != DEFAULT_JOBS:
        raise InfraError("--motion renders scratch frames: it takes --version, --size, --out-dir and --cache-dir, "
                         "not --views, --subject, --replace or --jobs")
    hw = args.hw.resolve()
    size = parse_size(args.size)
    if args.out_dir is None:
        raise InfraError("--motion needs --out-dir under .cad-work; cad-motion motion.py publishes the bundle")
    try:
        out_dir = layout.scratch_path(hw, args.out_dir, "--out-dir")
    except layout.LayoutError as exc:
        raise InfraError(str(exc)) from exc
    if out_dir.exists():
        raise InfraError(f"--out-dir already exists; refusing to overwrite {out_dir}")
    version = resolve_version(hw, args.version)
    spec = motion_spec(args.motion, version)
    try:
        table = material_rules.MaterialTable.load()
    except material_rules.MaterialsError as exc:
        raise InfraError(str(exc)) from exc
    scene, materials, keyed = build_scene(hw, version, [], size, table)
    server = make_server(scene, version.files["glb"], args.cache_dir or default_cache_dir())
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    thread.start()
    try:
        captured = capture_motion(f"http://127.0.0.1:{server.server_address[1]}/", spec, size, out_dir)
    finally:
        server.shutdown()
        server.server_close()
    parity = motion_parity(spec, captured["worlds"])
    files = {f"frames/frame-{index:04d}.png": digest
             for index, digest in captured["frame_hashes"].items()}
    if captured["sheet"] is not None:
        (out_dir / "contact-sheet.png").write_bytes(captured["sheet"]["png"])
        files["contact-sheet.png"] = sha256(captured["sheet"]["png"])
    info = captured["info"]
    metadata = {
        "version": version.label, "case": spec.get("case"), "status": parity["status"],
        "image": {"width": size[0], "height": size[1]}, "frames_rendered": captured["frame_count"],
        "groups": [{"id": group["id"], "view": group["camera"], "fit_frames": [min(group["fit"]), max(group["fit"])],
                    "rendered": len(group["render"]), "camera": camera_record(camera),
                    "swept_radius_mm": round(camera["swept_radius_m"] * 1000, 3)}
                   for group, camera in zip(spec["groups"], captured["cameras"])],
        "sheet": None if captured["sheet"] is None else {"tiles": captured["sheet"]["tiles"],
                                                         "size": captured["sheet"]["size"]},
        "parity": parity, "floor_shadow": "omitted: the static renderer bakes it per pose",
        "materials": {pn: {k: m[k] for k in ("part_material", "part_finish", "rule")} for pn, m in materials.items()},
        "renderer": {"name": "cad-render three.js PBR", "sha256": renderer_sha256(), "three": THREE_VERSION,
                     "three_revision": info.get("three"), "playwright": importlib.metadata.version("playwright"),
                     "chromium": info.get("chromium"), "webgl": "SwiftShader (ANGLE)"},
        "inputs": {"version_manifest_sha256": sha256(version.files["manifest"].read_bytes()),
                   "source_sha256": keyed["key"]["source_sha256"]},
        "files": files, "wall_s": {**captured["timings"], "total_s": round(time.monotonic() - wall, 3)},
    }
    (out_dir / "motion-render.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    summary = {"status": parity["status"], "version": version.label, "out_dir": str(out_dir),
               "frames": captured["frame_count"], "contact_sheet": str(out_dir / "contact-sheet.png")
               if captured["sheet"] is not None else None, "parity": parity, "wall_s": metadata["wall_s"]}
    return (0 if parity["status"] == "pass" else 1), summary



def parse_size(text: str) -> tuple[int, int]:
    match = SIZE.match(text)
    if not match:
        raise InfraError(f"--size must be WIDTHxHEIGHT (100-9999 px), got {text!r}")
    return int(match.group(1)), int(match.group(2))


def default_cache_dir() -> Path:
    return load_concept_serve().default_cache_dir()


def run(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    wall = time.monotonic()
    if not 1 <= args.jobs <= MAX_JOBS:
        raise InfraError(f"--jobs must be between 1 and {MAX_JOBS}")
    hw = args.hw.resolve()
    size = parse_size(args.size)
    out_dir = None
    if args.out_dir is not None:
        try:
            out_dir = layout.scratch_path(hw, args.out_dir, "--out-dir")
        except layout.LayoutError as exc:
            raise InfraError(str(exc)) from exc
        if out_dir.exists():
            raise InfraError(f"--out-dir already exists; refusing to overwrite {out_dir}")
    version = resolve_version(hw, args.version)
    views = parse_views(args.views or DEFAULT_VIEWS, {oid: o.pn for oid, o in version.occurrences.items()})
    try:
        table = material_rules.MaterialTable.load()
    except material_rules.MaterialsError as exc:
        raise InfraError(str(exc)) from exc
    scene, materials, keyed = build_scene(hw, version, views, size, table)
    recipe = {"views": views, "size": [*size], "renderer": {"name": "cad-render", "version": renderer_sha256()},
              "inputs": {"version_manifest_sha256": sha256(version.files["manifest"].read_bytes()),
                         "cache_key": keyed["key"], "parity_policy": keyed["key"]["parity"]}}
    params = {"V": version.label, "S": args.subject}
    existing = None
    if out_dir is None:
        try:
            existing = layout.reusable(hw, "bundle.renders", params, recipe, replace=args.replace)
        except layout.PublishConflict as exc:
            raise InfraError(str(exc)) from exc

    if existing and out_dir is None:
        metadata = cache_hit(existing, keyed["key"], views)
        if metadata is not None:
            return 0, {"status": metadata["status"], "cache": "hit", "version": version.label,
                       "out_dir": str(existing), "pngs": {v: str(existing / f"{v}.png") for v in views},
                       "wall_s": round(time.monotonic() - wall, 3)}
    server = make_server(scene, version.files["glb"], args.cache_dir or default_cache_dir())
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        info, results, timings = capture_views(f"http://127.0.0.1:{port}/", views, size, args.jobs)
    finally:
        server.shutdown()
        server.server_close()

    view_records, pngs, passed = grade(results)
    for name, record in view_records.items():
        record["wall_s"] = timings[name]
    for pn, record in materials.items():
        record["applied"] = results[views[0]]["materials"][pn]
    metadata = {
        "version": version.label,
        "status": "fail" if not passed else ("warn" if any(r["quality"]["warnings"] for r in view_records.values()) else "pass"),
        "views": view_records, "materials": materials,
        "retry": {name: record["retry"] for name, record in view_records.items()},
        "renderer": {"name": "cad-render three.js PBR", "three": THREE_VERSION, "three_revision": info["three"],
                     "playwright": importlib.metadata.version("playwright"), "chromium": info["chromium"],
                     "webgl": "SwiftShader (ANGLE)", "studio": info["studio"]},
        "image": {"width": size[0], "height": size[1]}, "cache_key": keyed["key"],
        "inputs": {**{name: str(version.files[name].relative_to(hw)) for name in SOURCE_FILES},
                   "version_manifest_sha256": recipe["inputs"]["version_manifest_sha256"],
                   "assembly_yaml_sha256": keyed["assembly_yaml_sha256"],
                   "assembly_yaml_matches_version": keyed["assembly_yaml_matches_version"]},
        "explode_offsets_mm": keyed["explode_offsets_mm"],
        "wall_s": {**{k: v for k, v in timings.items() if k.endswith("_s")},
                   "total_s": round(time.monotonic() - wall, 3)}}
    if out_dir is not None:
        out_dir.mkdir(parents=True)
        for name, record in view_records.items():
            image = Path(record["png"])
            (out_dir / image).parent.mkdir(parents=True, exist_ok=True)
            (out_dir / image).write_bytes(pngs[name])
        (out_dir / "render.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    else:
        staged = layout.staging(hw, "bundle.renders")
        for name, record in view_records.items():
            image = Path(record["png"])
            (staged / image).parent.mkdir(parents=True, exist_ok=True)
            (staged / image).write_bytes(pngs[name])
        (staged / "render.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        try:
            published = layout.publish(hw, "bundle.renders", params, staged, recipe=recipe,
                                       producer="cad-render render.py", status=metadata["status"], replace=args.replace)
        except layout.PublishConflict as exc:
            raise InfraError(str(exc)) from exc
        out_dir = published.path
    summary = {"status": metadata["status"], "cache": "miss", "version": version.label, "out_dir": str(out_dir),
               "pngs": {v: str(out_dir / view_records[v]["png"]) for v in views},
               "failures": {v: r["quality"]["failures"] for v, r in view_records.items() if r["quality"]["failures"]},
               "warnings": {v: r["quality"]["warnings"] for v, r in view_records.items() if r["quality"]["warnings"]},
               "strategies": {v: r["retry"]["strategy"] for v, r in view_records.items()},
               "wall_s": metadata["wall_s"], "view_wall_s": timings}
    return (0 if passed else 1), summary

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="render.py", description=__doc__.splitlines()[0])
    parser.add_argument("hw", type=Path, help="the project's hw/ directory")
    parser.add_argument("--version", default="latest", help="latest or vN")
    parser.add_argument("--views", nargs="+",
                        help="iso front side exploded closeup-<PN> part-<PN> (default: iso front side exploded)")
    parser.add_argument("--size", default="1600x1200", help="frame size WIDTHxHEIGHT")
    parser.add_argument("--subject", default="assembly", help="bundle subject (default: assembly)")
    parser.add_argument("--jobs", type=int, default=DEFAULT_JOBS,
                        help=f"parallel Chromium pages (1-{MAX_JOBS}; default: {DEFAULT_JOBS})")
    parser.add_argument("--out-dir", type=Path, help="write scratch output under .cad-work only")
    parser.add_argument("--replace", action="store_true", help="retain and replace a conflicting bundle")
    parser.add_argument("--cache-dir", type=Path, help="pinned three.js module cache (default: cad-concept's)")
    parser.add_argument("--motion", type=Path, metavar="SPEC",
                        help="cad-motion motion.py frames spec: render its frames and contact sheet into --out-dir")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    try:
        code, summary = run_motion(args) if args.motion is not None else run(args)
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
