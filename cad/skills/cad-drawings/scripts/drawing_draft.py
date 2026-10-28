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
  chamfer, arc, engraving and the outline, with its faces and measured sizes (for review only: the
  record never carries values);
- ``unrecognized``: faces no pattern matches, with the reason;
- ``locators``: one proposed ``drawing_features`` entry per feature (kind, faces and a witness point
  with its normal per face) for the ``model.py`` hook, each face in exactly one entry;
- ``drawing``: a proposed ``part.yaml`` drawing block: datums on the largest outer planes, the frame,
  orthographic views, ``size: general`` per locator, and a direct dimension request for every wall,
  rib and shell thickness and every pocket, cutout and notch width, length and depth, so the gate's
  ISO 129-1 functional sizes are stated directly;
- ``review``: what the agent decides before merging: design intent, tolerances, notes, sections.

It never writes part.yaml or model.py. Exit 0 when every draft is written, 2 on invalid input or an
infrastructure failure.
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
from feature_recognition import Recognition, Recognized  # noqa: E402

# a face goes to the first feature that claims it, in this order: the kinds that state the most first
PRIORITY = ("hole", "boss", "shaft", "groove", "slot", "engraving", "arc", "chamfer", "round", "taper", "dish",
            "pocket", "notch", "cutout", "rib", "step", "wall", "outline")
DIRECT = ("thickness", "width", "length", "depth")
ORDER = {category: rank for rank, category in enumerate(PRIORITY)}


