#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["defusedxml>=0.7.1", "pyyaml>=6.0", "jsonschema>=4.23"]
# ///
"""Propose drawing intent from a part's B-rep: a reviewable draft, never the record.

Usage: drawing_draft.py HW [--version vN] --part PN [--part PN ...] --output-dir DIR [--timeout S]

For each part: read its STEP in FreeCAD, recognise its manufacturing features (``feature_recognition``)
and write ``DIR/<PN>/drawing_intent.draft.yaml``:

- ``recognized``: every hole, pocket, cutout, slot, notch, groove, boss, rib, wall, step, round,
  chamfer, arc, dish, engraving and the outline, with its faces and measured sizes (for review only:
  the record never carries values);
- ``unrecognized``: faces no pattern matches, with the reason;
- ``locators``: before the model has a ``drawing_features`` hook, one proposed locator per feature and
  plane (kind, faces, and per face a ``select`` line: support type, normal or axis, level or radius),
  each face in exactly one entry, for writing the hook's PARAMS rules. Once the version carries the
  hook, the hook's own locators with the recognised features each one holds, and ``hook`` lists what
  its binding left unbound, ambiguous or unaccounted;
- ``drawing``: a proposed ``part.yaml`` drawing block in those locator names: datums on the largest
  outer planes, the frame, orthographic views, ``size: general`` per locator, and a direct dimension
  request for every wall, rib and shell thickness and every pocket, cutout and notch width, length and
  depth, so the gate's ISO 129-1 functional sizes are stated directly; a drafted wall's thickness and
  a width between inclined flanks ``at`` their reference plane with their angles, and a spherical
  recess's radius (SR) and depth;
- ``review``: what the agent decides before merging: design intent, tolerances, notes, sections.

It never writes part.yaml or model.py; ``drawing_merge.py`` merges the reviewed block. Exit 0 when
every draft is written, 2 on invalid input or an infrastructure failure.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

import drawing  # noqa: E402
import drawing_contract  # noqa: E402
import feature_geometry as fg  # noqa: E402
import freecad_runtime  # noqa: E402
from feature_recognition import Recognition, Recognized, Size  # noqa: E402

# a face goes to the first feature that claims it, in this order: the kinds that state the most first
PRIORITY = ("hole", "boss", "shaft", "groove", "slot", "engraving", "arc", "chamfer", "round", "taper", "dish",
            "pocket", "notch", "cutout", "rib", "step", "wall", "outline")
DIRECT = ("thickness", "width", "length", "depth")
ORDER = {category: rank for rank, category in enumerate(PRIORITY)}
REVIEW = "REVIEW"   # the placeholder prefix drawing_merge.py refuses to merge


def _num(value: float) -> str:
    return f"{round(value, 4):g}"


def _where(direction: fg.Vector) -> tuple[str, str] | None:
    """The frame axis a unit vector lies on and its sign, for an axis-aligned face."""
    for k, name in enumerate("xyz"):
        if abs(abs(direction[k]) - 1.0) < 1e-6:
            return name, "+" if direction[k] > 0 else "-"
    return None


def _point(point: fg.Vector) -> str:
    return "(" + ", ".join(_num(c) for c in point) + ")"


def select(face: fg.Face) -> str:
    """How a hook tells this face from the others: support type, normal or axis, level or radius (model mm)."""
    if face.support_type == "plane" and face.normal is not None and face.point is not None:
        on = _where(fg.unit(face.normal))
        if on is not None:
            axis, sign = on
            return f"plane {sign}{axis} at {axis}={_num(face.point['xyz'.index(axis)])}"
        return f"plane normal {_point(fg.unit(face.normal))} through {_point(face.point)}"
    if face.axis_point is not None and face.axis_dir is not None:
        on = _where(fg.unit(face.axis_dir))
        if on is not None:
            across = [k for k, name in enumerate("xyz") if name != on[0]]
            axis = f"axis {on[0]} at " + " ".join(f"{'xyz'[k]}={_num(face.axis_point[k])}" for k in across)
        else:
            axis = f"axis {_point(fg.unit(face.axis_dir))} through {_point(face.axis_point)}"
        size = {"cylinder": f"r={_num(face.radius or 0.0)}", "cone": f"half-angle {_num(face.semi_angle_deg or 0.0)}",
                "torus": f"R={_num(face.major_radius or 0.0)} r={_num(face.radius or 0.0)}",
                "sphere": f"r={_num(face.radius or 0.0)}"}.get(face.support_type, "")
        side = "" if face.inward is None else (" inward" if face.inward else " outward")
        return f"{face.support_type} {size}{side} {axis}".replace("  ", " ")
    low, high = face.bbox[:3], face.bbox[3:]
    return f"{face.support_type} in box {_point(low)}..{_point(high)}"


def _partition(recognition: Recognition, faces: dict[int, fg.Face]) -> tuple[dict[str, Recognized], dict[int, str]]:
    """Each face to one proposed locator: the highest-priority recognised feature that has it."""
    owner: dict[int, str] = {}
    chosen: dict[str, Recognized] = {}
    for item in sorted(recognition.features, key=lambda f: (ORDER.get(f.category, len(ORDER)), f.id)):
        free = [i for i in item.faces if i not in owner]
        if not free:
            continue
        chosen[item.id] = item
        for i in free:
            owner[i] = item.id
    for entry in recognition.unrecognized:
        owner.setdefault(entry["face"], "model_defined")
    return chosen, owner


def _plane_features(owner: dict[int, str], faces: dict[int, fg.Face]) -> dict[int, str]:
    """Planes of planar features split into coplanar groups: plane_face locators are coplanar."""
    groups: dict[tuple[str, tuple[float, ...], float], str] = {}
    named: dict[int, str] = {}
    for index in sorted(owner):
        face = faces[index]
        base = owner[index]
        if face.support_type != "plane" or base.split("_")[0] not in ("pocket", "notch", "cutout", "rib", "boss", "step",
                                                                      "wall", "outline"):
            named[index] = base
            continue
        normal = tuple(round(c, 4) for c in fg.unit(face.normal))
        key = (base, normal, round(fg.dot(face.point, fg.unit(face.normal)), 3))
        groups.setdefault(key, f"{base}_p{sum(1 for k in groups if k[0] == base) + 1}")
        named[index] = groups[key]
    return named


def _proposed(recognition: Recognition, faces: dict[int, fg.Face]) -> tuple[dict[int, str], dict[str, dict[str, Any]]]:
    """Without a hook: one locator per recognised feature and plane, with a select line per face."""
    chosen, owner = _partition(recognition, faces)
    names = _plane_features(owner, faces)
    locators: dict[str, dict[str, Any]] = {}
    for index, name in sorted(names.items()):
        base = owner[index]
        item = chosen.get(base)
        if item is None:
            kind = "surface"
        elif faces[index].support_type == "plane" and item.locator_kind in ("plane_face", "slot") and name != base:
            kind = "plane_face"
        elif item.locator_kind == "plane_face" and faces[index].support_type != "plane":
            kind = "round" if faces[index].support_type in ("cylinder", "torus") else "surface"
        else:
            kind = item.locator_kind
        entry = locators.setdefault(name, {"kind": kind, "recognized": [base], "faces": [], "select": []})
        entry["faces"].append(index)
        entry["select"].append(select(faces[index]))
    for name, entry in locators.items():   # a plane not normal to the frame cannot be located: model-define it
        if entry["kind"] == "plane_face" and len({tuple(round(c, 4) for c in faces[i].normal) for i in entry["faces"]}) > 1:
            entry["kind"] = "surface"
    return names, locators


def _hooked(recognition: Recognition, binding: fg.Binding) -> tuple[dict[int, str], dict[str, dict[str, Any]]]:
    """With a hook: its locators as bound to this STEP, and the recognised features each one holds."""
    holders: dict[int, list[str]] = {}
    for item in recognition.features:
        for index in item.faces:
            holders.setdefault(index, []).append(item.id)
    locators = {name: {"kind": feature.kind, "recognized": sorted({r for i in feature.faces for r in holders.get(i, ())}),
                       "faces": list(feature.faces)}
                for name, feature in sorted(binding.features.items())}
    return dict(binding.owner), locators


def _requests(recognition: Recognition, names: dict[int, str], locators: dict[str, dict[str, Any]],
              faces: dict[int, fg.Face]) -> list[dict[str, Any]]:
    """The direct size requests: wall, rib and shell thicknesses, recess widths, lengths and depths; a drafted
    wall's thickness and an inclined-flank width at their reference plane with the angles that go with them; a
    spherical recess's SR and depth."""
    requests: list[dict[str, Any]] = []
    seen: set[Any] = set()
    ids: set[str] = set()

    def add(item: Recognized, name: str, value: float, request: dict[str, Any]) -> None:
        key = (request["operation"], frozenset(request["features"]), request.get("at"))
        if key in seen:
            return
        seen.add(key)
        base = rid = f"{item.id}_{name}"
        while rid in ids:   # a pocket's two widths, a rib's two thicknesses: one id each
            rid = f"{base}_{sum(1 for i in ids if i == base or i.startswith(base + '_')) + 1}"
        ids.add(rid)
        requests.append({"id": rid, **request, "review": f"{item.category} {name} {value:g}"
                                                         f"{'°' if name == 'angle' else ' mm'}"})

    for item in recognition.features:
        if item.category == "dish":   # SR and the depth below the plane it opens through
            dish = names.get(item.faces[0])
            for size in item.sizes:
                entry = names.get(size.between[0][0]) if size.name == "depth" else None
                if dish is not None and (size.name == "radius" or entry is not None):
                    add(item, size.name, size.value, {"operation": size.name,
                                                      "features": [dish] if entry is None else [dish, entry]})
            continue
        at = next((s.at[0] for s in item.sizes if s.at), None)
        for size in item.sizes:
            if size.name == "angle" and at is not None:
                add(item, "angle", size.value, {"operation": "angle", "features": _angle_to(size, item, at, names, faces)})
            if size.name not in DIRECT or not size.between or not size.between[0] or not size.between[1]:
                continue
            if size.name == "depth" and item.category in ("hole", "engraving"):
                continue   # a floored bore and an engraving state their own depth in their callout
            first, second = names.get(size.between[0][0]), names.get(size.between[1][0])
            if first is None or second is None:
                continue
            if size.at:   # between non-parallel planes: stated where they meet the reference plane
                if names.get(size.at[0]) is not None:
                    add(item, size.name, size.value, {"operation": "thickness" if size.name == "thickness" else "width",
                                                      "features": [first] if first == second else [first, second],
                                                      "at": names[size.at[0]]})
                continue
            if first == second or (locators[first]["kind"] == "slot" and locators[second]["kind"] == "slot"):
                continue   # the slot kind states its own width and length
            add(item, size.name, size.value, {"operation": "thickness" if size.name == "thickness" else "plane_separation",
                                              "features": [first, second]})
    return [r for r in requests if None not in r["features"]]


