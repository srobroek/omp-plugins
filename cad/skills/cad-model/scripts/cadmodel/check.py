"""`check`: blocking and advisory geometry checks over one built version.

Definition checks (STEP read-back volume, BRep validity, solid structure, slivers) run once per PN;
assembly checks run per occurrence: every component of assembly.step must be an occurrence of the
manifest at its recorded placement, interference covers every occurrence pair (two occurrences of
one PN included), each clearance requirement of the version's interfaces.yaml holds on its pair,
connectivity welds occurrences, and each occurrence's GLB node is judged watertight alone. A version
1 version (written before occurrences) reads as one occurrence per PN. Every file must match the
manifest inventory (`artifact_integrity`), and the manufacturing outputs of each custom-made part
are judged again on the sealed files (`manufacturing`, cadmodel.manufacture); `build_volume` fits
each FDM part in the state it is printed in, against the printer of the version's record snapshot.
Declarations (fits, inserts, clearance requirements and their margins) come from that snapshot too.

Pairs are measured by cad-motion's pair measurer under the sweep's rule, cache, mesh bounds and
suspect checks, on the per-part STEP definitions (their DATA geometry ids) placed as the sweep
places them: chain-relative at the nominal pose. So a nominal sweep sample and the static check
share exact readings. Fast mode, the default, leaves a far pair unmeasured on its own bounds: its
row carries the method and the bounds, never a distance. A declared interference fit and a fixed
joint always get a reading, and a pair that could be an occurrence's nearest is measured, so
`connection` and the minimum clearance stay exact. `exact` measures every pair. An unresolved
suspect reading fails its pair. A clearance at or above its requirement but below requirement +
margin warns (`margin`). `changed_only` measures only the pairs incremental.select_pairs selects
against a baseline version; its report is partial (`scope.complete` false) and skips `connection`.
"""

from __future__ import annotations

import importlib.util
import math
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from cadmodel import build, manufacture, mesh, occ, orientation, stepfile
from cadmodel.motion import load_incremental, load_mesh_bound, load_pair_measure, load_pair_policy, load_pose
from cadmodel.record import load_layout
from cadmodel.stepfile import AP242, READBACK_REL

Pair = tuple[str, str]
SKILLS = Path(__file__).resolve().parents[3]
VERSIONS_SCRIPT = SKILLS / "cad-render" / "scripts" / "versions.py"
DESIGN_RULES_SCRIPT = SKILLS / "cad-record" / "scripts" / "design_rules.py"

PLACEMENT_MM = 1e-6          # assembly.step component location vs the manifest placement
CONTACT_MM = 0.01            # distance at or below which two parts touch
FLOAT_GAP_MM = 2.0           # beyond this a part is disconnected rather than floating
SLIVER_FACE_MM2 = 1e-3       # faces smaller than this are slivers (advisory)
LOOSE_TOLERANCE_MM = 0.01    # vertex/edge/face tolerance above this is loose (advisory)
DRIVER_STEP = 0.1            # deg or mm: a suspect's re-evaluations move each independent joint, as the sweep's do


def _rel(a: float, b: float) -> float:
    return abs(a - b) / max(abs(b), 1e-12)


def _status(ok: bool, blocking: bool = True) -> str:
    return "pass" if ok else ("fail" if blocking else "warn")


def _script(name: str, path: Path) -> Any:
    """A sibling skill's stdlib script module, loaded once per process under `name`."""
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise build.UsageError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _versions() -> Any:
    """cad-render's stdlib version reader: a version's occurrences, version 1 files normalized."""
    return _script("cad_render_versions", VERSIONS_SCRIPT)


def clearance_margins(record: Path) -> Any:
    """cad-record's clearance margins (design_rules.ClearanceMargins) of record folder `record`."""
    try:
        return _script("cad_record_design_rules", DESIGN_RULES_SCRIPT).load_clearance_margins(record)
    except ValueError as error:
        raise build.UsageError(str(error)) from error


def built_inventory(occurrences: Mapping[str, Any]) -> Any:
    """The version's occurrences as an assembly_data.Inventory, for reference resolution."""
    data = load_pose().assembly_data
    return data.Inventory(tuple(data.Occurrence(oid, o.pn, data.IDENTITY, o.ref.startswith("@"))
                                for oid, o in occurrences.items()))


def resolve_pairs(pairs: Iterable[tuple[str, str]], inventory: Any, option: str) -> list[tuple[str, str]]:
    """REF:REF options as sorted occurrence-id pairs."""
    resolved = []
    for a, b in pairs:
        try:
            ids = tuple(sorted((inventory.resolve(a).id, inventory.resolve(b).id)))
        except load_pose().assembly_data.UnresolvedReference as error:
            raise build.UsageError(f"{option} {a}:{b}: {error}") from None
        if ids[0] == ids[1]:
            raise build.UsageError(f"{option} {a}:{b}: both ends are one occurrence")
        resolved.append(ids)
    return resolved  # type: ignore[return-value]


