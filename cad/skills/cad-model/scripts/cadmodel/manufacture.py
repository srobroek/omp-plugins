"""The manufacturing outputs of a version's custom-made parts, and the checks that judge them.

`run` writes hw/versions/<V>/manufacturing/<PN>/ for every custom-made part (cad-record layout
`custom_made`): part.step (AP242, exact B-rep, millimetres), part.stl for an FDM part (binary STL,
millimetres) and manufacturing.json. The state is the installed definition, or the
`build_manufacture(params)` shape of a part whose part.yaml declares `manufacture.relationship:
different`. `inspect` reads the written files back and judges them; `run` seals the version only
when no part fails a blocking check, and `check` repeats `inspect` on the sealed files.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from cadmodel import mesh, occ, orientation, stepfile
from cadmodel.motion import load_pose
from cadmodel.record import load_layout

SIDECAR = "manufacturing.json"
SIDECAR_SCHEMA = 1
BED_MM = 1e-6  # bed contact, and how far a measured bound may pass a reserved extent
FLOAT32_EPS = 2.0 ** -23  # STL stores float32 coordinates


@dataclass(frozen=True)
class Plan:
    """What `run` makes of one custom-made part, decided from its record before any kernel runs."""

    pn: str
    record: Mapping[str, Any]  # its part.yaml
    policy: Any  # cad-record layout ManufacturePolicy


def plan(records: Mapping[str, Mapping[str, Any]]) -> tuple[dict[str, Plan], list[tuple[str, str]]]:
    """A Plan per custom-made part record, and (PN, message) for each record whose declaration is refused."""
    layout = load_layout()
    plans: dict[str, Plan] = {}
    refused: list[tuple[str, str]] = []
    for pn, record in sorted(records.items()):
        if not layout.custom_made(record):
            continue
        try:
            policy = layout.manufacture_policy(record)
        except (layout.LayoutError, TypeError, ValueError) as error:
            refused.append((pn, f"part.yaml manufacture: {error}"))
            continue
        declared = record.get("manufacture") or {}
        if policy.relationship == "different":
            missing = [key for key in ("state", "reason", "decision") if not declared.get(key)]
            if missing:
                refused.append((pn, f"part.yaml manufacture.relationship: different also needs {', '.join(missing)}"))
                continue
            relative, absolute = policy.volume_rel_tolerance, policy.volume_abs_tolerance_mm3
            if not (0 <= relative <= 1 and absolute >= 0 and (relative > 0 or absolute > 0)):
                refused.append((pn, f"part.yaml manufacture volume tolerance refused: volume_rel_tolerance {relative} "
                                    f"must be in (0, 1], volume_abs_tolerance_mm3 {absolute} must be positive"))
                continue
        plans[pn] = Plan(pn, record, policy)
    return plans, refused


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def facts(plan: Plan, product: str, installed: Mapping[str, Any], native: Mapping[str, Any],
          volume: orientation.BuildVolume | None, path: str) -> dict[str, Any]:
    """The derived claims of one part's outputs, before placement: identity, state, tolerance and inputs."""
    record, policy = plan.record, plan.policy
    procurement = record.get("procurement") if isinstance(record.get("procurement"), Mapping) else {}
    fdm = record.get("process") == "fdm"
    return {
        "schema_version": SIDECAR_SCHEMA, "PN": plan.pn, "rev": record.get("rev"), "title": record.get("title"),
        "product": product, "material": record.get("material"), "process": record.get("process"),
        "finish": record.get("finish"),
        "eligibility": {"make_buy": record.get("make_buy"), "procurement_mode": procurement.get("mode")},
        "state": {"relationship": policy.relationship, "name": policy.state, "reason": policy.reason,
                  "decision": policy.decision,
                  "source": "build_manufacture" if policy.relationship == "different" else "installed definition"},
        "tolerance": {"volume_rel": policy.volume_rel_tolerance, "volume_abs_mm3": policy.volume_abs_tolerance_mm3,
                      "allowed_mm3": policy.volume_tolerance_mm3(installed["kernel_volume_mm3"])},
        "installed": dict(installed),
        "native": {key: native[key] for key in ("kernel_volume_mm3", "kernel_solids", "kernel_valid", "kernel_errors")},
        "units": {"length": "mm"}, "up": "+Z",
        "build_volume": volume.describe() if fdm and volume is not None else None,
        "mesh": ({"format": "binary STL", "units": "mm", "linear_deflection_mm": policy.linear_deflection_mm,
                  "angular_deflection_rad": policy.angular_deflection_rad} if "part.stl" in policy.outputs else None),
        "path": path, "outputs": list(policy.outputs),
    }


