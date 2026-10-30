"""A sealed cad-model version written without a kernel, for the motion render tests.

A planar arm on a base: TST-0002 turns about +Z through the origin (J-001), TST-0003 about +Z
through (100, 0, 0) (J-002), and TST-0004 about +Z through (180, 0, 0) follows J-002 at -1:2 (J-003).
Every part is an assembly_zero box, so each occurrence's rest placement is the identity. The version
is built at the nominal pose J-001 = 30 deg, so its GLB nodes are not at the zero pose.

assembly.glb follows cad-model's node layout: a root node, then one TRS node per occurrence with its
own box mesh, in the GLB frame (metres, +Y up: (x, y, z) -> (x, z, -y) / 1000). The manifest, part
map, metrics and record snapshot carry what cad-render, cad-viewer and motion.py read; the manifest
inventories every file, so cad-record's layout verifies the version.
"""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path
from typing import Any

BOXES = {
    "TST-0001": ((-20.0, -20.0, -5.0), (20.0, 20.0, 0.0)),
    "TST-0002": ((0.0, -5.0, 0.0), (100.0, 5.0, 5.0)),
    "TST-0003": ((100.0, -4.0, 5.0), (180.0, 4.0, 9.0)),
    "TST-0004": ((180.0, -3.0, 9.0), (200.0, 3.0, 12.0)),
    "TST-0005": ((35.0, -3.0, -4.0), (45.0, 3.0, 4.0)),
}
TITLES = {"TST-0001": "Base", "TST-0002": "Arm", "TST-0003": "Forearm", "TST-0004": "Tip",
          "TST-0005": "Cover"}
NOMINAL_J1 = 30.0
BASIS = ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, -1.0, 0.0))


def assembly(j3_limit: float = 30.0) -> dict[str, Any]:
    """Planar arm fixture with a built-but-unlisted cover attached to TST-0001."""
    return {
        "subassemblies": [{"id": "arm", "title": "Planar arm", "parts": sorted(set(BOXES) - {"TST-0005"})}],
        "joints": [
            {"id": "J-001", "type": "revolute", "parent": "TST-0001", "child": "TST-0002", "axis": [0, 0, 1],
             "origin": [0, 0, 0], "min": -90, "max": 90, "nominal": NOMINAL_J1},
            {"id": "J-002", "type": "revolute", "parent": "TST-0002", "child": "TST-0003", "axis": [0, 0, 1],
             "origin": [100, 0, 0], "min": -60, "max": 60, "nominal": 0},
            {"id": "J-003", "type": "revolute", "parent": "TST-0003", "child": "TST-0004", "axis": [0, 0, 1],
             "origin": [180, 0, 0], "min": -j3_limit, "max": j3_limit,
             "coupling": {"type": "linear", "driver": "J-002", "ratio": -0.5}},
        ],
    }


def rows(rigid: Any) -> list[list[float]]:
    return [[*rigid.rot[i], rigid.trans[i]] for i in range(3)]


def glb_rigid(rigid: Any) -> tuple[tuple[tuple[float, ...], ...], tuple[float, ...]]:
    """(rotation, translation in m) of an assembly-frame rigid transform in the GLB frame."""
    rot = tuple(tuple(sum(BASIS[i][a] * rigid.rot[a][b] * BASIS[j][b] for a in range(3) for b in range(3))
                      for j in range(3)) for i in range(3))
    trans = tuple(sum(BASIS[i][a] * rigid.trans[a] for a in range(3)) / 1000.0 for i in range(3))
    return rot, trans


