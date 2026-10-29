"""Animated glTF from a cad-model version's assembly.glb; standard library only.

`animate` keeps the version GLB's nodes, meshes and materials and appends one animation clip: a
LINEAR translation and rotation channel (glTF interpolates rotation spherically) on every
occurrence node that leaves its built pose. Node indices come from part-map.json; the motion of each
occurrence comes from the caller as a rigid delta D = T(settings) T_built^-1 in assembly coordinates
(mm, +Z up), which this module conjugates into the GLB frame (m, +Y up: (x, y, z) -> (x, z, -y) /
1000, cad-model mesh.py's convention). A node's animated local transform is P^-1 D W, with P its
parent's world transform and W its built world transform, so nodes keep any offset or scale.

Keyframe fidelity: between two keys the true motion is the plan's linear blend of their settings.
At every key interval's midpoint the interpolated node transform is compared with the evaluated one,
over the corners of each node's mesh bounds; an interval whose error exceeds TOL_MM or TOL_DEG gets
the midpoint as a new key, and both halves are checked again. The achieved maxima (midpoints and the
float32 keys) are reported.
"""

from __future__ import annotations

import json
import math
import struct
from collections.abc import Callable, Mapping, Sequence
from typing import Any

TOL_MM, TOL_DEG = 0.1, 0.1
MAX_DEPTH = 12  # halvings of one frame interval before the bound counts as unreachable
STILL = 1e-12  # m and rotation-entry change below which a node counts as not moving
FLOAT, SCALAR, VEC3, VEC4 = 5126, "SCALAR", "VEC3", "VEC4"
BASIS = ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, -1.0, 0.0))  # GLB axes in assembly coordinates (rows)
IDENTITY = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))

Vec = tuple[float, float, float]
Rot = tuple[Vec, Vec, Vec]
Quat = tuple[float, float, float, float]  # (x, y, z, w), glTF order


class GlbError(ValueError):
    """A GLB this module cannot animate, or a motion it cannot key within the bound."""


# --------------------------------------------------------------------------- binary container


def read_glb(data: bytes) -> tuple[dict[str, Any], bytearray]:
    """(glTF JSON, BIN chunk) of a binary glTF 2.0 file."""
    if len(data) < 20:
        raise GlbError("not a binary glTF file: too short")
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or length != len(data):
        raise GlbError("not a binary glTF 2.0 file")
    chunks, offset = [], 12
    while offset < len(data):
        size, kind = struct.unpack_from("<I4s", data, offset)
        chunks.append((kind, data[offset + 8:offset + 8 + size]))
        offset += 8 + size
    if not chunks or chunks[0][0] != b"JSON":
        raise GlbError("binary glTF without a leading JSON chunk")
    gltf = json.loads(chunks[0][1])
    binary = bytearray(next((payload for kind, payload in chunks[1:] if kind == b"BIN\x00"), b""))
    buffers = gltf.get("buffers") or []
    if buffers and "uri" in buffers[0]:
        raise GlbError("buffer 0 is an external file; only a self-contained GLB can be animated")
    return gltf, binary


def write_glb(gltf: dict[str, Any], binary: bytearray) -> bytes:
    binary = bytearray(binary)
    binary.extend(b"\x00" * (-len(binary) % 4))
    gltf.setdefault("buffers", [{}])[0]["byteLength"] = len(binary)
    text = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    text += b" " * (-len(text) % 4)
    out = bytearray(struct.pack("<4sII", b"glTF", 2, 0))
    out += struct.pack("<I4s", len(text), b"JSON") + text
    out += struct.pack("<I4s", len(binary), b"BIN\x00") + binary
    struct.pack_into("<I", out, 8, len(out))
    return bytes(out)


