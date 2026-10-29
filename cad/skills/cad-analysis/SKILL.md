---
name: cad-analysis
description: Use for static FreeCAD finite-element analysis of a hardware case, producing checked stress, displacement, and yield-safety results.
---

# CAD Analysis

TRIGGER
+ A hardware project is at L4 ANALYSIS and needs a static FEA case.
- Motion, transient, fatigue, buckling, thermal, or nonlinear analysis → report unsupported; this skill handles static linear analysis only.

## Workflow

1. Prepare a case YAML with a STEP path, an optional `part` PN or `occurrence` for an assembly STEP,
   material properties, fixed-face selector, face loads, mesh size, and optional `pose`; see the input
   shape below.
2. Run `scripts/fea_static.py <case.yaml>` with FreeCAD 1.1.4, Gmsh, and CalculiX available. For a versioned case,
   pass `--hw hw --version vN` (and optional `--case-id ID --replace`) to publish `results.json`, the retained solver files
   under `evidence/`, and a manifest under `hw/analysis/vN/<case-id>/`. The source case belongs under
   `hw/analysis/cases/<case-id>/`. A matching rerun reuses its immutable bundle; changed case, input, solver versions,
   or options require `--replace`. Explicit `--out` is only allowed under `.cad-work`; solver scratch remains there.
3. For a versioned assembly sweep, set `step` and `evidence` to `hw/motion/vN/<case>/worst.step` and
   its `worst.step.json`; the analysis checks the STEP hash and complete pose, never re-poses it.
   Face selectors use the assembly coordinates of that STEP.
4. Review warnings, solver versions, and `worst_case_pose` (analysed STEP, pose, and evidence hash).
5. Record accepted checks in the hardware project's `verification.csv`.

## Inputs

- `step`: STEP file path, relative to the case YAML or absolute.
- `part`: optional PN-first product/label identifier, for a part placed once. It is required when the
  STEP contains multiple solids, unless `occurrence` or `solid_index` selects one. `part` may be
  omitted for a STEP containing exactly one solid. A requested PN must match exactly one solid by a
  PN-first product or label name. Unknown or ambiguous PNs list the available PNs. A PN placed more
  than once is ambiguous: select one of its occurrences.
- `occurrence`: optional quoted `"@id"`, one occurrence of a part placed more than once in an assembly
  STEP written by cad-model or cad-motion (component name `<PN> <title> [@id]`). The analysis uses that
  instance at its placement in the STEP, applied once. An unknown id lists the occurrences of the STEP,
  and the analysis refuses an occurrence with more than one solid.
- `pose`: optional mapping of joint IDs to values, copied from cad-motion's `worst_case.pose`.
- `evidence`: optional path, relative to the case YAML, of a cad-motion sweep's `worst.step.json`.
  A STEP whose SHA-256 differs, a `pose` other than the recorded one, or an `occurrence` the evidence
  does not list is an input error (exit 2).
- `loads`: list of `{selector: <face selector>, force: [Fx, Fy, Fz]}` in N; selector uses the same
  `indices` or `plane` form.

- `mesh_size`: positive maximum element size in mm.

- `required_safety_factor`: optional positive yield-safety-factor threshold; a completed solve below
  it is a check failure.
- `solid_index`: optional 1-based index into all STEP solids, for selecting one solid when labels or
  product names are ambiguous. `part`, `occurrence` and `solid_index` are mutually exclusive.

## Reproducibility
Completed results include `mesh_settings`: one Gmsh thread, random seed 1, zero 3D random
perturbation, standard and Netgen mesh optimizers disabled, the fixed elastic-plus-optimization
high-order pass, and the CalculiX SPOOLES matrix solver. `mesh_input_hashes` identify the normalized
`.geo` input and BRep used. Two repeated lamp runs had identical source hashes and mesh counts
(13,634 nodes; 7,423 elements); safety factor differed by 0.202%. This residual is downstream
Gmsh/OCC numerical nondeterminism, not source input drift; comparable repeats may vary within 0.25%.
## Exit codes

- `0`: analysis completed and any requested safety-factor threshold passed.
- `1`: analysis completed, but the required safety factor was not met.
- `2`: no result; invalid input, unavailable or failed FreeCAD job, timeout, malformed result, or
  other infrastructure failure.

## Rules

MUST Check that face selection, units, material, constraints, and solver warnings match the case before relying on results.

MUST Treat results as static linear estimates; they do not cover dynamics or replace physical validation.
NOT A yield safety factor is not a fatigue, buckling, or certification margin.