def _angle_to(size: Size, item: Recognized, at: int, names: dict[int, str], faces: dict[int, fg.Face]) -> list[str]:
    """An inclined face's angle request: from a face of the same size pair at right angles to the reference plane
    (a drafted wall's other face: the draft angle), else from the reference plane itself (a flank's angle)."""
    face = size.faces[0]
    normal = fg.unit(faces[at].normal)
    others = [i for s in item.sizes if s.at and face in s.faces for i in s.faces
              if i != face and fg.perpendicular(faces[i].normal, normal)]
    return [names.get(face), names.get(others[0] if others else at)]


def draft(pn: str, recognition: Recognition, faces: dict[int, fg.Face], record: dict[str, Any],
          product: dict[str, Any], binding: fg.Binding | None = None) -> dict[str, Any]:
    """The draft for one part: proposed locators before a hook exists, the hook's own names once it does."""
    names, locators = _hooked(recognition, binding) if binding is not None else _proposed(recognition, faces)
    requests = _requests(recognition, names, locators, faces)
    planes = sorted((f for f in faces.values() if f.support_type == "plane" and names.get(f.index) in locators
                     and locators[names[f.index]]["kind"] == "plane_face"), key=lambda f: -f.area_mm2)
    datums: dict[str, dict[str, str]] = {}
    for label in ("A", "B", "C"):
        for face in planes:
            if all(fg.perpendicular(face.normal, faces[locators[d["feature"]]["faces"][0]].normal)
                   for d in datums.values()) and names[face.index] not in {d["feature"] for d in datums.values()}:
                datums[label] = {"feature": names[face.index], "role": "plane"}
                break
    frame: dict[str, Any] = {"origin": {"intersection": list(datums)}}
    for label, datum in datums.items():   # frame axes along the model's, so locations read as the model's
        on = _where(fg.unit(faces[locators[datum["feature"]]["faces"][0]].normal))
        if on is None or on[0] in frame or len(frame) > 2:
            continue
        spec: dict[str, str] = {"normal_to": label}
        if on[1] == "-":   # an outward normal against the model axis: point the frame toward the far side
            k = "xyz".index(on[0])
            spec["toward"] = names[max(planes, key=lambda f: f.point[k]).index]
        frame[on[0]] = spec
    policy = next((name for name, p in ((product.get("drawing") or {}).get("tolerance_policies") or {}).items()
                   if record.get("process") in (p.get("applies_to") or [])), None)
    block: dict[str, Any] = {"type": "detail", **({"tolerance_policy": policy} if policy else {}),
                             "datum_features": datums,
                             "coordinate_frame": frame,
                             "views": [{"id": "principal", "kind": "orthographic", "normal_to": "A"},
                                       {"id": "front", "kind": "orthographic", "normal_to": "B"}] if len(datums) >= 2 else [],
                             "features": {name: ({"profile": "controlled_model", "profile_tolerance_mm": REVIEW}
                                                 if entry["kind"] == "surface" else {"size": "general"})
                                          for name, entry in sorted(locators.items())},
                             **({"dimensions": [{k: v for k, v in r.items() if k != "review"} for r in requests]}
                                if requests else {}),
                             "edges": f"{REVIEW}: ISO 13715 limits for edges of undefined shape",
                             "surface_texture": f"{REVIEW}: general texture, or {{open: reason}}",
                             "notes": [{"kind": "finish", "text": REVIEW}, {"kind": "process", "text": REVIEW}]}
    in_feature = {i: names[i] for item in recognition.features for i in item.faces if i in names}
    proposal: dict[str, Any] = {
        "part": pn,
        "recognized": [{**item.to_dict(), "summary": item.describe(),
                        "locators": sorted({in_feature.get(i, "UNBOUND") for i in item.faces})}
                       for item in recognition.features],
        "unrecognized": [dict(u) for u in recognition.unrecognized],
        "locators": locators}
    if binding is not None:
        proposal["hook"] = {"locators": len(binding.features), "findings": [dict(f) for f in binding.findings]}
    write_hook = ([] if binding is not None else [
        "Write model.py drawing_features from the proposed locators: rename each to its design role, classify faces "
        "by PARAMS (support type, normal, level, radius: each locator's select lines), never by face index, merge "
        "coplanar planes of one function into one plane_face, rebuild, and rerun this draft for the block in the "
        "hook's names."])
    proposal.update({
        "drawing": block,
        "dimension_requests": requests,
        "review": [
            *write_hook,
            "Check each recognised feature against the design intent; its locators list where its faces are bound.",
            "Keep each direct size request whose feature is functional; a request locates its second plane "
            "from its first in place of that plane's datum location.",
            "Give every size under 0.5 mm, and every fit, its own tolerance; ISO 2768-1 has none there.",
            "A drafted wall's thickness and a width between inclined flanks are stated at a reference plane (at): "
            "keep the proposed plane (a rim, a top, a bed) or name the parting plane, and keep the angle request "
            "that goes with it.",
            "Add a section view through each recess, wall or blind hole the orthographic views show hidden.",
            "Edge fillets and edge breaks may take presentation: general_note; contour radii get their own "
            "dimension.",
            f"Replace every {REVIEW} placeholder, then merge the block with drawing_merge.py.",
            "Run drawing.py: list every feature left undimensioned with its reason in the report."]})
    return proposal