def export(target: Path, entry: Mapping[str, Any], shape: Any, volume: orientation.BuildVolume | None) -> dict[str, Any]:
    """Place `shape` (the manufacturing state, in its model frame) and write part.step, and part.stl when
    the entry lists it, into `target`. Returns the placement facts.

    FDM parts take a fit from cadmodel.orientation and sit on the bed; without a declared volume, or
    without a fit, they keep their native +Z. Other processes keep the model frame (identity)."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform

    pose = load_pose()
    method, name, bed = "identity", "xyz", None
    rotation = orientation.IDENTITY
    if entry["process"] == "fdm":
        found = orientation.fit(shape, volume)[1] if volume is not None else None
        if found is not None:
            method, name, rotation = found.method, found.orientation, found.rotation
        else:
            method = "native"
        placement = orientation.bed_placement(shape, rotation, volume)
        bed = "centred" if volume is not None else "origin"
    else:
        placement = pose.Rigid.identity()
    placed = BRepBuilderAPI_Transform(shape, pose.to_trsf(placement), True).Shape()
    target.mkdir(parents=True)
    pose.write_part_step(target / "part.step", pose.Part(entry["PN"], entry["product"], placed))
    if entry["mesh"] is not None:
        written, problem = read_part(target / "part.step", entry["PN"])
        if written is None:
            raise occ.GeometryError(f"cannot tessellate {target / 'part.step'}: {problem}")
        mesh.write_stl(written.shape, target / "part.stl", entry["mesh"]["linear_deflection_mm"],
                       entry["mesh"]["angular_deflection_rad"])
    return {"method": method, "orientation": name, "bed": bed,
            "transform": [[*(v + 0.0 for v in placement.rot[i]), placement.trans[i] + 0.0] for i in range(3)],
            "determinant": orientation.determinant(placement.rot)}


def read_part(path: Path, pn: str) -> tuple[Any, str | None]:
    """(the cad-motion Part of a one-product part STEP, None), or (None, why it cannot be read as one)."""
    pose = load_pose()
    try:
        step = pose.read_assembly_step(path)
    except (pose.MotionError, OSError) as error:
        return None, str(error)
    if set(step.definitions) != {pn} or len(step.components) != 1:
        return None, f"holds products {sorted(step.definitions)} in {len(step.components)} components, expected one {pn}"
    if not step.components[0].location.close_to(pose.Rigid.identity()):
        return None, "places its product with a location; the geometry must sit in the bed frame itself"
    return step.definitions[pn], None


def _judge(conditions: Mapping[str, bool], **fields: Any) -> dict[str, Any]:
    """One blocking sub-check: pass when every condition holds, else fail naming the ones that do not."""
    failed = [name for name, held in conditions.items() if not held]
    return {"status": "fail" if failed else "pass", "blocking": True, "failed": failed, **fields}


def _incomplete(message: str, **fields: Any) -> dict[str, Any]:
    """A sub-check that cannot pass yet and never blocks: the output is incomplete, not wrong."""
    return {"status": "warn", "blocking": False, "failed": [], "message": message, **fields}


def _box(shape: Any) -> tuple[list[float], list[float]]:
    low, high = occ.bbox(shape)
    return list(low), list(high)


def inspect(target: Path, entry: Mapping[str, Any], record: Mapping[str, Any], required: Iterable[str],
            hashes: Mapping[str, str] | None = None) -> tuple[dict[str, Any], Any]:
    """Judge the outputs in `target` against `entry` (the manifest facts) and `record` (the part.yaml
    snapshot). `required` are the file names that must be there and no others; `hashes` binds their
    bytes (check passes the manifest's). Returns (the part's row, its read-back STEP shape or None)."""
    native, installed, allowed = entry["native"], entry["installed"], entry["tolerance"]["allowed_mm3"]
    required = sorted(required)
    present = sorted(p.name for p in target.iterdir()) if target.is_dir() else []
    changed = sorted(name for name, sha in (hashes or {}).items() if name in present and sha256(target / name) != sha)
    fields = ("PN", "rev", "material", "process", "finish")
    difference = abs(native["kernel_volume_mm3"] - installed["kernel_volume_mm3"])
    checks: dict[str, Any] = {
        "outputs": _judge({"required_present": all(name in present for name in required),
                           "no_other_files": all(name in required for name in present), "hashes_match": not changed},
                          required=required, present=present, changed=changed),
        "record": _judge({f"same_{key.lower()}": entry.get(key) == record.get(key) for key in fields},
                         record={key: record.get(key) for key in fields}),
        "native": _judge({"valid": bool(native["kernel_valid"]), "solid": native["kernel_solids"] > 0,
                          "positive_volume": native["kernel_volume_mm3"] > 0}, **native),
        "identity": _judge({"volume_within_tolerance": difference <= allowed,
                            "same_solids": native["kernel_solids"] == installed["kernel_solids"]},
                           installed_volume_mm3=installed["kernel_volume_mm3"],
                           manufacture_volume_mm3=native["kernel_volume_mm3"], difference_mm3=difference,
                           allowed_mm3=allowed, installed_solids=installed["kernel_solids"],
                           manufacture_solids=native["kernel_solids"]),
    }
    part = None
    if "part.step" in present:
        part, checks["step"] = _step(target / "part.step", entry)
    else:
        checks["step"] = _judge({"present": False})
    if entry["mesh"] is not None:
        checks["mesh"] = (_mesh(target / "part.stl", entry, part.shape) if "part.stl" in present and part is not None
                          else _judge({"present_with_readable_step": False}))
    checks["placement"] = _placement(entry, part.shape if part is not None else None)
    blocking = sorted(name for name, row in checks.items() if row["status"] == "fail")
    complete = not blocking and all(row["status"] == "pass" for row in checks.values())
    row = {"status": "fail" if blocking else ("pass" if complete else "warn"), "complete": complete,
           "blocking_failures": blocking, "checks": checks}
    return row, part.shape if part is not None else None


def failure_message(row: Mapping[str, Any]) -> str:
    """The failed conditions of a part row, each check's message after them, for a run finding."""
    parts = []
    for name in row["blocking_failures"]:
        check = row["checks"][name]
        parts.append(f"{name}: " + "; ".join(filter(None, (", ".join(check["failed"]), check.get("message")))))
    return "; ".join(parts)


