#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["jsonschema>=4.23"]
# ///
"""Check a cad-concept scene and export the concept-to-CAD handoff manifest.

Usage:
  uv run --script concept.py check <scene.json>
  uv run --script concept.py handoff <scene.json> [--variant ID] [--out FILE]

stdout carries one JSON result, stderr carries diagnostics.
Exit 0 = pass, 1 = check failure, 2 = usage or infrastructure error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_DIR = Path(__file__).resolve().parent.parent / "assets" / "schemas"
SCENE_SCHEMA = SCHEMA_DIR / "concept-scene.schema.json"
HANDOFF_SCHEMA = SCHEMA_DIR / "handoff.schema.json"

Matrix = tuple[tuple[float, ...], ...]
Vec3 = tuple[float, float, float]


class UsageError(Exception):
    """Bad arguments or unreadable input: exit 2."""


# --- validation -------------------------------------------------------------


def schema_errors(instance: Any, schema_path: Path) -> list[str]:
    """Return JSON Schema 2020-12 violations as 'path: message' lines."""
    # Imported here so the pure geometry and wiring checks below stay importable
    # by stdlib-only tests that run without the PEP 723 environment.
    from jsonschema import Draft202012Validator

    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.absolute_path))
    return [f"{_json_path(e.absolute_path)}: {e.message}" for e in errors]


def _json_path(parts: Any) -> str:
    out = "$"
    for part in parts:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out


def semantic_errors(scene: dict[str, Any]) -> list[str]:
    """Cross-field rules JSON Schema cannot express. Assumes a schema-valid scene."""
    errors: list[str] = []
    variant_ids = [v["id"] for v in scene["variants"]]
    errors += [f"variants: duplicate variant id '{i}'" for i in _duplicates(variant_ids)]
    retired = scene.get("retired", [])
    for entry in retired:
        if entry["id"] in variant_ids:
            errors.append(f"retired.{entry['id']}: id is also a live variant")
        if entry["disposition"] == "merged" and entry["into"] not in variant_ids:
            errors.append(f"retired.{entry['id']}: merged into unknown variant '{entry['into']}'")
    chosen = scene.get("chosen")
    if chosen is not None and chosen not in variant_ids:
        errors.append(f"chosen: '{chosen}' is not a live variant")
    for variant in scene["variants"]:
        errors += [f"variants.{variant['id']}: {msg}" for msg in _variant_errors(variant)]
    return errors


def _variant_errors(variant: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    nodes = list(_walk(variant["root"], None))
    node_ids = [node["id"] for node, _ in nodes]
    errors += [f"duplicate node id '{i}'" for i in _duplicates(node_ids)]
    parent_of = {node["id"]: parent for node, parent in nodes}
    for node, _ in nodes:
        shape = node.get("shape")
        if shape and shape["type"] == "capsule" and shape["height"] < 2 * shape["radius"]:
            errors.append(f"node '{node['id']}': capsule height {shape['height']} is below 2 x radius")
    joints = variant.get("joints", [])
    errors += [f"duplicate joint id '{i}'" for i in _duplicates([j["id"] for j in joints])]
    errors += [f"node '{i}' is the child of more than one joint" for i in _duplicates([j["child"] for j in joints])]
    for joint in joints:
        where = f"joint '{joint['id']}'"
        if joint["parent"] not in parent_of:
            errors.append(f"{where}: unknown parent '{joint['parent']}'")
        if joint["child"] not in parent_of:
            errors.append(f"{where}: unknown child '{joint['child']}'")
        elif parent_of[joint["child"]] != joint["parent"]:
            errors.append(f"{where}: child '{joint['child']}' is not a direct child of '{joint['parent']}'")
        if not joint["min"] < joint["max"]:
            errors.append(f"{where}: min {joint['min']} must be below max {joint['max']}")
        if not joint["min"] <= joint["nominal"] <= joint["max"]:
            errors.append(f"{where}: nominal {joint['nominal']} is outside [{joint['min']}, {joint['max']}]")
        if math.hypot(*joint["axis"]) < 1e-9:
            errors.append(f"{where}: axis is zero-length")
        if joint["type"] == "revolute" and (joint["min"] < -360 or joint["max"] > 360):
            errors.append(f"{where}: revolute limits exceed one turn either way")
    return errors


def _walk(node: dict[str, Any], parent: str | None):
    yield node, parent
    for child in node.get("children", []):
        yield from _walk(child, node["id"])


def _duplicates(values: list[str]) -> list[str]:
    seen: set[str] = set()
    dupes: list[str] = []
    for value in values:
        if value in seen and value not in dupes:
            dupes.append(value)
        seen.add(value)
    return dupes


# --- geometry ---------------------------------------------------------------
# The viewer poses with three.js; these functions reproduce the same frames:
# node = T(position) * Rx * Ry * Rz (three.js 'XYZ' Euler order), and a jointed
# child = T(origin) * J(value) * T(-origin) * node.


def _identity() -> Matrix:
    return tuple(tuple(1.0 if r == c else 0.0 for c in range(4)) for r in range(4))


def _mul(a: Matrix, b: Matrix) -> Matrix:
    return tuple(tuple(sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)) for r in range(4))


def _translation(v: Vec3) -> Matrix:
    m = [list(row) for row in _identity()]
    m[0][3], m[1][3], m[2][3] = v
    return tuple(tuple(row) for row in m)


def _rotation3(r: list[list[float]]) -> Matrix:
    return tuple(tuple(r[i][:3] + [0.0]) if i < 3 else (0.0, 0.0, 0.0, 1.0) for i in range(4))


def _euler_xyz(deg: Vec3) -> Matrix:
    x, y, z = (math.radians(a) for a in deg)
    rx = _rotation3([[1, 0, 0], [0, math.cos(x), -math.sin(x)], [0, math.sin(x), math.cos(x)]])
    ry = _rotation3([[math.cos(y), 0, math.sin(y)], [0, 1, 0], [-math.sin(y), 0, math.cos(y)]])
    rz = _rotation3([[math.cos(z), -math.sin(z), 0], [math.sin(z), math.cos(z), 0], [0, 0, 1]])
    return _mul(_mul(rx, ry), rz)


def _axis_angle(axis: Vec3, deg: float) -> Matrix:
    x, y, z = axis
    a = math.radians(deg)
    c, s, t = math.cos(a), math.sin(a), 1 - math.cos(a)
    return _rotation3(
        [
            [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
            [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
            [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
        ]
    )


def unit(v: list[float]) -> Vec3:
    n = math.hypot(*v)
    return (v[0] / n, v[1] / n, v[2] / n)


def local_matrix(node: dict[str, Any]) -> Matrix:
    return _mul(_translation(tuple(node.get("position", [0, 0, 0]))), _euler_xyz(tuple(node.get("rotation", [0, 0, 0]))))


def posed_matrix(node: dict[str, Any], joint: dict[str, Any] | None, value: float) -> Matrix:
    """Child frame in its parent frame with its joint (if any) at `value`."""
    m = local_matrix(node)
    if joint is None:
        return m
    axis = unit(joint["axis"])
    if joint["type"] == "prismatic":
        return _mul(_translation((axis[0] * value, axis[1] * value, axis[2] * value)), m)
    origin = tuple(joint["origin"])
    neg = (-origin[0], -origin[1], -origin[2])
    return _mul(_mul(_mul(_translation(origin), _axis_angle(axis, value)), _translation(neg)), m)


@dataclass(frozen=True)
class Box:
    lo: Vec3
    hi: Vec3

    def union(self, other: Box) -> Box:
        return Box(
            tuple(min(a, b) for a, b in zip(self.lo, other.lo)),
            tuple(max(a, b) for a, b in zip(self.hi, other.hi)),
        )

    def transformed(self, m: Matrix) -> Box:
        corners = [
            (x, y, z) for x in (self.lo[0], self.hi[0]) for y in (self.lo[1], self.hi[1]) for z in (self.lo[2], self.hi[2])
        ]
        pts = [tuple(sum(m[r][k] * p[k] for k in range(3)) + m[r][3] for r in range(3)) for p in corners]
        return Box(tuple(min(p[i] for p in pts) for i in range(3)), tuple(max(p[i] for p in pts) for i in range(3)))


def shape_box(shape: dict[str, Any]) -> Box:
    kind = shape["type"]
    if kind == "box":
        hx, hy, hz = (s / 2 for s in shape["size"])
    elif kind == "sphere":
        hx = hy = hz = shape["radius"]
    else:  # cylinder and capsule run along local Z
        hx = hy = shape["radius"]
        hz = shape["height"] / 2
    return Box((-hx, -hy, -hz), (hx, hy, hz))


def envelopes(variant: dict[str, Any]) -> dict[str, Box]:
    """Each node's subtree bounds in its own frame, joints at nominal."""
    joint_of = {j["child"]: j for j in variant.get("joints", [])}
    out: dict[str, Box] = {}

    def visit(node: dict[str, Any]) -> Box:
        if node["kind"] == "part":
            box = shape_box(node["shape"])
        else:
            box = None
            for child in node["children"]:
                joint = joint_of.get(child["id"])
                placed = visit(child).transformed(posed_matrix(child, joint, joint["nominal"] if joint else 0.0))
                box = placed if box is None else box.union(placed)
        out[node["id"]] = box
        return box

    visit(variant["root"])
    return out