def step_readback(folder: Path, manifest: dict[str, Any], parts: dict[str, Any], step: Any,
                  occurrences: Mapping[str, Any]) -> dict[str, Any]:
    """AP242 schema, names and read-back volumes per PN definition; one assembly definition per PN and
    one component per occurrence, each identified exactly and at its manifest placement."""
    pose = load_pose()
    expected = manifest["parts"]
    files = {"assembly.step": stepfile.schema(folder / "assembly.step"),
             **{info["step"]: stepfile.schema(folder / info["step"]) for info in expected.values()}}
    text = (folder / "assembly.step").read_text(encoding="utf-8", errors="replace")
    definitions = step.definitions
    rows = {}
    for pn, info in sorted(expected.items()):
        kernel_v = info["kernel_volume_mm3"]
        part_v = occ.volume(parts[pn].shape) if pn in parts else None
        asm_v = occ.volume(definitions[pn].shape) if pn in definitions else None
        rows[pn] = {
            "expected_name": info["product"],
            "part_step_name": parts[pn].name if pn in parts else None,
            "assembly_name": definitions[pn].name if pn in definitions else None,
            "kernel_volume_mm3": kernel_v,
            "part_step_volume_mm3": part_v,
            "assembly_volume_mm3": asm_v,
            "part_step_rel_error": _rel(part_v, kernel_v) if part_v is not None else None,
            "assembly_rel_error": _rel(asm_v, kernel_v) if asm_v is not None else None,
            "kernel_solids": info["kernel_solids"],
            "part_step_solids": occ.count(parts[pn].shape, "SOLID") if pn in parts else None,
        }
        row = rows[pn]
        row["ok"] = (row["part_step_name"] == row["assembly_name"] == info["product"]
                     and row["part_step_rel_error"] is not None and row["part_step_rel_error"] <= READBACK_REL
                     and row["assembly_rel_error"] is not None and row["assembly_rel_error"] <= READBACK_REL
                     and row["part_step_solids"] == row["kernel_solids"])
    placed_rows: dict[str, Any] = {}
    unbound: list[str] = []
    for component in step.components:
        oid = component.occurrence if component.occurrence is not None else component.pn
        built = occurrences.get(oid)
        if built is None or built.pn != component.pn or oid in placed_rows:
            unbound.append(component.name)
            continue
        target = pose.Rigid(tuple(tuple(r[:3]) for r in built.transform), tuple(r[3] for r in built.transform))
        error_mm = max(abs(a - b) for a, b in zip(component.location.trans, target.trans))
        error_rot = max(abs(a - b) for ra, rb in zip(component.location.rot, target.rot) for a, b in zip(ra, rb))
        placed_rows[oid] = {"ref": built.ref, "PN": built.pn, "component": component.name,
                            "placement_error_mm": error_mm, "rotation_error": error_rot,
                            "ok": error_mm <= PLACEMENT_MM and error_rot <= pose.PLACEMENT_TOL_ROT}
    missing = sorted(o.ref for oid, o in occurrences.items() if oid not in placed_rows)
    extra = sorted(set(definitions) - set(expected))
    top_ok = f"PRODUCT('{manifest['top_product']}'" in text
    schema_ok = all(s is not None and s.startswith(AP242) for s in files.values())
    ok = (schema_ok and all(r["ok"] for r in rows.values()) and not extra and top_ok and not unbound and not missing
          and all(r["ok"] for r in placed_rows.values()))
    return {"status": _status(ok), "blocking": True, "schema": files, "top_product": manifest["top_product"],
            "top_product_found": top_ok, "unexpected_products": extra, "definitions": len(definitions),
            "components": len(step.components), "unbound_components": unbound, "missing_occurrences": missing,
            "tolerance_rel": READBACK_REL, "placement_tolerance_mm": PLACEMENT_MM, "parts": rows,
            "occurrences": placed_rows}