def _append(gltf: dict[str, Any], binary: bytearray, values: Sequence[Sequence[float]] | Sequence[float],
            kind: str, bounds: bool = False) -> int:
    """A float32 accessor over a new, 4-byte aligned bufferView at the end of the BIN chunk."""
    binary.extend(b"\x00" * (-len(binary) % 4))
    flat = [float(v) for row in values for v in (row if kind != SCALAR else (row,))]
    payload = struct.pack(f"<{len(flat)}f", *flat)
    gltf.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(payload)})
    binary.extend(payload)
    accessor: dict[str, Any] = {"bufferView": len(gltf["bufferViews"]) - 1, "componentType": FLOAT,
                                "count": len(values), "type": kind}
    if bounds:
        rounded = [_f32(v) for v in flat]
        accessor.update(min=[min(rounded)], max=[max(rounded)])
    gltf.setdefault("accessors", []).append(accessor)
    return len(gltf["accessors"]) - 1


def _f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


# --------------------------------------------------------------------------- rigid algebra


def _mul(a: Rot, b: Rot) -> Rot:
    return tuple(tuple(sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)) for i in range(3))  # type: ignore[return-value]


def _tr(a: Rot) -> Rot:
    return tuple(tuple(a[j][i] for j in range(3)) for i in range(3))  # type: ignore[return-value]


def _apply(a: Rot, v: Sequence[float]) -> Vec:
    return tuple(a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2] for i in range(3))  # type: ignore[return-value]


