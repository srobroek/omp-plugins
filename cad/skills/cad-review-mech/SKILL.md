---
name: cad-review-mech
description: Reviews a CAD design for requirements, load paths, mechanics, fits, and FEA with measured evidence. Use when a mechanical design needs independent review.
---

# Mechanical Design Review

TRIGGER
+ The design reaches CRITIQUE or needs an independent mechanical review.
- Manufacturing-process suitability → `cad-review-dfm`

## Workflow

1. Read `hw/product.yaml`, requirements, interfaces, assembly joints, every relevant `part.yaml` and model, plus available drawing, analysis, and verification outputs.
2. Trace each applicable requirement to its part/interface and a verification method, criterion, and result. Identify orphaned or unverified requirements.
3. Trace load paths from applied loads through interfaces, joints, fasteners, and supporting parts to reactions. Compare load and strength evidence with the requirement's stated load cases and factors.
4. Check mating fits and tolerances against the product regime (`iso` or `asme`), declared general tolerance, dimensions, and functional requirements. Cite the specified tolerance system and the record or check output; do not assume a fit class.
5. Check fastener type, standard size, access, engagement length, edge distance, and retention against joint loads and material. Identify where the record or analysis lacks the inputs needed to judge them.
6. Check joint type, axis, origin, nominal position, and min/max limits. Check collision and clearance over the full declared range using sweep or interference output; a nominal-pose check does not prove range clearance.
7. Check each FEA result's model purpose, constraints, loads, contacts, mesh/convergence evidence, material properties, units, and worst-case pose. Compare reported displacement and stress with acceptance criteria and strength allowables. Flag singularities or unsupported assumptions; do not treat a solver pass as validation.
8. Report only findings tied to measured evidence. Cite exact record paths/locations and script or analysis output identifiers. State values with units, including the required or allowable value used for comparison.

## Rules

MUST Use the product's declared units and tolerance regime; report missing or contradictory inputs.
MUST Give every finding its measured value, comparison value or criterion, units, and record/script output source. Never invent a measurement or infer a pass from missing evidence.
MUST Use `MAJOR` for a requirement failure, unsafe load path/retention, collision within required joint travel, or missing evidence needed to establish a safety-critical requirement. Use `MINOR` for a bounded non-safety discrepancy or missing non-critical verification; use `PASS` only when applicable checks are evidenced and no findings remain.
DEFAULT Collapse repeated symptoms with one evidenced root cause into one finding.
NOT Edit files, run models, alter records, delegate, or report unsupported quantitative claims.

## Output

Begin your reply with `VERDICT: PASS|MINOR|MAJOR` and one sentence stating the review scope.
Untested -- named checks, missing evidence, and why it was unavailable. If no check is untested, state that the reviewer evaluated all applicable checks.
CAP 140w clean; 320w with findings.
MUST Never reprint code, diffs, file contents, or the caller's claim.
