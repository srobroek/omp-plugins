"""The part drawing completeness gate (drawing architecture §8): coverage rows and failure findings.

``evaluate`` combines the evidence of one run into ``drawing_document.CoverageReport``:

1. identity and provenance: ``drawing_contract.load_context`` already verified every hash;
2. binding: every locator patch bound exactly one face (``feature_geometry.resolve``);
3. geometry inventory: every final face belongs to one feature (``geometry_unaccounted`` otherwise);
4. requirements: each feature kind's required characteristics were measured (``drawing_intent``);
5. coverage: every characteristic has a controlling tolerance, fit, basic dimension or specification;
6. consistency: no characteristic is controlled twice with different values;
7. visibility: every characteristic sits on a visible point of its own feature in some view;
8. cross-part fit: each fit endpoint naming this part names one of its bound features;
9. product notes: a detail drawing states its edges (ISO 13715), general surface texture and finish, and
   every feature's own texture symbol or edge sizes sit on a visible point of that feature;
10. section fill: every cut face of every section view is lined or filled solid over its projected
    area (``section_hatch``; thin faces solid);
11. recognised features: every hole, pocket, cutout, slot, groove, boss, rib, wall and step that
    ``feature_recognition`` finds on the STEP is bound, located and sized on the sheet, not only defined
    by a controlled-model surface (``feature_coverage``).

Layout and export (stage 9 of the architecture) run in ``drawing_document.publish_package`` on the
composed sheets. A passing report proves this implemented contract, not ISO or ASME conformance.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import feature_coverage
import section_hatch
from drawing_document import CoverageReport
from drawing_intent import FIT_KEYS, Characteristic, Measured, finding
from feature_geometry import Binding, Face
from feature_recognition import Recognition
from sheet import Presentation, dimension_key

UNTOLERANCED = ("profile", "thread")   # controlled by their frame or designation


def _endpoint_findings(pn: str, interfaces: Sequence[Mapping[str, Any]], binding: Binding) -> list[dict[str, Any]]:
    found = []
    for interface in interfaces:
        limits = interface.get("limits") or {}
        for key in FIT_KEYS:
            fit = limits.get(key) or {}
            for side in ("hole", "shaft"):
                endpoint = fit.get(side)
                if isinstance(endpoint, Mapping) and endpoint.get("PN") == pn and endpoint.get("feature") not in binding.features:
                    found.append(finding("fit_binding_missing", f"{interface['id']} {key} names {pn}:{endpoint.get('feature')}, "
                                         f"which the model does not locate", interface=interface["id"]))
        for heat in limits.get("heat_set") or []:
            if heat["pair"][0] == pn and heat.get("feature") is None:
                found.append(finding("fit_binding_missing", f"{interface['id']} heat_set {heat['insert']} names no host "
                                     f"feature of {pn}", interface=interface["id"]))
            elif heat["pair"][0] == pn and heat["feature"] not in binding.features:
                found.append(finding("fit_binding_missing", f"{interface['id']} heat_set names {pn}:{heat['feature']}, "
                                     f"which the model does not locate", interface=interface["id"]))
    return found


def _conflicts(chars: Sequence[Characteristic]) -> list[dict[str, Any]]:
    found = []
    seen: dict[tuple[str, str, str | None, str], Characteristic] = {}
    for char in chars:
        if char.reference:
            continue
        key = (char.feature, char.operation, char.axis, ",".join(map(str, char.faces)))
        if key in seen and seen[key].tolerance != char.tolerance:
            found.append(finding("dimension_conflict", f"{char.id} and {seen[key].id} control the same {char.operation} "
                                 f"of {char.feature} differently", feature=char.feature))
        seen.setdefault(key, char)
    return found


def _repeated_dimensions(chars: Sequence[Characteristic], presentation: Presentation) -> list[dict[str, Any]]:
    """One sheet states each dimension once (ISO 129-1, ASME Y14.5 1.4): no two dimension lines say the same."""
    by_id = {c.id: c for c in chars}
    stated: dict[tuple[Any, ...], str] = {}
    found = []
    for linear in presentation.linears:
        char = by_id.get(linear.characteristics[0])
        key = dimension_key(char) if char is not None else None
        if key is None:
            continue
        if key in stated:
            found.append(finding("dimension_conflict", f"{linear.id} repeats {stated[key]}: {char.axis} = "
                                 f"{char.value:.3f} is dimensioned twice", feature=char.feature))
        stated.setdefault(key, linear.id)
    return found


def evaluate(pn: str, part: Mapping[str, Any], interfaces: Sequence[Mapping[str, Any]], binding: Binding,
             measured: Measured, presentation: Presentation | None, step_sha256: str,
             sections: Sequence[section_hatch.SectionFill] = (), recognition: Recognition | None = None,
             faces: Mapping[int, Face] | None = None) -> CoverageReport:
    findings: list[dict[str, Any]] = [dict(f) for f in binding.findings] + [dict(f) for f in measured.findings]
    findings += _endpoint_findings(pn, interfaces, binding)
    findings += _conflicts(measured.characteristics)
    drawing = part.get("drawing") or {}
    if drawing.get("type") == "detail":
        if not any(note["kind"] == "finish" for note in drawing.get("notes", [])):
            findings.append(finding("drawing_intent_missing", "drawing.notes states no surface finish or coating"))
        for field, what in (("edges", "edge condition (ISO 13715)"), ("surface_texture", "general surface texture")):
            if field not in drawing:
                findings.append(finding("drawing_intent_missing", f"the drawing states no {what} in drawing.{field}"))
    rows = []
    for char in measured.characteristics:
        status = "pass"
        if char.tolerance is None and not char.reference and char.operation not in UNTOLERANCED:
            findings.append(finding("tolerance_missing", f"{char.id} ({char.operation} {char.value:.3f}) has no tolerance, "
                                    f"fit or applicable general tolerance", feature=char.feature))
            status = "fail"
        placed = presentation.placed.get(char.id) if presentation is not None else None
        if presentation is not None and placed is None:
            status = "fail"
        rows.append({"feature": char.feature, "requirement": char.operation, "characteristic": char.id,
                     "value_mm": round(char.value, 6), "quantity": char.quantity, "axis": char.axis,
                     "faces": list(char.faces), "step_sha256": step_sha256,
                     "tolerance": None if char.tolerance is None else char.tolerance.to_dict(),
                     "reference": char.reference, "annotation": placed and placed["annotation"],
                     "view": placed and placed["view"], "status": status})
    for tolerance in measured.geometric:
        key = f"geometric.{tolerance['id']}"
        placed = presentation.placed.get(key) if presentation is not None else None
        rows.append({"feature": ",".join(tolerance["features"]), "requirement": tolerance["characteristic"],
                     "characteristic": key, "tolerance": {"zone_mm": tolerance["zone_mm"],
                                                          "datum_frame": tolerance.get("datum_frame", [])},
                     "annotation": placed and placed["annotation"], "view": placed and placed["view"],
                     "status": "pass" if placed or presentation is None else "fail"})
    for feature, intent in (drawing.get("features") or {}).items():
        for field in ("surface_texture", "edges"):
            if field in intent:
                key = f"{field}.{feature}"
                placed = presentation.placed.get(key) if presentation is not None else None
                rows.append({"feature": feature, "requirement": field, "characteristic": key, "tolerance": intent[field],
                             "annotation": placed and placed["annotation"], "view": placed and placed["view"],
                             "status": "pass" if placed or presentation is None else "fail"})
    if presentation is not None:
        for item in presentation.unplaced:
            findings.append(finding("feature_not_presentable", f"{item['characteristic']} has no visible point of "
                                    f"{item['feature']} in any {item['presentation']} view", feature=item["feature"]))
        findings += _repeated_dimensions(measured.characteristics, presentation)
    for section in sections:
        findings += section_hatch.findings(section)
    if measured.frame is None and not any(f["code"] == "datum_invalid" for f in findings):
        findings.append(finding("datum_invalid", "no datum frame"))
    features: tuple[Mapping[str, Any], ...] = ()
    if recognition is not None and faces is not None and drawing.get("type") == "detail":
        coverage = feature_coverage.check(recognition, binding, measured, faces,
                                          presentation.placed if presentation is not None else None)
        features = coverage.rows
        findings += [dict(f) for f in coverage.findings]
    return CoverageReport(status="fail" if findings else "pass", rows=tuple(rows), findings=tuple(findings),
                          features=features)


def release_blockers(part: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Release readiness (§8.1 stage 10): reported beside the gate, never folded into a passing content check."""
    blockers = []
    if str(part["rev"]).startswith("X"):
        blockers.append(finding("revision_unreleased", f"revision {part['rev']} is a prototype revision"))
    if part.get("make_buy") == "buy" and not part.get("supplier"):
        blockers.append(finding("procurement_incomplete", "no supplier is selected"))
    for field, reason in sorted(((part.get("procurement") or {}).get("open") or {}).items()):
        blockers.append(finding("procurement_incomplete", f"{field} is open: {reason}"))
    texture = (part.get("drawing") or {}).get("surface_texture") or {}
    if "open" in texture:
        blockers.append(finding("surface_texture_open", f"the general surface texture is open: {texture['open']}"))
    return blockers