def _add(a: Sequence[float], b: Sequence[float]) -> Vec:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _sub(a: Sequence[float], b: Sequence[float]) -> Vec:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def quat_to_rot(q: Sequence[float]) -> Rot:
    x, y, z, w = q
    n = math.sqrt(x * x + y * y + z * z + w * w)
    x, y, z, w = x / n, y / n, z / n, w / n
    return ((1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
            (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
            (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)))


def rot_to_quat(r: Rot) -> Quat:
    (a, b, c), (d, e, f), (g, h, i) = r
    trace = a + e + i
    if trace > 0:
        s = 2.0 * math.sqrt(trace + 1.0)
        q = ((h - f) / s, (c - g) / s, (d - b) / s, 0.25 * s)
    elif a >= e and a >= i:
        s = 2.0 * math.sqrt(1.0 + a - e - i)
        q = (0.25 * s, (b + d) / s, (c + g) / s, (h - f) / s)
    elif e >= i:
        s = 2.0 * math.sqrt(1.0 + e - a - i)
        q = ((b + d) / s, 0.25 * s, (f + h) / s, (c - g) / s)
    else:
        s = 2.0 * math.sqrt(1.0 + i - a - e)
        q = ((c + g) / s, (f + h) / s, 0.25 * s, (d - b) / s)
    n = math.sqrt(sum(v * v for v in q))
    return (q[0] / n, q[1] / n, q[2] / n, q[3] / n)


def slerp(q0: Quat, q1: Quat, s: float) -> Quat:
    """glTF's spherical linear interpolation between two keys (q1 on q0's hemisphere)."""
    dot = sum(a * b for a, b in zip(q0, q1))
    if dot < 0:
        q1, dot = tuple(-v for v in q1), -dot  # type: ignore[assignment]
    if dot > 1 - 1e-12:
        q = tuple(a + (b - a) * s for a, b in zip(q0, q1))
    else:
        theta = math.acos(min(1.0, dot))
        k0, k1 = math.sin((1 - s) * theta) / math.sin(theta), math.sin(s * theta) / math.sin(theta)
        q = tuple(k0 * a + k1 * b for a, b in zip(q0, q1))
    n = math.sqrt(sum(v * v for v in q))
    return tuple(v / n for v in q)  # type: ignore[return-value]


def angle_deg(a: Rot, b: Rot) -> float:
    """The rotation angle of a^-1 b, from its quaternion (accurate near zero, unlike acos of the trace)."""
    x, y, z, _ = rot_to_quat(_mul(_tr(a), b))
    return math.degrees(2.0 * math.asin(min(1.0, math.sqrt(x * x + y * y + z * z))))


def to_glb(rows: Sequence[Sequence[float]]) -> tuple[Rot, Vec]:
    """A rigid transform as 3x4 rows [R | t] in assembly mm, conjugated into the GLB frame in metres."""
    rot = tuple(tuple(float(v) for v in row[:3]) for row in rows)
    trans = tuple(float(row[3]) for row in rows)
    return _mul(_mul(BASIS, rot), _tr(BASIS)), tuple(v / 1000.0 for v in _apply(BASIS, trans))  # type: ignore[arg-type,return-value]


def glb_pose(rows: Sequence[Sequence[float]]) -> dict[str, list[float]]:
    """`to_glb` as the renderers take it: translation (m) and unit quaternion (x, y, z, w)."""
    rot, trans = to_glb(rows)
    return {"translation": list(trans), "quaternion": list(rot_to_quat(rot))}


# --------------------------------------------------------------------------- node graph


def _local(node: Mapping[str, Any]) -> tuple[Rot, Vec, Vec]:
    """(rotation, translation, scale) of a node's local transform; a matrix must be rotation x scale."""
    if "matrix" in node:
        m = [float(v) for v in node["matrix"]]  # column-major
        columns = [(m[0], m[1], m[2]), (m[4], m[5], m[6]), (m[8], m[9], m[10])]
        scale = tuple(math.sqrt(sum(c * c for c in col)) for col in columns)
        if min(scale) <= 0:
            raise GlbError(f"node {node.get('name')!r}: a singular matrix cannot be animated")
        rot = tuple(tuple(columns[j][i] / scale[j] for j in range(3)) for i in range(3))
        orthogonal = _mul(_tr(rot), rot)  # type: ignore[arg-type]
        if max(abs(orthogonal[i][j] - IDENTITY[i][j]) for i in range(3) for j in range(3)) > 1e-6 or \
                (rot[0][0] * (rot[1][1] * rot[2][2] - rot[1][2] * rot[2][1])
                 - rot[0][1] * (rot[1][0] * rot[2][2] - rot[1][2] * rot[2][0])
                 + rot[0][2] * (rot[1][0] * rot[2][1] - rot[1][1] * rot[2][0])) < 0:
            raise GlbError(f"node {node.get('name')!r}: its matrix is not a rotation times a scale")
        return rot, (m[12], m[13], m[14]), scale  # type: ignore[return-value]
    rot = quat_to_rot(node.get("rotation", (0.0, 0.0, 0.0, 1.0)))
    return rot, tuple(float(v) for v in node.get("translation", (0.0, 0.0, 0.0))), \
        tuple(float(v) for v in node.get("scale", (1.0, 1.0, 1.0)))  # type: ignore[return-value]


def _parents(gltf: Mapping[str, Any]) -> dict[int, int]:
    return {child: index for index, node in enumerate(gltf.get("nodes", [])) for child in node.get("children", [])}


def _world_rigid(gltf: Mapping[str, Any], parents: Mapping[int, int], index: int | None) -> tuple[Rot, Vec]:
    """The world transform of `index` (identity for None); every ancestor must be rigid (scale 1)."""
    rot, trans = IDENTITY, (0.0, 0.0, 0.0)
    chain = []
    while index is not None:
        chain.append(index)
        index = parents.get(index)
    for node_index in reversed(chain):
        r, t, s = _local(gltf["nodes"][node_index])
        if max(abs(v - 1.0) for v in s) > 1e-9:
            raise GlbError(f"node {gltf['nodes'][node_index].get('name')!r} scales the occurrences below it")
        rot, trans = _mul(rot, r), _add(_apply(rot, t), trans)
    return rot, trans


def _corners(gltf: Mapping[str, Any], index: int) -> list[Vec]:
    """Corners of the mesh bounds under node `index`, in its local frame with its own scale applied."""
    points: list[Vec] = []

    def visit(node_index: int, rot: Rot, trans: Vec, scale: Vec) -> None:
        node = gltf["nodes"][node_index]
        if "mesh" in node:
            for primitive in gltf["meshes"][node["mesh"]].get("primitives", []):
                accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
                if "min" in accessor and "max" in accessor:
                    lo, hi = accessor["min"], accessor["max"]
                    for corner in ((x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])):
                        scaled = (corner[0] * scale[0], corner[1] * scale[1], corner[2] * scale[2])
                        points.append(_add(_apply(rot, scaled), trans))
        for child in node.get("children", []):
            r, t, s = _local(gltf["nodes"][child])
            visit(child, _mul(rot, r), _add(_apply(rot, (t[0] * scale[0], t[1] * scale[1], t[2] * scale[2])), trans),
                  (scale[0] * s[0], scale[1] * s[1], scale[2] * s[2]))

    _, _, own = _local(gltf["nodes"][index])
    visit(index, IDENTITY, (0.0, 0.0, 0.0), own)
    return points or [(0.0, 0.0, 0.0)]