def _witness(face: fg.Face) -> dict[str, Any]:
    sample = face.samples[len(face.samples) // 2] if face.samples else None
    point = list(sample[:3]) if sample else list(face.point or face.axis_point or (0.0, 0.0, 0.0))
    normal = list(fg.unit(sample[3:6])) if sample else list(face.normal or (0.0, 0.0, 1.0))
    return {"support_type": face.support_type, "point_mm": [round(c, 6) for c in point],
            "normal": [round(c, 6) for c in normal]}


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


def draft(pn: str, recognition: Recognition, faces: dict[int, fg.Face], record: dict[str, Any],
          product: dict[str, Any]) -> dict[str, Any]:
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
        entry = locators.setdefault(name, {"kind": kind, "frame": "assembly_zero", "recognized": base, "faces": [],
                                           "patches": []})
        entry["faces"].append(index)
        entry["patches"].append(_witness(faces[index]))
    for name, entry in locators.items():   # a plane not normal to the frame cannot be located: model-define it
        if entry["kind"] == "plane_face" and len({tuple(round(c, 4) for c in faces[i].normal) for i in entry["faces"]}) > 1:
            entry["kind"] = "surface"
    requests, seen = [], set()
    for item in recognition.features:
        for size in item.sizes:
            if size.name not in DIRECT or not size.between or not size.between[0] or not size.between[1]:
                continue
            first, second = names.get(size.between[0][0]), names.get(size.between[1][0])
            if first is None or second is None or first == second or frozenset((first, second)) in seen:
                continue
            if locators[first]["kind"] == "slot" and locators[second]["kind"] == "slot":
                continue   # the slot kind states its own width and length
            seen.add(frozenset((first, second)))
            requests.append({"id": f"{item.id}_{size.name}", "operation": "thickness" if size.name == "thickness"
                             else "plane_separation", "features": [first, second],
                             "review": f"{item.category} {size.name} {size.value:g} mm"})
    planes = sorted((f for f in faces.values() if f.support_type == "plane" and names.get(f.index) in locators
                     and locators[names[f.index]]["kind"] == "plane_face"), key=lambda f: -f.area_mm2)
    datums: dict[str, dict[str, str]] = {}
    for label in ("A", "B", "C"):
        for face in planes:
            if all(fg.perpendicular(face.normal, faces[locators[d["feature"]]["faces"][0]].normal)
                   for d in datums.values()) and names[face.index] not in {d["feature"] for d in datums.values()}:
                datums[label] = {"feature": names[face.index], "role": "plane"}
                break
    policy = next((name for name, p in ((product.get("drawing") or {}).get("tolerance_policies") or {}).items()
                   if record.get("process") in (p.get("applies_to") or [])), None)
    block: dict[str, Any] = {"type": "detail", **({"tolerance_policy": policy} if policy else {}),
                             "datum_features": datums,
                             "coordinate_frame": {"origin": {"intersection": list(datums)},
                                                  **({"z": {"normal_to": "A"}} if "A" in datums else {}),
                                                  **({"x": {"normal_to": "B"}} if "B" in datums else {})},
                             "views": [{"id": "principal", "kind": "orthographic", "normal_to": "A"},
                                       {"id": "front", "kind": "orthographic", "normal_to": "B"}] if len(datums) >= 2 else [],
                             "features": {name: ({"profile": "controlled_model", "profile_tolerance_mm": "REVIEW"}
                                                 if entry["kind"] == "surface" else {"size": "general"})
                                          for name, entry in sorted(locators.items())},
                             "dimensions": [{k: v for k, v in r.items() if k != "review"} for r in requests],
                             "edges": "REVIEW: ISO 13715 limits for edges of undefined shape",
                             "surface_texture": "REVIEW: general texture, or {open: reason}",
                             "notes": [{"kind": "finish", "text": "REVIEW"}, {"kind": "process", "text": "REVIEW"}]}
    return {"part": pn, "recognized": [{**item.to_dict(), "summary": item.describe()} for item in recognition.features],
            "unrecognized": [dict(u) for u in recognition.unrecognized],
            "locators": {name: {k: v for k, v in entry.items()} for name, entry in sorted(locators.items())},
            "drawing": block,
            "dimension_requests": requests,
            "review": [
                "Rename every locator to its design role and write model.py drawing_features from the witness "
                "points: classify faces by PARAMS (support type, normal, level, radius), never by face index.",
                "Check each recognised feature against the design intent; merge or split locators where a feature "
                "is one manufacturing operation.",
                "Keep each direct size request whose feature is functional; a request locates its second plane "
                "from its first in place of that plane's datum location.",
                "Give every size under 0.5 mm, and every fit, its own tolerance; ISO 2768-1 has none there.",
                "Add a section view through each recess, wall or blind hole the orthographic views show hidden.",
                "Edge fillets and edge breaks may take presentation: general_note; contour radii get their own "
                "dimension.",
                "Run drawing.py: list every feature left undimensioned with its reason in the report."]}


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
        print(json.dumps({"status": "error", "error": {"code": "freecad_unavailable"}}))
        return 2
    try:
        hw = args.hw.resolve()
        context = drawing_contract.load_context(hw, hw / "versions" / (args.version or drawing.latest_label(hw)))
    except drawing_contract.ContractError as exc:
        print(json.dumps({"status": "error", "error": {"code": exc.code, "message": str(exc)}}))
        return 2
    results = []
    for pn in args.part:
        part = context.part(pn)
        work = args.output_dir / f".{pn}.draft-{uuid.uuid4().hex}"
        work.mkdir(parents=True)
        try:
            bound = drawing.run_job(freecadcmd, {"mode": "bind", "step": str(part.step), "locators": {}}, work,
                                    args.timeout)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        faces = {f["index"]: fg.Face.from_dict(f) for f in bound["faces"]}
        recognition = Recognition.from_dict(bound["recognized"])
        proposal = draft(pn, recognition, faces, part.record, context.product)
        out = args.output_dir / pn / "drawing_intent.draft.yaml"
        out.parent.mkdir(parents=True, exist_ok=True)
        header = (f"# Proposed drawing intent for {pn}, from feature recognition on {part.step.name} "
                  f"(sha256 {part.step_sha256[:16]}).\n# A proposal to review, not the record: merge the drawing "
                  f"block into part.yaml and the locators into model.py's drawing_features hook.\n")
        out.write_text(header + yaml.safe_dump(proposal, sort_keys=False, width=120), encoding="utf-8")
        results.append({"pn": pn, "draft": str(out), "recognized": [f.describe() for f in recognition.features],
                        "unrecognized": len(recognition.unrecognized), "requests": len(proposal["dimension_requests"])})
    print(json.dumps({"status": "pass", "parts": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
