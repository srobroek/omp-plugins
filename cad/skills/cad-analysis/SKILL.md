---
name: cad-analysis
description: Use for static FreeCAD finite-element analysis of a hardware case, producing checked stress, displacement, and yield-safety results.
---

# CAD Analysis

TRIGGER
+ A hardware project is at L4 ANALYSIS and needs a static FEA case.
- Motion, transient, fatigue, buckling, thermal, or nonlinear analysis → report unsupported; this skill handles static linear analysis only.

## Workflow

1. Prepare a case YAML with a STEP path, optional `part` PN for an assembly STEP, material properties,
   fixed-face selector, face loads, mesh size, and optional `pose`; see the input shape below.
2. Run `scripts/fea_static.py <case.yaml>` with FreeCAD 1.1.4, Gmsh, and CalculiX available; it writes
   `results.json` beside the case YAML and keeps the per-run job and solver files in
   `runs/<run_id>/`. The `run_directory` field in `results.json` names that run directory, and the
   command also emits result JSON.
3. For an assembly sweep, run cad-motion `sweep.py ... --worst-step worst.step`, then set
   `step: worst.step`, `part: <PN>`, and `pose` to the sweep result's `worst_case.pose` in this
   case YAML. The fixed-face and load plane selectors use that STEP's assembly coordinates.
4. Review warnings, solver versions, and `worst_case_pose` (the analysed STEP and supplied pose).
5. Record accepted checks in the hardware project's `verification.csv`.

## Inputs

- `step`: STEP file path, relative to the case YAML or absolute.
- `part`: optional PN-first product/label identifier; required when the STEP contains multiple solids.
- `pose`: optional mapping of joint IDs to values, copied from cad-motion's `worst_case.pose`.
  `part` may be omitted for a STEP containing exactly one solid. A requested PN must match exactly one
  solid by a PN-first product or label name; unknown or ambiguous PNs list the available PNs.
- `loads`: list of `{selector: <face selector>, force: [Fx, Fy, Fz]}` in N; selector uses the same
  `indices` or `plane` form.

- `mesh_size`: positive maximum element size in mm.

- `required_safety_factor`: optional positive yield-safety-factor threshold; a completed solve below
  it is a check failure.
- `solid_index`: optional 1-based index into all STEP solids, for selecting one solid when labels or
  product names are ambiguous. Mutually exclusive with `part`.

## Exit codes

- `0`: analysis completed and any requested safety-factor threshold passed.
- `1`: analysis completed, but the required safety factor was not met.
- `2`: no result; invalid input, unavailable or failed FreeCAD job, timeout, malformed result, or
  other infrastructure failure.

## Rules

MUST Check that face selection, units, material, constraints, and solver warnings match the case before relying on results.

MUST Treat results as static linear estimates; they do not cover dynamics or replace physical validation.
NOT A yield safety factor is not a fatigue, buckling, or certification margin.