# --------------------------------------------------------------------------- animation


def animate(glb: bytes, nodes: Mapping[str, Sequence[int]],
            deltas: Callable[[Mapping[str, float]], Mapping[str, Sequence[Sequence[float]]]],
            keys: Sequence[tuple[float, Mapping[str, float]]], clip: str) -> tuple[bytes, dict[str, Any]]:
    """The version GLB with one clip over `keys` (time in s, independent-joint settings), refined to the
    fidelity bound, and its report. `nodes` maps occurrence id -> GLB node indices (part-map.json);
    `deltas(settings)` gives each occurrence's rigid delta from the built pose as 3x4 rows in mm."""
    gltf, binary = read_glb(glb)
    if gltf.get("animations"):
        raise GlbError("the version GLB already holds an animation")
    if len(keys) < 2:
        raise GlbError("an animation needs at least two keys")
    parents = _parents(gltf)
    targets = []  # (occurrence, node, parent rotation and translation, rest local rotation, translation, scale)
    for oid, indices in nodes.items():
        for index in indices:
            if not 0 <= index < len(gltf.get("nodes", [])):
                raise GlbError(f"{oid}: part-map node {index} is not in the GLB")
            rp, tp = _world_rigid(gltf, parents, parents.get(index))
            rl, tl, scale = _local(gltf["nodes"][index])
            targets.append((oid, index, rp, tp, rl, tl, scale, _corners(gltf, index)))
    names = {index for _, index, *_ in targets}
    for index in names:
        ancestor = parents.get(index)
        while ancestor is not None:
            if ancestor in names:
                raise GlbError(f"node {index} lies under another occurrence node {ancestor}")
            ancestor = parents.get(ancestor)

    def locals_at(settings: Mapping[str, float]) -> list[tuple[Rot, Vec]]:
        moved = deltas(settings)
        out = []
        for oid, _, rp, tp, rl, tl, _, _ in targets:
            rd, td = to_glb(moved[oid])
            rw, tw = _mul(rp, rl), _add(_apply(rp, tl), tp)  # built world: P L
            rot = _mul(_tr(rp), _mul(rd, rw))  # P^-1 D W
            trans = _apply(_tr(rp), _sub(_add(_apply(rd, tw), td), tp))
            out.append((rot, trans))
        return out

    def error(a: tuple[Rot, Vec], b: tuple[Rot, Vec], corners: Sequence[Vec]) -> tuple[float, float]:
        """Largest corner distance (mm) and rotation difference (deg) between two local transforms;
        the parent's rigid world transform preserves both."""
        worst = 0.0
        for p in corners:
            worst = max(worst, math.dist(_add(_apply(a[0], p), a[1]), _add(_apply(b[0], p), b[1])))
        return worst * 1000.0, angle_deg(a[0], b[0])

    def interpolate(a: list[tuple[Rot, Vec]], b: list[tuple[Rot, Vec]], s: float) -> list[tuple[Rot, Vec]]:
        return [(quat_to_rot(slerp(rot_to_quat(ra), rot_to_quat(rb), s)),
                 tuple(x + (y - x) * s for x, y in zip(ta, tb)))  # type: ignore[misc]
                for (ra, ta), (rb, tb) in zip(a, b)]

    worst = {"mm": 0.0, "deg": 0.0}
    timeline: list[tuple[float, list[tuple[Rot, Vec]]]] = []

    def refine(t0: float, s0: Mapping[str, float], l0: list, t1: float, s1: Mapping[str, float], l1: list,
               depth: int) -> None:
        mid = {k: (s0[k] + s1[k]) / 2.0 for k in s0}
        truth, guess = locals_at(mid), interpolate(l0, l1, 0.5)
        errors = [error(g, t, target[7]) for g, t, target in zip(guess, truth, targets)]
        mm, deg = max((e[0] for e in errors), default=0.0), max((e[1] for e in errors), default=0.0)
        if mm <= TOL_MM and deg <= TOL_DEG:
            worst["mm"], worst["deg"] = max(worst["mm"], mm), max(worst["deg"], deg)
            timeline.append((t1, l1))
            return
        if depth >= MAX_DEPTH:
            raise GlbError(f"keys {MAX_DEPTH} halvings apart still interpolate {mm:.3g} mm / {deg:.3g} deg off the "
                           f"motion near t = {t0:.6g} s; the bound is {TOL_MM} mm / {TOL_DEG} deg")
        tm = (t0 + t1) / 2.0
        refine(t0, s0, l0, tm, mid, truth, depth + 1)
        refine(tm, mid, truth, t1, s1, l1, depth + 1)

    previous = locals_at(keys[0][1])
    timeline.append((float(keys[0][0]), previous))
    for (t0, s0), (t1, s1) in zip(keys, keys[1:]):
        current = locals_at(s1)
        refine(float(t0), s0, previous, float(t1), s1, current, 0)
        previous = current

    times = [_f32(t) for t, _ in timeline]
    if any(b <= a for a, b in zip(times, times[1:])):
        raise GlbError("key times do not increase in float32; shorten the plan or lower its fps")
    moving = [i for i, target in enumerate(targets)
              if any(max(abs(pose[i][1][k] - target[5][k]) for k in range(3)) > STILL
                     or max(abs(pose[i][0][r][c] - target[4][r][c]) for r in range(3) for c in range(3)) > STILL
                     for _, pose in timeline)]
    key_error = {"mm": 0.0, "deg": 0.0}
    animation: dict[str, Any] = {"name": clip, "samplers": [], "channels": []}
    time_accessor = _append(gltf, binary, times, SCALAR, bounds=True)
    for i in moving:
        index, scale, corners = targets[i][1], targets[i][6], targets[i][7]
        quats: list[Quat] = []
        for _, pose in timeline:
            q = rot_to_quat(pose[i][0])
            if quats and sum(a * b for a, b in zip(quats[-1], q)) < 0:
                q = tuple(-v for v in q)  # type: ignore[assignment]
            quats.append(q)
        translations = [pose[i][1] for _, pose in timeline]
        for (_, pose), q, t in zip(timeline, quats, translations):
            stored = (quat_to_rot(tuple(_f32(v) for v in q)), tuple(_f32(v) for v in t))
            mm, deg = error(stored, pose[i], corners)  # type: ignore[arg-type]
            key_error["mm"], key_error["deg"] = max(key_error["mm"], mm), max(key_error["deg"], deg)
        node = gltf["nodes"][index]
        node.pop("matrix", None)
        node["translation"], node["rotation"] = [float(v) for v in translations[0]], [float(v) for v in quats[0]]
        if max(abs(v - 1.0) for v in scale) > 0:
            node["scale"] = list(scale)
        for path, values, kind in (("translation", translations, VEC3), ("rotation", quats, VEC4)):
            animation["samplers"].append({"input": time_accessor, "output": _append(gltf, binary, values, kind),
                                          "interpolation": "LINEAR"})
            animation["channels"].append({"sampler": len(animation["samplers"]) - 1,
                                          "target": {"node": index, "path": path}})
    if not moving:
        raise GlbError("no occurrence moves in this plan")
    gltf["animations"] = [animation]
    report = {"clip": clip, "keys": len(timeline), "frames": len(keys), "inserted_keys": len(timeline) - len(keys),
              "duration_s": times[-1], "animated_nodes": len(moving), "channels": len(animation["channels"]),
              "moving_occurrences": sorted({targets[i][0] for i in moving}),
              "max_midpoint_error": {"mm": worst["mm"], "deg": worst["deg"]},
              "max_key_error": key_error, "tolerance": {"mm": TOL_MM, "deg": TOL_DEG},
              "interpolation": "LINEAR translation, spherical linear rotation"}
    return write_glb(gltf, binary), report
