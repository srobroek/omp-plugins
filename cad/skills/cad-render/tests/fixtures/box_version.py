"""Sealed cad-model versions of boxes, written without a kernel, for cad-render's tests.

Every PN is placed once, as the occurrence named by its PN, at the identity. assembly.glb follows
cad-model's node layout: a root node, then one node per occurrence holding its own box mesh in the
GLB frame (metres, +Y up: (x, y, z) -> (x, z, -y) / 1000), with each mesh's vertex and index data
packed one after the other in PN order. The manifest inventories every file, so cad-record's layout
verifies the version.
"""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path
from typing import Any

import yaml

IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
Box = tuple[tuple[float, float, float], tuple[float, float, float]]  # (min, max) corners, assembly mm


def _box(lo: tuple[float, ...], hi: tuple[float, ...]) -> tuple[list[tuple[float, ...]], list[int]]:
    corners = [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    glb = [(x / 1000.0, z / 1000.0, -y / 1000.0) for x, y, z in corners]
    faces = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1),
             (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    return glb, [i for face in faces for i in face]


def pack(document: dict[str, Any], binary: bytes) -> bytes:
    """A GLB file of a glTF document and its binary chunk."""
    text = json.dumps(document).encode()
    text += b" " * (-len(text) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    head = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(text) + 8 + len(binary))
    return head + struct.pack("<I4s", len(text), b"JSON") + text + struct.pack("<I4s", len(binary), b"BIN\x00") + binary


def glb(boxes: dict[str, Box], translations: dict[str, tuple[float, float, float]] | None = None) -> bytes:
    """A GLB of one box mesh per PN, in PN order; `translations` moves a PN's node (GLB metres)."""
    binary = bytearray()
    document: dict[str, Any] = {"asset": {"version": "2.0", "generator": "cad-render test fixture"}, "scene": 0,
                                "scenes": [{"nodes": [0]}], "nodes": [{"name": "assembly", "children": []}],
                                "meshes": [], "accessors": [], "bufferViews": [], "buffers": [{}]}
    for pn, (lo, hi) in sorted(boxes.items()):
        positions, indices = _box(lo, hi)
        for data, target, accessor in (
                (struct.pack(f"<{3 * len(positions)}f", *(c for p in positions for c in p)), 34962,
                 {"componentType": 5126, "count": len(positions), "type": "VEC3",
                  "min": [min(p[i] for p in positions) for i in range(3)],
                  "max": [max(p[i] for p in positions) for i in range(3)]}),
                (struct.pack(f"<{len(indices)}H", *indices), 34963,
                 {"componentType": 5123, "count": len(indices), "type": "SCALAR"})):
            document["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(data),
                                            "target": target})
            document["accessors"].append({"bufferView": len(document["bufferViews"]) - 1, **accessor})
            binary += data + b"\x00" * (-len(data) % 4)
        document["meshes"].append({"name": pn, "primitives": [{"attributes": {"POSITION": len(document["accessors"]) - 2},
                                                              "indices": len(document["accessors"]) - 1}]})
        document["nodes"][0]["children"].append(len(document["nodes"]))
        node: dict[str, Any] = {"name": pn, "mesh": len(document["meshes"]) - 1}
        if translations and pn in translations:
            node["translation"] = list(translations[pn])
        document["nodes"].append(node)
    document["buffers"][0]["byteLength"] = len(binary)
    return pack(document, bytes(binary))


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(hw: Path, label: str, boxes: dict[str, Box], parts: dict[str, dict[str, Any]],
          translations: dict[str, tuple[float, float, float]] | None = None) -> Path:
    """Write hw/'s part records and assembly.yaml and the sealed version `label` of `boxes`, whose
    part.yaml records are `parts` (PN -> document); latest.json then names `label`."""
    hw.mkdir(parents=True, exist_ok=True)
    (hw / "assembly.yaml").write_text("joints: []\n", encoding="utf-8")
    for pn, record in parts.items():
        (hw / "parts" / pn).mkdir(parents=True, exist_ok=True)
        (hw / "parts" / pn / "part.yaml").write_text(yaml.safe_dump({"PN": pn, **record}, sort_keys=False),
                                                     encoding="utf-8")
    folder = hw / "versions" / label
    (folder / "record" / "parts").mkdir(parents=True)
    (folder / "record" / "assembly.yaml").write_bytes((hw / "assembly.yaml").read_bytes())
    for pn in parts:
        (folder / "record" / "parts" / pn).mkdir()
        (folder / "record" / "parts" / pn / "part.yaml").write_bytes((hw / "parts" / pn / "part.yaml").read_bytes())
    order = sorted(boxes)
    (folder / "assembly.glb").write_bytes(glb(boxes, translations))
    (folder / "assembly.step").write_text("fixture placeholder; cad-render never reads it\n", encoding="utf-8")
    (folder / "part-map.json").write_text(json.dumps({
        "schema_version": 2, "glb": "assembly.glb",
        "parts": {pn: {"product": pn, "occurrences": [pn], "node_indices": [i + 1]} for i, pn in enumerate(order)},
        "occurrences": {pn: {"PN": pn, "ref": pn, "node_indices": [i + 1]} for i, pn in enumerate(order)}}),
        encoding="utf-8")
    (folder / "metrics.json").write_text(json.dumps({"schema_version": 2, "parts": {
        pn: {"bbox_mm": {"min": list(lo), "max": list(hi), "size": [b - a for a, b in zip(lo, hi)]}}
        for pn, (lo, hi) in boxes.items()}}), encoding="utf-8")
    files = {p.relative_to(folder).as_posix(): _sha(p) for p in sorted(folder.rglob("*")) if p.is_file()}
    manifest = {
        "schema_version": 2, "label": label, "ground": order[0], "attach": [],
        "assembly_yaml_sha256": files["record/assembly.yaml"],
        "occurrences": {pn: {"PN": pn, "ref": pn, "group": None, "rest": IDENTITY} for pn in order},
        "pose": {"values": {}, "transforms": {pn: IDENTITY for pn in order}, "motions": {pn: IDENTITY for pn in order}},
        "joints": [], "record": {name: digest for name, digest in files.items() if name.startswith("record/")},
        "manufacturing": {}, "files": files,
    }
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    (hw / "versions" / "latest.json").write_text(json.dumps({"label": label}), encoding="utf-8")
    return folder
