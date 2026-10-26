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
   `results.json` and a run-specific FreeCAD Python job in the case directory, then emits result JSON.
3. For an assembly sweep, run cad-motion `sweep.py ... --worst-step worst.step`, then set
   `step: worst.step`, `part: <PN>`, and `pose` to the sweep result's `worst_case.pose` in this
   case YAML. The fixed-face and load plane selectors use that STEP's assembly coordinates.
4. Review warnings, solver versions, and `worst_case_pose` (the analysed STEP and supplied pose).
5. Record accepted checks in the hardware project's `verification.csv`.

## Inputs

- `step`: STEP file path, relative to the case YAML or absolute.
- `part`: optional PN-first product/label identifier; required when the STEP contains multiple solids.
- `pose`: optional mapping of joint IDs to values, copied from cad-motion's `worst_case.pose`.
- `material`: `E` (MPa), `nu`, `density` (kg/m³), and `yield` (MPa); `name` is optional.
- `fixed_faces`: `indices: [1, ...]` (1-based) or `plane: {axis: x|y|z, value: mm, tolerance: mm}`.
  `part` may be omitted for a STEP containing exactly one solid. A requested PN must match exactly one
  solid by a PN-first product or label name; unknown or ambiguous PNs list the available PNs.
- `loads`: list of `{selector: <face selector>, force: [Fx, Fy, Fz]}` in N; selector uses the same
  `indices` or `plane` form.

- `mesh_size`: positive maximum element size in mm.

## Rules

MUST Check that face selection, units, material, constraints, and solver warnings match the case before relying on results.

MUST Treat results as static linear estimates; they do not cover dynamics or replace physical validation.
NOT A yield safety factor is not a fatigue, buckling, or certification margin.
