---
name: cad-analysis
description: Use for static FreeCAD finite-element analysis of a hardware case, producing checked stress, displacement, and yield-safety results.
---

# CAD Analysis

TRIGGER
+ A hardware project is at L4 ANALYSIS and needs a static FEA case.
- Motion, transient, fatigue, buckling, thermal, or nonlinear analysis → report unsupported; this skill handles static linear analysis only.

## Workflow

1. Prepare a case YAML with a STEP path, material properties, fixed-face selector, face loads, and mesh size; see the input shape below.
2. Run `scripts/fea_static.py <case.yaml>` with FreeCAD 1.1.4, Gmsh, and CalculiX available; it writes `results.json` and a run-specific FreeCAD Python job in the case directory, then emits result JSON to stdout.
3. Review warnings, solver versions, and the worst-case-pose note before using results; posed STEP files can be supplied by the motion workflow later.
4. Record accepted checks in the hardware project's `verification.csv`.

## Inputs

- `step`: STEP file path, relative to the case YAML or absolute.
- `material`: `E` (MPa), `nu`, `density` (kg/m³), and `yield` (MPa); `name` is optional.
- `fixed_faces`: `indices: [1, ...]` (1-based) or `plane: {axis: x|y|z, value: mm, tolerance: mm}`.
- `loads`: list of `{selector: <face selector>, force: [Fx, Fy, Fz]}` in N; selector uses the same `indices` or `plane` form.
- `mesh_size`: positive maximum element size in mm.

## Rules

MUST Check that face selection, units, material, constraints, and solver warnings match the case before relying on results.
MUST Treat results as static linear estimates; they do not cover dynamics or replace physical validation.
NOT A yield safety factor is not a fatigue, buckling, or certification margin.