def _error(code: str, message: str) -> int:
    print(json.dumps({"status": "error", "error": {"code": code, "message": message}}))
    return 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("hw", type=Path)
    parser.add_argument("--version")
    parser.add_argument("--part", action="append", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=900.0)
    args = parser.parse_args(argv)
    freecadcmd = freecad_runtime.find_freecadcmd()
    if freecadcmd is None:
        return _error("freecad_unavailable", "no freecadcmd found")
    api = drawing_contract.layout_api()
    try:
        hw = args.hw.resolve()
        _, version_dir, _ = api.built_version(hw, args.version or "latest")
        context = drawing_contract.load_context(hw, version_dir)
        output_root = api.scratch_path(hw, args.output_dir, "--output-dir")
    except (api.LayoutError, drawing_contract.ContractError) as exc:
        return _error(getattr(exc, "code", "invalid_input"), str(exc))
    output_root.mkdir(parents=True, exist_ok=True)
    results = []
    for pn in args.part:
        try:
            part = context.part(pn)
        except drawing_contract.ContractError as exc:
            return _error(exc.code, str(exc))
        work = output_root / f".{pn}.draft-{uuid.uuid4().hex}"
        work.mkdir(parents=True)
        try:
            bound = drawing.run_job(freecadcmd, {"mode": "bind", "step": str(part.step),
                                                 "locators": part.features or {}}, work, args.timeout)
        except drawing.DrawingError as exc:
            return _error(exc.code, str(exc))
        finally:
            shutil.rmtree(work, ignore_errors=True)
        faces = {f["index"]: fg.Face.from_dict(f) for f in bound["faces"]}
        recognition = Recognition.from_dict(bound["recognized"])
        binding = fg.resolve(part.features, bound["bound"], list(faces.values())) if part.features else None
        proposal = draft(pn, recognition, faces, part.record, context.product, binding)
        out = output_root / pn / "drawing_intent.draft.yaml"
        out.parent.mkdir(parents=True, exist_ok=True)
        names = "the hook's locator names" if binding is not None else "proposed locator names"
        header = (f"# Proposed drawing intent for {pn}, from feature recognition on {part.step.name} "
                  f"(sha256 {part.step_sha256[:16]}), in {names}.\n# A proposal to review, not the record: "
                  f"complete the drawing block, then merge it into part.yaml with drawing_merge.py.\n")
        out.write_text(header + yaml.safe_dump(proposal, sort_keys=False, width=120), encoding="utf-8")
        results.append({"pn": pn, "draft": str(out), "hook": binding is not None,
                        "recognized": [f.describe() for f in recognition.features],
                        "unrecognized": len(recognition.unrecognized), "requests": len(proposal["dimension_requests"]),
                        **({"hook_findings": len(binding.findings)} if binding is not None else {})})
    print(json.dumps({"status": "pass", "parts": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