# --- handoff ----------------------------------------------------------------


def _clean(v: float) -> float:
    r = round(v, 3)
    return 0.0 if r == 0 else r


def _vec(v: Any) -> list[float]:
    return [_clean(float(x)) for x in v]


def pick_variant(scene: dict[str, Any], requested: str | None) -> dict[str, Any]:
    wanted = requested or scene.get("chosen")
    if wanted is None:
        raise ValueError("no variant chosen: set 'chosen' at the VARIANT gate or pass --variant")
    for variant in scene["variants"]:
        if variant["id"] == wanted:
            return variant
    raise ValueError(f"variant '{wanted}' is not a live variant")


def build_handoff(scene: dict[str, Any], variant: dict[str, Any], *, file_name: str, digest: str) -> dict[str, Any]:
    boxes = envelopes(variant)
    nodes: list[dict[str, Any]] = []

    def visit(node: dict[str, Any], parent: str | None, path: str) -> None:
        box = boxes[node["id"]]
        entry: dict[str, Any] = {
            "id": node["id"],
            "kind": node["kind"],
            "label": node["label"],
            "path": path,
            "parent": parent,
            "children": [c["id"] for c in node.get("children", [])],
            "position": _vec(node.get("position", [0, 0, 0])),
            "rotation": _vec(node.get("rotation", [0, 0, 0])),
            "envelope": {
                "min": _vec(box.lo),
                "max": _vec(box.hi),
                "size": _vec(h - l for l, h in zip(box.lo, box.hi)),
            },
        }
        if node["kind"] == "part":
            entry["shape"] = node["shape"]
        nodes.append(entry)
        for child in node.get("children", []):
            visit(child, node["id"], f"{path}/{child['id']}")

    visit(variant["root"], None, variant["root"]["id"])
    joints = [
        {
            "id": j["id"],
            "label": j.get("label", j["id"]),
            "type": j["type"],
            "parent": j["parent"],
            "child": j["child"],
            "axis": _vec(unit(j["axis"])),
            "origin": _vec(j["origin"]),
            "min": j["min"],
            "max": j["max"],
            "nominal": j["nominal"],
            "unit": "deg" if j["type"] == "revolute" else "mm",
        }
        for j in variant.get("joints", [])
    ]
    alternatives = [
        {"id": v["id"], "label": v["label"], "disposition": "not-chosen"} for v in scene["variants"] if v is not variant
    ] + [
        {k: r[k] for k in ("id", "label", "disposition", "into", "reason") if k in r} for r in scene.get("retired", [])
    ]
    picked: dict[str, Any] = {"id": variant["id"], "label": variant["label"], "params": variant.get("params", {})}
    if "summary" in variant:
        picked["summary"] = variant["summary"]
    return {
        "format": "cad.concept-handoff",
        "version": 1,
        "units": "mm",
        "scene": {"id": scene["id"], "title": scene["title"], "file": file_name, "sha256": digest},
        "variant": picked,
        "nodes": nodes,
        "joints": joints,
        "alternatives": alternatives,
    }