def _step(path: Path, entry: Mapping[str, Any]) -> tuple[Any, dict[str, Any]]:
    """The part STEP read back: AP242 in millimetres, one product named `<PN> <title>` in place, a valid
    B-rep with the native solid count, and the native volume within the read-back drift."""
    native = entry["native"]
    schema, units = stepfile.schema(path), stepfile.length_units(path)
    part, problem = read_part(path, entry["PN"])
    header = {"ap242": schema is not None and schema.startswith(stepfile.AP242), "millimetres": units == ["mm"]}
    if part is None:
        return None, _judge({**header, "one_product_in_place": False}, schema=schema, units=units, message=problem)
    errors = occ.check_statuses(part.shape)
    volume, solids = occ.volume(part.shape), occ.count(part.shape, "SOLID")
    rel = abs(volume - native["kernel_volume_mm3"]) / max(abs(native["kernel_volume_mm3"]), 1e-12)
    low, high = _box(part.shape)
    return part, _judge({**header, "one_product_in_place": True, "product_name": part.name == entry["product"],
                         "valid": not errors, "same_solids": solids == native["kernel_solids"],
                         "volume_drift": rel <= stepfile.READBACK_REL},
                        schema=schema, units=units, product=part.name, errors=errors, solids=solids,
                        shells=occ.count(part.shape, "SHELL"), volume_mm3=volume, rel_error=rel,
                        tolerance_rel=stepfile.READBACK_REL, bbox_mm={"min": low, "max": high})