def brep_validity(parts: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    """BRepCheck on the kernel's in-memory shape (from the runner) and on the STEP read-back.

    Both count: the STEP round trip can turn an invalid open-shell solid into a valid shell.
    """
    rows = {}
    for pn, part in sorted(parts.items()):
        built = manifest["parts"][pn]
        step_errors = occ.check_statuses(part.shape)
        rows[pn] = {"valid": built["kernel_valid"] and not step_errors, "kernel_valid": built["kernel_valid"],
                    "kernel_errors": built["kernel_errors"], "step_valid": not step_errors, "step_errors": step_errors}
    return {"status": _status(all(r["valid"] for r in rows.values())), "blocking": True, "parts": rows}


def solid_structure(parts: dict[str, Any], expected: dict[str, int], baseline: dict[str, Any] | None,
                    baseline_label: str | None) -> dict[str, Any]:
    unknown = sorted(set(expected) - set(parts))
    rows = {}
    for pn, part in sorted(parts.items()):
        solids, shells = occ.count(part.shape, "SOLID"), occ.count(part.shape, "SHELL")
        if pn in expected:
            want, source = expected[pn], "expected"
        elif baseline is not None and pn in baseline:
            want, source = baseline[pn]["solids"], baseline_label
        else:
            want, source = None, None
        rows[pn] = {"solids": solids, "shells": shells, "expected_solids": want, "baseline": source,
                    "ok": solids > 0 and (want is None or solids == want)}
    return {"status": _status(all(r["ok"] for r in rows.values()) and not unknown), "blocking": True,
            "unknown_parts": unknown, "parts": rows}


@dataclass(frozen=True)
class PairSpec:
    """One occurrence pair's measurement: definition `b` placed by `placement` (pose.Rigid) in
    definition `a`'s frame; `minimum_mm`, its greatest clearance requirement plus that requirement's
    margin; `require_exact`, a verdict that needs a kernel reading (a declared interference fit must
    show its overlap, a fixed joint its touch)."""

    a: str
    b: str
    placement: Any
    minimum_mm: float = 0.0
    require_exact: bool = False


def mesh_bounds(shapes: Mapping[str, Any]) -> tuple[Any, str]:
    """(mesh_bound.MeshBounds over `shapes`, a description), or (None, why not) without numpy or
    python-fcl: then a far pair clears on its exact box gap alone."""
    try:
        module = load_mesh_bound()
    except ImportError as error:
        print(f"check: mesh bounds unavailable, the box gap alone clears: {error}", file=sys.stderr)
        return None, f"unavailable: {error}"
    bounds = module.MeshBounds(shapes)
    return bounds, f"linear {bounds.linear:g} mm, angular {bounds.angular:g} rad"


def _row(outcome: Any) -> dict[str, Any]:
    """A pair's geometry row: exact readings keep their fields; a cleared pair carries its method
    and bounds, never a distance; a failure its error."""
    measure = load_pair_measure()
    if isinstance(outcome, measure.Measured):
        return {"clearance_mm": outcome.distance_mm, "interference_mm3": outcome.overlap_mm3, "method": "exact"}
    if isinstance(outcome, measure.Cleared):
        row = {"clearance_mm": None, "interference_mm3": None, "method": outcome.method, "lower_mm": outcome.lower_mm,
               "upper_mm": outcome.upper_mm if math.isfinite(outcome.upper_mm) else None}
        if outcome.mesh_mm is not None:
            row["mesh_mm"] = outcome.mesh_mm
        return row
    message = outcome.message if isinstance(outcome, measure.Failure) else f"not measured: {outcome!r}"
    return {"clearance_mm": None, "interference_mm3": None, "method": None, "error": message}


def _suspect_report(suspect: Any, pairs: Sequence[Pair]) -> dict[str, Any]:
    measure = load_pair_measure()
    return {"pairs": [list(pair) for pair in sorted({pairs[i] for i in suspect.requests})],
            "distance_mm": suspect.distance_mm, "overlap_mm3": suspect.overlap_mm3, "lower_mm": suspect.lower_mm,
            "upper_mm": suspect.upper_mm if math.isfinite(suspect.upper_mm) else None,
            "resolved": suspect.resolved, "cached": suspect.cached,
            "reevaluated": [{"label": label, **({"error": outcome.message} if isinstance(outcome, measure.Failure)
                                                else {"distance_mm": outcome.distance_mm,
                                                      "overlap_mm3": outcome.overlap_mm3})}
                            for label, outcome, _ in suspect.reevaluated]}


def _nearest_candidates(rows: Mapping[Pair, dict[str, Any]]) -> list[Pair]:
    """Cleared pairs that could still be an occurrence's nearest: their lower bound lies below that
    occurrence's smallest exact clearance and below the smallest upper bound of its cleared pairs.
    Measuring them exactly keeps every nearest neighbour, and with it the global minimum, exact."""
    exact: dict[str, float] = {}
    upper: dict[str, float] = {}
    for pair, row in rows.items():
        for oid in pair:
            if row["method"] == "exact":
                exact[oid] = min(exact.get(oid, math.inf), row["clearance_mm"])
            elif row["method"] is not None:
                upper[oid] = min(upper.get(oid, math.inf), math.inf if row["upper_mm"] is None else row["upper_mm"])
    return [pair for pair, row in sorted(rows.items()) if row["method"] not in (None, "exact")
            and any(row["lower_mm"] < min(exact.get(oid, math.inf), upper.get(oid, math.inf)) for oid in pair)]


def pair_geometry(parts: Mapping[str, Any], specs: Mapping[Pair, PairSpec], *, cache: Any = None, jobs: int = 1,
                  mesh: Any = None, exact: bool = False, neighbours: Callable[[Pair], list[tuple[str, Any]]] | None = None,
                  nearest: bool = True) -> tuple[dict[Pair, dict[str, Any]], list[dict[str, Any]], Any]:
    """Geometry rows of the occurrence pairs of `specs` at the built pose, the suspect readings, and
    the measurer (its counters say what was evaluated and what the cache answered).

    `parts` are the version's per-part STEP definitions (pose.Part with their DATA geometry ids).
    The measurement is cad-motion's pair measurer, the one `sweep.py` uses, with its rule, `cache`
    (pair_measure.PairCache), `mesh` bounds and suspect checks, in this process or in `jobs` worker
    processes. Fast mode (the default) leaves a pair unmeasured when its own lower bound clears the
    overlap gate, its minimum_mm and the rule's band; `exact` measures every pair. A suspect reading
    is re-evaluated at `neighbours(pair)` (else b moved +-pair_measure.REEVALUATE_MM) and swapped;
    an unresolved one is a failed row. With `nearest`, cleared pairs that could be an occurrence's
    nearest are then measured exactly (`_nearest_candidates`)."""
    measure = load_pair_measure()
    pairs = sorted(specs)
    used = {pn for spec in specs.values() for pn in (spec.a, spec.b)}
    definitions = {pn: parts[pn] for pn in sorted(used)}
    rule = measure.RuleVersion.current(mesh)
    measurer = measure.PairMeasurer({pn: part.shape for pn, part in definitions.items()},
                                    geometry_ids=load_pose().geometry_ids(definitions), rule=rule, jobs=jobs,
                                    cache=cache, mesh=mesh)

    def requests(chosen: Sequence[Pair], mode: str) -> list[Any]:
        return [measure.Request(specs[p].a, specs[p].b, specs[p].placement, group=p, sample_id="nominal", mode=mode,
                                minimum_mm=specs[p].minimum_mm, require_exact=specs[p].require_exact) for p in chosen]

    def run(session: Any, chosen: Sequence[Pair], mode: str) -> list[Any]:
        around = None if neighbours is None else (lambda index: neighbours(chosen[index]))
        outcomes = session.measure(requests(chosen, mode), neighbours=around)
        suspects.extend(_suspect_report(s, chosen) for s in session.suspects)
        return outcomes

    suspects: list[dict[str, Any]] = []
    with measurer.session() as session:
        rows = {p: _row(o) for p, o in zip(pairs, run(session, pairs, "exact" if exact else "sample"))}
        refine = _nearest_candidates(rows) if nearest else []
        if refine:
            rows.update({p: _row(o) for p, o in zip(refine, run(session, refine, "exact"))})
    return rows, suspects, measurer


def suspect_neighbours(chain: Any, relative: Mapping[Pair, Any]) -> Callable[[Pair], list[tuple[str, Any]]]:
    """A suspect's re-evaluation placements per pair: b moved +-pair_measure.REEVALUATE_MM along
    (1, 1, 1)/sqrt(3), and each independent joint +-DRIVER_STEP from nominal, within its limits,
    wherever that moves the pair (`relative` holds the nominal placements)."""
    shift = load_pair_measure().REEVALUATE_MM
    step = shift / math.sqrt(3.0)
    pose = load_pose()

    def around(pair: Pair) -> list[tuple[str, Any]]:
        nominal = relative[pair]
        found = [(f"{sign * shift:+g} mm", pose.Rigid(nominal.rot, tuple(v + sign * step for v in nominal.trans)))
                 for sign in (1.0, -1.0)]
        if chain is None:
            return found
        for joint in chain.independent:
            for delta in (DRIVER_STEP, -DRIVER_STEP):
                value = joint.nominal + delta
                if not joint.min <= value <= joint.max:
                    continue
                moved = chain.relative_transforms(chain.complete({joint.id: value}), [pair])[pair]
                if (moved.rot, moved.trans) != (nominal.rot, nominal.trans):
                    found.append((f"{joint.id} {delta:+g} {joint.unit}", moved))
        return found

    return around


class _Unrecorded:
    """Reference resolution without an assembly record: a PN names its singleton; no @id exists."""

    @staticmethod
    def attachable(ref: str, where: str = "") -> str:
        if ref.startswith("@"):
            raise build.UsageError(f"{where}{ref}: no assembly record to resolve an occurrence reference")
        return ref

    @staticmethod
    def pn(occurrence_id: str) -> str:
        return occurrence_id


def declared_press_fits(hw: Path, assembly: Any = None) -> list[dict[str, Any]]:
    """cad-motion pair_policy's press fits, `pair` as sorted occurrence ids, classified with cad-fits."""
    policy = load_pair_policy()
    try:
        return policy.declared_press_fits(hw, policy.read_interfaces(hw), assembly or _Unrecorded())
    except policy.PolicyError as error:
        raise build.UsageError(str(error)) from error


def declared_heat_sets(hw: Path, assembly: Any = None) -> list[dict[str, Any]]:
    """cad-motion pair_policy's heat-set inserts, `pair` as sorted occurrence ids."""
    policy = load_pair_policy()
    try:
        return policy.declared_heat_sets(hw, policy.read_interfaces(hw), assembly or _Unrecorded())
    except policy.PolicyError as error:
        raise build.UsageError(str(error)) from error


def declared_clearances(hw: Path, assembly: Any = None) -> list[dict[str, Any]]:
    """cad-motion pair_policy's clearance requirements, `pair` as sorted occurrence ids."""
    policy = load_pair_policy()
    try:
        return policy.declared_clearances(hw, policy.read_interfaces(hw), assembly or _Unrecorded())
    except policy.PolicyError as error:
        raise build.UsageError(str(error)) from error


def interference(geometry: dict[Pair, dict[str, Any]], named: Iterable[Pair] | None,
                 joint_pairs: set[Pair], allowed: set[Pair],
                 declared: Iterable[dict[str, Any]] = (), heat_sets: Iterable[dict[str, Any]] = (),
                 refs: Mapping[str, str] | None = None, *, changed: bool = False,
                 candidates: Iterable[Pair] | None = None) -> dict[str, Any]:
    """Only a classified declared interference fit or a declared heat-set insert on exactly that
    occurrence pair excuses overlap. `refs` maps an occurrence id to its copyable reference.

    A cleared row proves no overlap by its bounds; an exact row overlaps above INTERFERENCE_MM3; a
    failed row is unknown and fails. `named` limits the rows (`changed`: the changed-only selection,
    which then reports no minimum clearance); `candidates` are every occurrence pair of the version,
    against which allowed and declared pairs are resolved (default: the pairs of `geometry`)."""
    threshold = load_pose().INTERFERENCE_MM3
    refs = refs or {}
    candidates = set(geometry) if candidates is None else set(candidates)
    declarations = sorted(declared, key=lambda item: (item["pair"], item["source"]))
    inserts = sorted(heat_sets, key=lambda item: (item["pair"], item["source"]))
    declared_allowed = {tuple(item["pair"]) for item in declarations if item["classification"] == "interference"}
    effective_allowed = allowed | declared_allowed | {tuple(item["pair"]) for item in inserts}
    pairs = sorted(set(geometry) if named is None else {tuple(sorted(p)) for p in named})
    selected = set(pairs)
    unknown = [list(p) for p in pairs if p not in geometry]
    unknown_allowed = [list(p) for p in sorted(effective_allowed) if p not in candidates]
    rows: dict[str, list[dict[str, Any]]] = {"pairs": [], "joint_pairs": []}
    for pair in pairs:
        if pair not in geometry:
            continue
        g = geometry[pair]
        volume = g["interference_mm3"]
        hit = g["method"] is None or (volume is not None and volume > threshold)
        entry = {"pair": list(pair), "refs": [refs.get(p, p) for p in pair], **g, "interferes": hit,
                 "allowed": pair in effective_allowed,
                 "ok": not hit or (g["method"] == "exact" and pair in effective_allowed)}
        rows["joint_pairs" if pair in joint_pairs else "pairs"].append(entry)
    declared_fit_findings = []
    for item in declarations:
        pair = tuple(item["pair"])
        if item["classification"] != "interference" or pair not in selected:
            continue
        measurement = geometry.get(pair)
        if measurement is not None and measurement["interference_mm3"] is not None \
                and measurement["interference_mm3"] <= threshold:
            declared_fit_findings.append({**item, "type": "declared_fit_not_realized", **measurement,
                                          "threshold_mm3": threshold})
    every = rows["pairs"] + rows["joint_pairs"]
    measured_rows = [e for e in every if e["clearance_mm"] is not None]
    smallest = None if changed else min(measured_rows, key=lambda e: e["clearance_mm"], default=None)
    ok = all(e["ok"] for e in every) and not unknown and not unknown_allowed and not declared_fit_findings
    return {"status": _status(ok), "blocking": True,
            "selection": "changed" if changed else ("all" if named is None else "named"),
            "threshold_mm3": threshold, "unknown_pairs": unknown, "unknown_allowed": unknown_allowed,
            "declared_pairs": declarations, "declared_heat_sets": inserts, "declared_fit_findings": declared_fit_findings,
            "min_clearance": {"pair": smallest["pair"], "clearance_mm": smallest["clearance_mm"]} if smallest else None,
            **rows}


def pair_clearance(geometry: dict[Pair, dict[str, Any]], requirements: Iterable[dict[str, Any]],
                   refs: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Each declared clearance requirement at the built (nominal) pose, one row per requirement.

    A requirement holds on its pair whatever joins it: joint-connected and fitted pairs are measured
    like any other. It fails when the measured clearance is below it (compared unrounded), when the
    measurement failed, or when the version has no such pair. A clearance at or above it but below
    it plus its `margin_mm` (cad-record's effective margin; 0 when absent) is a `margin` warning,
    never a failure. A cleared pair passes on its lower bound, which its request put above the
    requirement plus the margin.
    """
    refs = refs or {}
    rows = []
    for item in sorted(requirements, key=lambda item: (item["pair"], item["source"])):
        a, b = item["pair"]
        required, margin = item["min_clearance_mm"], item.get("margin_mm", 0.0)
        measured = geometry.get((a, b))
        row: dict[str, Any] = {"pair": [a, b], "refs": [refs.get(a, a), refs.get(b, b)], "required_mm": required,
                               "margin_mm": margin, "clearance_mm": None, "method": None, "status": "fail",
                               "interface": item["interface"], "source": item["source"]}
        if measured is None:
            row["error"] = "the version has no such occurrence pair"
        elif measured["method"] is None:
            row["error"] = measured["error"]
        elif measured["method"] == "exact":
            gap = measured["clearance_mm"]
            row.update(clearance_mm=gap, method="exact")
            if gap >= required + margin:
                row["status"] = "pass"
            elif gap >= required:
                row.update(status="warn", warning="margin")
        else:
            row.update(method=measured["method"], lower_mm=measured["lower_mm"], upper_mm=measured["upper_mm"])
            if measured["lower_mm"] >= required + margin:
                row["status"] = "pass"
            else:
                row["error"] = "its bounds do not prove the requirement"
        rows.append(row)
    statuses = {row["status"] for row in rows}
    return {"status": "fail" if "fail" in statuses else ("warn" if "warn" in statuses else "pass"), "blocking": True,
            "requirements": rows}


def rigid_bodies(ids: Iterable[str], joints: Iterable[dict[str, Any]]) -> dict[str, str]:
    """Each occurrence's rigid body, named by its smallest id: a fixed joint (or --attach) welds its two occurrences."""
    parent = {oid: oid for oid in ids}

    def root(oid: str) -> str:
        while parent.setdefault(oid, oid) != oid:
            oid = parent[oid]
        return oid

    for joint in joints:
        if joint["type"] == "fixed":
            low, high = sorted(root(oid) for oid in joint["pair"])
            parent[high] = low
    return {oid: root(oid) for oid in list(parent)}


def connection(geometry: dict[tuple[str, str], dict[str, Any]], ids: Iterable[str],
               joints: list[dict[str, Any]]) -> dict[str, Any]:
    """Whether each occurrence is held: fixed pairs touch, and each occurrence touches or floats across a movable joint.

    Occurrences welded by fixed joints or --attach form one rigid body: the two occurrences of every
    fixed joint must touch, and a gap within a body is never a joint clearance. A float (CONTACT_MM
    to FLOAT_GAP_MM) passes only when a movable joint links the occurrence's body to the nearest
    occurrence's body.
    """
    ids = sorted(ids)
    body = rigid_bodies(ids, joints)
    links = {frozenset((body[j["pair"][0]], body[j["pair"][1]])): j["joint"] for j in joints if j["type"] != "fixed"}
    rows = {}
    for oid in ids:
        near = [(g["clearance_mm"], b if a == oid else a) for (a, b), g in geometry.items()
                if oid in (a, b) and g["clearance_mm"] is not None]
        if not near:
            rows[oid] = {"status": "alone", "nearest": None, "distance_mm": None, "ok": len(geometry) == 0}
            continue
        dist, other = min(near)
        status = "touching" if dist <= CONTACT_MM else ("floating" if dist <= FLOAT_GAP_MM else "disconnected")
        joint = links.get(frozenset((body[oid], body[other])))
        ok = status == "touching" or (status == "floating" and joint is not None)
        rows[oid] = {"status": status, "nearest": other, "distance_mm": dist, "joint_connected": joint is not None,
                     "joint": joint, "ok": ok}
    fixed = []
    for j in joints:
        if j["type"] == "fixed":
            gap = geometry.get(tuple(j["pair"]), {}).get("clearance_mm")
            fixed.append({"joint": j["joint"], "pair": j["pair"], "distance_mm": gap,
                          "ok": gap is not None and gap <= CONTACT_MM})
    ok = all(r["ok"] for r in rows.values()) and all(f["ok"] for f in fixed)
    return {"status": _status(ok), "blocking": True, "contact_mm": CONTACT_MM, "float_gap_mm": FLOAT_GAP_MM,
            "parts": rows, "fixed_joints": fixed}


def slivers_and_tolerances(parts: dict[str, Any]) -> dict[str, Any]:
    rows = {}
    for pn, part in sorted(parts.items()):
        areas = occ.face_areas(part.shape)
        tol = occ.max_tolerance(part.shape)
        slivers = sum(1 for a in areas if a < SLIVER_FACE_MM2)
        rows[pn] = {"min_face_area_mm2": min(areas, default=0.0), "sliver_faces": slivers, "max_tolerance_mm": tol,
                    "loose": tol > LOOSE_TOLERANCE_MM, "ok": slivers == 0 and tol <= LOOSE_TOLERANCE_MM}
    return {"status": _status(all(r["ok"] for r in rows.values()), blocking=False), "blocking": False,
            "sliver_face_mm2": SLIVER_FACE_MM2, "loose_tolerance_mm": LOOSE_TOLERANCE_MM, "parts": rows}


def _record_yaml(path: Path, what: str, missing: Any = None) -> Any:
    import yaml

    if missing is not None and not path.is_file():
        return missing
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise build.UsageError(f"{path}: cannot read {what}: {error}") from error


def build_volume(record: Path, parts: Mapping[str, Any]) -> dict[str, Any]:
    """Fit each FDM part on the printer of `record`/product.yaml with cadmodel.orientation: an allowed
    permutation of its box, else its oriented minimum-volume box.

    `record` holds product.yaml and parts/<PN>/part.yaml: a version's record/ snapshot, or hw/ for a
    version built before snapshots. `parts` carries each FDM part's manufacturing shape when the
    version has one, already set on the bed, else its definition."""
    product = _record_yaml(record / "product.yaml", "product record", missing={})
    try:
        volume = orientation.BuildVolume.declared(product)
    except ValueError as error:
        raise build.UsageError(f"{record / 'product.yaml'}: {error}") from error
    rows: dict[str, Any] = {}
    for pn, part in sorted(parts.items()):
        part_record = _record_yaml(record / "parts" / pn / "part.yaml", "part record")
        if not isinstance(part_record, dict) or part_record.get("process") != "fdm":
            continue
        if volume is None:
            rows[pn] = {"status": "warn", "message": "no printer build volume is declared"}
            continue
        dimensions, usable = volume.size_mm, volume.usable_mm
        model_size, found, extents = orientation.fit(part.shape, volume)
        sizes = {"model_frame_size_mm": [round(value, 6) for value in model_size],
                 "volume_mm": [round(value, 6) for value in dimensions],
                 "usable_volume_mm": [round(value, 6) for value in usable]}
        if found is None:
            rows[pn] = {"status": "fail", "size_mm": [round(value, 6) for value in model_size], **sizes,
                        "message": f"{pn} bounding box {tuple(round(value, 3) for value in model_size)} mm "
                                   f"does not fit printer volume {tuple(round(value, 3) for value in dimensions)} mm "
                                   f"(usable {tuple(round(value, 3) for value in usable)} mm) in any allowed orientation; "
                                   f"oriented box {tuple(round(value, 3) for value in extents)} mm also does not fit"}
            continue
        row = {"status": "pass", "orientation": found.orientation, "method": found.method, **sizes,
               "size_mm": [round(value, 6) for value in found.size_mm],
               "rotation": [[round(value, 9) + 0.0 for value in axis] for axis in found.rotation],
               "determinant": orientation.determinant(found.rotation)}
        if found.method == "oriented":
            row["axes"] = row["rotation"]
        rows[pn] = row
    if volume is None:
        return {"status": "warn", "blocking": False, "blocking_failures": [], "parts": rows,
                "message": "product.yaml does not declare build_volume"}
    failures = [pn for pn, row in rows.items() if row["status"] == "fail"]
    return {"status": "fail" if failures else "pass", "blocking": True, "blocking_failures": failures,
            "volume_mm": list(volume.size_mm), "margin_mm": volume.margin_mm, "parts": rows}


def mesh_watertight(folder: Path, part_map: Mapping[str, Any], ids: Iterable[str]) -> dict[str, Any]:
    """Per occurrence: its GLB node's mesh is a closed 2-manifold, never welded to another instance."""
    names = mesh.node_names(part_map)
    rows = mesh.watertight(folder / "assembly.glb", {oid: names.get(oid, "") for oid in ids})
    return {"status": _status(all(r["watertight"] for r in rows.values())), "blocking": True, "parts": rows}


def artifact_integrity(folder: Path) -> dict[str, Any]:
    """Every file of the version against its manifest inventory: none missing, changed, unlisted or linked."""
    problems = load_layout().verify(folder)
    return {"status": _status(not problems), "blocking": True, "problems": problems}


def nominal_placements(manifest: Mapping[str, Any], record: Path | None,
                       located: Mapping[str, tuple[str, Any]]) -> tuple[Any, dict[Pair, Any]]:
    """(chain, b's placement in a's frame per occurrence pair of `located`) at the nominal pose.

    With a record snapshot (`record`), the chain is rebuilt from it and composes each pair from its
    lowest common ancestor, as the sweep does, so a nominal sweep sample measures the very same
    placements; the chain must place every occurrence where the manifest does. A version without
    a snapshot has no chain (None): its pairs are T_a^-1 T_b of the assembly STEP locations."""
    pose = load_pose()
    ids = sorted(located)
    pairs = [(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]]
    if record is None or manifest.get("schema_version", 1) < 2:
        return None, {(a, b): located[a][1].inverse() @ located[b][1] for a, b in pairs}
    assembly = pose.load_assembly(record, record)
    chain = load_incremental().built_chain(assembly, manifest["parts"], manifest.get("attach", []))
    values = chain.complete({})
    transforms = chain.transforms(values)
    for oid in ids:
        rows = manifest["pose"]["transforms"].get(oid)
        built = None if rows is None else pose.Rigid(tuple(tuple(r[:3]) for r in rows), tuple(r[3] for r in rows))
        if built is None or oid not in transforms or not transforms[oid].close_to(built):
            raise build.UsageError(f"{oid}: the version's record snapshot does not place it where its manifest does; "
                                   "rebuild the version")
    return chain, chain.relative_transforms(values, pairs)


def check(hw: Path, label: str, named: list[tuple[str, str]] | None, allowed: Iterable[tuple[str, str]],
          expected_solids: dict[str, int], cache_dir: Path | None = None, jobs: int = 1, *, exact: bool = False,
          changed_only: bool = False, since: str | None = None) -> tuple[int, dict[str, Any]]:
    """`named` and `allowed` pairs are references (`@id`, or a PN placed once) into the built version;
    `cache_dir` holds the pair cache (None: no cache), and `jobs` worker processes measure the pairs
    (1: this process). `exact` measures every pair; `changed_only` only the pairs that can differ
    from baseline version `since` (default: the newest built version before `label`)."""
    pose = load_pose()
    measure = load_pair_measure()
    versions = _versions()
    started = time.perf_counter()
    hw = hw.resolve()
    folder = build.version_dir(hw, label)
    manifest = build.read_json(folder / "manifest.json")
    part_map = build.read_json(folder / "part-map.json")
    try:
        occurrences = versions.built_occurrences(part_map, manifest)
    except versions.VersionError as error:
        raise build.UsageError(f"{folder}: {error}") from error
    inventory = built_inventory(occurrences)
    refs = {oid: o.ref for oid, o in occurrences.items()}
    named_pairs = resolve_pairs(named, inventory, "--pair") if named is not None else None
    allowed_pairs = set(resolve_pairs(allowed, inventory, "--allow-interference"))
    parts = pose.load_definitions(hw, folder / "parts")
    step = pose.read_assembly_step(folder / "assembly.step")
    located = {}
    for component in step.components:
        oid = component.occurrence if component.occurrence is not None else component.pn
        if oid in occurrences:
            located[oid] = (component.pn, component.location)
    previous = build.previous_label(hw, label)
    baseline = build.read_json(hw / "versions" / previous / "metrics.json")["parts"] if previous else None
    joints = manifest["joint_pairs"]
    joint_pairs = {tuple(entry["pair"]) for entry in joints}
    # Declarations, margins, fit and process come from the record the version was built from.
    snapshot = folder / "record" if (folder / "record").is_dir() else None
    record = snapshot or hw
    assembly = pose.load_assembly(record, record)
    declared = declared_press_fits(record, assembly)
    heat_sets = declared_heat_sets(record, assembly)
    margins = clearance_margins(record)
    requirements = [{**item, "margin_mm": margins.for_interface(item["interface"])}
                    for item in declared_clearances(record, assembly)]
    chain, relative = nominal_placements(manifest, snapshot, located)
    changes = load_incremental().compare_versions(hw, label, since) if changed_only else None
    selection = changes.select(relative) if changes is not None else None
    chosen = sorted(relative) if selection is None else sorted(selection.selected)
    minimum: dict[Pair, float] = {}
    for item in requirements:
        pair = tuple(item["pair"])
        minimum[pair] = max(minimum.get(pair, 0.0), item["min_clearance_mm"] + item["margin_mm"])  # type: ignore[index]
    exact_required = ({tuple(e["pair"]) for e in joints if e["type"] == "fixed"}
                      | {tuple(i["pair"]) for i in declared if i["classification"] == "interference"})
    specs = {pair: PairSpec(located[pair[0]][0], located[pair[1]][0], relative[pair], minimum.get(pair, 0.0),
                            pair in exact_required) for pair in chosen}
    mesh_bound, description = mesh_bounds({pn: parts[pn].shape for pn in {s.a for s in specs.values()}
                                           | {s.b for s in specs.values()}})
    cache = None if cache_dir is None else measure.PairCache(cache_dir)
    try:
        geometry, suspects, measurer = pair_geometry(
            parts, specs, cache=cache, jobs=jobs, mesh=mesh_bound, exact=exact,
            neighbours=suspect_neighbours(chain, relative), nearest=selection is None)
    finally:
        if cache is not None:
            cache.close()
    manufacturing, made = manufacture.version_check(folder, manifest)
    printed = {pn: pose.Part(pn, part.name, made.get(pn, part.shape)) for pn, part in parts.items()}
    if selection is None:
        scope: dict[str, Any] = {"kind": "all_pairs" if named_pairs is None else "named_pairs",
                                 "complete": named_pairs is None}
        connected = connection(geometry, located, joints)
        pair_scope, requirement_scope = named_pairs, requirements
    else:
        scope = {**selection.scope(), "changes": changes.to_json()}
        connected = {"status": "skipped", "blocking": False,
                     "reason": "a changed-only check measures only the changed pairs; connection needs every pair"}
        pair_scope = chosen
        requirement_scope = [item for item in requirements if tuple(item["pair"]) in selection.selected]
    checks = {
        "step_readback": step_readback(folder, manifest, parts, step, occurrences),
        "brep_validity": brep_validity(parts, manifest),
        "solid_structure": solid_structure(parts, expected_solids, baseline, previous),
        "interference": interference(geometry, pair_scope, joint_pairs, allowed_pairs, declared, heat_sets, refs,
                                     changed=selection is not None, candidates=relative),
        "pair_clearance": pair_clearance(geometry, requirement_scope, refs),
        "connection": connected,
        "build_volume": build_volume(record, printed),
        "slivers_tolerances": slivers_and_tolerances(parts),
        "mesh_watertight": mesh_watertight(folder, part_map, occurrences),
        "artifact_integrity": artifact_integrity(folder),
        "manufacturing": manufacturing,
    }
    blocking = sorted(name for name, c in checks.items() if c["blocking"] and c["status"] == "fail")
    warnings = sorted(name for name, c in checks.items() if c["status"] == "warn")
    counters = measurer.counters
    result = {"status": "fail" if blocking else "pass", "label": label, "pose": "nominal",
              "baseline": previous, "scope": scope, "blocking_failures": blocking, "warnings": warnings,
              "evaluation": {"mode": "exact" if exact else "fast", "mesh": description, "band_mm": measurer.rule.band_mm,
                             "rule_sha256": measurer.rule.digest.hex()},
              "occurrences": {oid: o.pn for oid, o in occurrences.items()}, "checks": checks, "suspects": suspects,
              "timings_s": {"total_s": round(time.perf_counter() - started, 3),
                            "kernel_evaluations": counters.kernel_evaluations, "exact_hits": counters.exact_hits,
                            "decision_hits": counters.decision_hits, "bucket_hits": counters.bucket_hits,
                            "cleared": dict(counters.cleared), "reevaluations": counters.reevaluations}}
    return (1 if blocking else 0), result