# --- CLI --------------------------------------------------------------------


def load_scene(path: Path) -> tuple[bytes, Any]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise UsageError(f"cannot read scene: {exc}") from exc
    try:
        return raw, json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"scene is not valid JSON: {exc}") from exc


def check_scene(path: Path) -> tuple[bytes, Any, list[str]]:
    raw, scene = load_scene(path)
    errors = schema_errors(scene, SCENE_SCHEMA)
    if not errors:
        errors = semantic_errors(scene)
    return raw, scene, errors


def _emit(result: dict[str, Any]) -> None:
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


def run(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="concept.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="validate a scene against the schema and wiring rules")
    check.add_argument("scene", type=Path)
    handoff = sub.add_parser("handoff", help="export the chosen variant as a handoff manifest")
    handoff.add_argument("scene", type=Path)
    handoff.add_argument("--variant", help="variant id; defaults to the scene's 'chosen'")
    handoff.add_argument("--out", type=Path, help="write the manifest here instead of stdout")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2

    try:
        raw, scene, errors = check_scene(args.scene)
        if args.command == "check":
            variants = [v["id"] for v in scene["variants"]] if not errors else []
            _emit({"ok": not errors, "scene": str(args.scene), "variants": variants, "errors": errors})
            return 1 if errors else 0
        if errors:
            _emit({"ok": False, "scene": str(args.scene), "errors": errors})
            return 1
        variant = pick_variant(scene, args.variant)
        manifest = build_handoff(scene, variant, file_name=args.scene.name, digest=hashlib.sha256(raw).hexdigest())
        manifest_errors = schema_errors(manifest, HANDOFF_SCHEMA)
        if manifest_errors:
            print("handoff failed its own schema; this is a concept.py defect", file=sys.stderr)
            _emit({"ok": False, "scene": str(args.scene), "errors": manifest_errors})
            return 2
    except UsageError as exc:
        print(f"concept.py: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        _emit({"ok": False, "scene": str(args.scene), "errors": [str(exc)]})
        return 1

    if args.out is None:
        _emit(manifest)
        return 0
    try:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        print(f"concept.py: cannot write {args.out}: {exc}", file=sys.stderr)
        return 2
    _emit(
        {
            "ok": True,
            "out": str(args.out),
            "variant": variant["id"],
            "nodes": len(manifest["nodes"]),
            "joints": len(manifest["joints"]),
        }
    )
    return 0


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