def _mesh(path: Path, entry: Mapping[str, Any], shape: Any) -> dict[str, Any]:
    """The STL against the STEP it was tessellated from: binary, finite, without degenerate triangles,
    closed and consistently wound outward, one mesh shell per B-rep shell, and within the declared
    chord deviation of the exact solid: in volume (at most area x deflection) and on each box face.
    Welding is by position only; nothing is repaired, so a crack stays open."""
    try:
        report = mesh.stl_report(path)
    except Exception as error:  # noqa: BLE001 - an unreadable STL is a failed output, not an infrastructure error
        return _judge({"readable": False}, message=f"cannot read {path.name}: {error}")
    deflection = entry["mesh"]["linear_deflection_mm"]
    step_volume, area = occ.volume(shape), occ.area(shape)
    low, high = _box(shape)
    slack = 2 * FLOAT32_EPS * max(report["max_abs_mm"], 1.0) + 1e-9  # float32 rounding of a coordinate
    bound = area * (deflection + slack)
    finite = report["finite"]
    volume_error = abs(report["volume_mm3"] - step_volume) if finite else None
    m_low, m_high = report["bbox_mm"]["min"], report["bbox_mm"]["max"]
    shells = occ.count(shape, "SHELL")
    return _judge({"binary": report["binary"], "finite": finite,
                   "no_degenerate_triangles": finite and report["degenerate_triangles"] == 0,
                   "watertight": report["watertight"], "winding_consistent": report["winding_consistent"],
                   "outward": finite and report["volume_mm3"] > 0, "shells": report["shells"] == shells,
                   "volume_within_deflection": finite and volume_error <= bound,
                   "box_within_deflection": all(low[i] - slack <= m_low[i] <= low[i] + deflection + slack
                                                and high[i] - deflection - slack <= m_high[i] <= high[i] + slack
                                                for i in range(3))},
                  **report, step_shells=shells, step_volume_mm3=step_volume, volume_error_mm3=volume_error,
                  volume_bound_mm3=bound, linear_deflection_mm=deflection,
                  angular_deflection_rad=entry["mesh"]["angular_deflection_rad"])


def _placement(entry: Mapping[str, Any], shape: Any) -> dict[str, Any]:
    """A proper transform. An FDM part touches the bed at Z 0 and, with a declared volume, sits inside its
    reserved extents (X and Y: margin to size - margin; Z: 0 to size - 2 margin). Any other part keeps
    its model frame."""
    placement = entry["placement"]
    transform = placement["transform"]
    proper = orientation.is_proper(tuple(tuple(row[:3]) for row in transform))  # type: ignore[arg-type]
    if shape is None:
        return _judge({"proper_rotation": proper, "readable_step": False}, **placement)
    low, high = _box(shape)
    facts = {**placement, "bbox_mm": {"min": low, "max": high}}
    if entry["process"] != "fdm":
        identity = transform == [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]
        return _judge({"proper_rotation": proper, "model_frame": identity}, **facts)
    on_bed = _judge({"proper_rotation": proper, "bed_contact": abs(low[2]) <= BED_MM}, **facts)
    volume = entry["build_volume"]
    if on_bed["status"] == "fail":
        return on_bed
    if volume is None:
        return _incomplete("no printer build volume is declared; exported at its native +Z", **facts)
    margin, size = volume["margin_mm"], volume["size_mm"]
    reserved = {"min": [margin, margin, 0.0], "max": [size[0] - margin, size[1] - margin, size[2] - 2.0 * margin]}
    fits = all(low[i] >= reserved["min"][i] - BED_MM and high[i] <= reserved["max"][i] + BED_MM for i in range(3))
    if not fits:
        return _incomplete("the exported part does not fit the declared build volume", **facts, reserved_mm=reserved)
    return {**on_bed, "reserved_mm": reserved}


def _relative(hw: Path, label: str, pn: str) -> str:
    """manufacturing/<PN>, the part's folder below its version, from the cad-record layout."""
    layout = load_layout()
    return layout.manufacturing_dir(hw, label, pn).relative_to(layout.version_dir(hw, label)).as_posix()