def _box(lo: tuple[float, ...], hi: tuple[float, ...]) -> tuple[list[tuple[float, ...]], list[int]]:
    corners = [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    glb = [(x / 1000.0, z / 1000.0, -y / 1000.0) for x, y, z in corners]
    faces = [(0, 1, 3), (0, 3, 2), (4, 6, 7), (4, 7, 5), (0, 4, 5), (0, 5, 1),
             (2, 3, 7), (2, 7, 6), (0, 2, 6), (0, 6, 4), (1, 5, 7), (1, 7, 3)]
    return glb, [i for face in faces for i in face]


def _f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def glb(nodes: list[tuple[str, tuple[float, ...], tuple[float, ...], tuple[float, ...], tuple[float, ...]]]) -> bytes:
    """A GLB of one box mesh per node: (name, box min, box max (assembly mm), translation (m), quaternion)."""
    binary = bytearray()
    gltf: dict[str, Any] = {"asset": {"version": "2.0", "generator": "cad-motion test fixture"}, "scene": 0,
                            "scenes": [{"nodes": [0]}], "nodes": [{"name": "assembly v1", "children": []}],
                            "meshes": [], "accessors": [], "bufferViews": [], "buffers": [{}]}
    for name, lo, hi, translation, quaternion in nodes:
        positions, indices = _box(lo, hi)
        offset = len(binary)
        binary += struct.pack(f"<{3 * len(positions)}f", *(c for p in positions for c in p))
        gltf["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(binary) - offset, "target": 34962})
        gltf["accessors"].append({"bufferView": len(gltf["bufferViews"]) - 1, "componentType": 5126,
                                  "count": len(positions), "type": "VEC3",
                                  "min": [min(_f32(p[i]) for p in positions) for i in range(3)],
                                  "max": [max(_f32(p[i]) for p in positions) for i in range(3)]})
        offset = len(binary)
        binary += struct.pack(f"<{len(indices)}H", *indices)
        binary += b"\x00" * (-len(binary) % 4)
        gltf["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": 2 * len(indices), "target": 34963})
        gltf["accessors"].append({"bufferView": len(gltf["bufferViews"]) - 1, "componentType": 5123,
                                  "count": len(indices), "type": "SCALAR"})
        gltf["meshes"].append({"name": name, "primitives": [{"attributes": {"POSITION": len(gltf["accessors"]) - 2},
                                                             "indices": len(gltf["accessors"]) - 1}]})
        gltf["nodes"][0]["children"].append(len(gltf["nodes"]))
        gltf["nodes"].append({"name": name, "mesh": len(gltf["meshes"]) - 1, "translation": list(translation),
                              "rotation": list(quaternion)})
    gltf["buffers"][0]["byteLength"] = len(binary)
    text = json.dumps(gltf).encode()
    text += b" " * (-len(text) % 4)
    out = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(text) + 8 + len(binary))
    return out + struct.pack("<I4s", len(text), b"JSON") + text + struct.pack("<I4s", len(binary), b"BIN\x00") + bytes(binary)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(hw: Path, pose: Any, j3_limit: float = 30.0) -> Path:
    """Write the record and sealed v1, with an attached built PN that has no assembly occurrence."""
    import yaml

    hw.mkdir(parents=True, exist_ok=True)
    attach = ["TST-0005=TST-0001"]
    (hw / "product.yaml").write_text("id: motion-arm\n", encoding="utf-8")
    (hw / "interfaces.yaml").write_text("interfaces: []\n", encoding="utf-8")
    (hw / "assembly.yaml").write_text(yaml.safe_dump(assembly(j3_limit), sort_keys=False), encoding="utf-8")
    for pn, title in TITLES.items():
        (hw / "parts" / pn).mkdir(parents=True, exist_ok=True)
        (hw / "parts" / pn / "part.yaml").write_text(
            f"PN: {pn}\ntitle: {title}\nmaterial: Aluminum 6061-T6\nfinish: Machined\nmodel_frame: assembly_zero\n",
            encoding="utf-8")
    loaded = pose.load_assembly(hw)
    joints = [*loaded.joints, *pose.attach_joints(attach, loaded)]
    chain = pose.build_chain(joints, loaded.occurrences, couplings=loaded.couplings)
    values = chain.complete({})
    placed, moved = chain.transforms(values), chain.motions(values)
    folder = hw / "versions" / "v1"
    (folder / "record" / "parts").mkdir(parents=True)
    for name in ("product.yaml", "interfaces.yaml", "assembly.yaml"):
        (folder / "record" / name).write_bytes((hw / name).read_bytes())
    for pn in TITLES:
        (folder / "record" / "parts" / pn).mkdir()
        (folder / "record" / "parts" / pn / "part.yaml").write_bytes((hw / "parts" / pn / "part.yaml").read_bytes())
    order = list(chain.ids)
    nodes = []
    for oid in order:
        rot, trans = glb_rigid(placed[oid])
        nodes.append((f"{oid} {TITLES[oid]}", *BOXES[oid], trans,
                      pose.Rigid(rot, trans).quaternion()))  # type: ignore[arg-type]
    (folder / "assembly.glb").write_bytes(glb(nodes))
    (folder / "assembly.step").write_text("fixture placeholder; the motion tests never read it\n", encoding="utf-8")
    (folder / "part-map.json").write_text(json.dumps({
        "schema_version": 2, "glb": "assembly.glb",
        "parts": {pn: {"product": f"{pn} {TITLES[pn]}",
                        "occurrences": [oid for oid in order if chain.pn(oid) == pn],
                        "node_indices": [i + 1 for i, oid in enumerate(order) if chain.pn(oid) == pn]}
                  for pn in TITLES},
        "occurrences": {oid: {"PN": chain.pn(oid), "ref": chain.ref(oid), "node_indices": [i + 1]}
                        for i, oid in enumerate(order)}}), encoding="utf-8")
    (folder / "metrics.json").write_text(json.dumps({"schema_version": 2, "parts": {
        pn: {"bbox_mm": {"min": list(lo), "max": list(hi), "size": [b - a for a, b in zip(lo, hi)]}}
        for pn, (lo, hi) in BOXES.items()}}), encoding="utf-8")
    files = {p.relative_to(folder).as_posix(): _sha(p) for p in sorted(folder.rglob("*")) if p.is_file()}
    manifest = {
        "schema_version": 2, "label": "v1", "product_id": "motion-arm", "ground": chain.root, "attach": attach,
        "assembly_yaml_sha256": files["record/assembly.yaml"],
        "occurrences": {oid: {"PN": chain.pn(oid), "ref": chain.ref(oid), "group": "arm" if oid in loaded.inventory else None,
                              "rest": rows(chain.rests[oid])} for oid in order},
        "pose": {"values": values, "transforms": {oid: rows(placed[oid]) for oid in order},
                 "motions": {oid: rows(moved[oid]) for oid in order}},
        "joints": [{"id": j.id, "type": j.type, "parent": j.parent, "child": j.child, "axis": list(j.axis),
                    "origin": list(j.origin), "min": j.min, "max": j.max} for j in chain.joints],
        "record": {name: digest for name, digest in files.items() if name.startswith("record/")},
        "manufacturing": {}, "files": files,
    }
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    (hw / "versions" / "latest.json").write_text(json.dumps({"label": "v1"}), encoding="utf-8")
    return folder