def make(work: Path, hw: Path, label: str, plans: Mapping[str, Plan], products: Mapping[str, str],
         definitions: Mapping[str, Any], built: Mapping[str, Mapping[str, Any]], states: Mapping[str, Any],
         volume: orientation.BuildVolume | None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Write and judge the outputs of every planned part below the partial version folder `work`.

    `definitions` are the installed read-back Parts, `built` the runner's per-part results and
    `states` the read-back `build_manufacture` Parts. Returns (the manifest entry of each part, its
    row); a part without a model gets an incomplete entry and no folder."""
    entries: dict[str, Any] = {}
    rows: dict[str, Any] = {}
    for pn, part_plan in sorted(plans.items()):
        if pn not in definitions:
            entries[pn] = rows[pn] = {"PN": pn, "path": None, "status": "warn", "complete": False,
                                      "blocking_failures": [],
                                      "message": f"hw/parts/{pn}/ has no model.py, so no manufacturing output was built"}
            continue
        result, different = built[pn], part_plan.policy.relationship == "different"
        installed = {"step": f"parts/{pn}.step", "sha256": sha256(work / "parts" / f"{pn}.step"),
                     "kernel_volume_mm3": result["kernel_volume_mm3"], "kernel_solids": result["kernel_solids"]}
        entry = facts(part_plan, products[pn], installed, result["manufacture"] if different else result, volume,
                      _relative(hw, label, pn))
        target = work / entry["path"]
        written = [name for name in part_plan.policy.outputs if name != SIDECAR]
        try:
            entry["placement"] = export(target, entry, (states[pn] if different else definitions[pn]).shape, volume)
        except (occ.GeometryError, load_pose().MotionError) as error:
            rows[pn] = {"status": "fail", "complete": False, "blocking_failures": ["export"],
                        "checks": {"export": _judge({"written": False}, message=str(error))}}
            entries[pn] = {**entry, **rows[pn]}
            continue
        row, _ = inspect(target, entry, part_plan.record, written)
        outputs = {name: sha256(target / name) for name in written if (target / name).is_file()}
        (target / SIDECAR).write_text(json.dumps({**entry, "files": outputs, **row}, indent=2) + "\n", encoding="utf-8")
        rows[pn] = row
        entries[pn] = {**entry, "files": {**outputs, SIDECAR: sha256(target / SIDECAR)},
                       **{key: row[key] for key in ("status", "complete", "blocking_failures")}}
    return entries, rows


def version_check(folder: Path, manifest: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """`checks.manufacturing` of the built version in `folder`, and each part's read-back manufacturing shape.

    The custom-made parts come from the version's record snapshot. Each manifest entry's files are
    judged again by `inspect`, bound to the manifest's hashes. A version built before manufacturing
    outputs warns as incomplete without blocking."""
    import yaml

    entries = manifest.get("manufacturing")
    snapshot = folder / "record"
    if not isinstance(entries, Mapping) or not snapshot.is_dir():
        return {"status": "warn", "blocking": False, "complete": False, "blocking_failures": [], "parts": {},
                "message": "this version was built before manufacturing outputs; build a new version"}, {}
    layout = load_layout()
    records: dict[str, Any] = {}
    for path in sorted((snapshot / "parts").glob("*/part.yaml")):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            data = None
        records[path.parent.name] = data if isinstance(data, dict) else {}
    custom = {pn for pn, data in records.items() if layout.custom_made(data)}
    made = folder / "manufacturing"
    on_disk = {path.name for path in made.iterdir()} if made.is_dir() else set()
    hw, label = folder.parent.parent, folder.name
    rows: dict[str, Any] = {}
    shapes: dict[str, Any] = {}
    for pn in sorted(custom | set(entries) | on_disk):
        entry = entries.get(pn)
        try:
            expected_path = _relative(hw, label, pn)
        except layout.LayoutError:
            expected_path = None
        if entry is None:
            why = ("is custom-made in the record snapshot but has no manufacturing entry" if pn in custom
                   else "has a manufacturing folder but no manifest entry")
        elif pn not in custom:
            why = "has a manufacturing entry but is not custom-made in the record snapshot"
        elif entry.get("path") not in (None, expected_path):
            why = f"has its manufacturing entry at {entry['path']!r}, not {expected_path!r}"
        else:
            why = None
        if why is not None:
            rows[pn] = {"status": "fail", "complete": False, "blocking_failures": ["inventory"], "message": f"{pn} {why}"}
        elif entry.get("path") is None:
            rows[pn] = {"status": "warn", "complete": False, "blocking_failures": [], "message": entry.get("message")}
        else:
            rows[pn], shape = inspect(folder / entry["path"], entry, records[pn], entry["outputs"], entry["files"])
            if shape is not None:
                shapes[pn] = shape
    blocking = sorted(pn for pn, row in rows.items() if row["status"] == "fail")
    complete = all(row["complete"] for row in rows.values())
    return {"status": "fail" if blocking else ("pass" if complete else "warn"), "blocking": True,
            "complete": complete, "blocking_failures": blocking, "parts": rows}, shapes
