---
name: cad-drawings
description: Use for generating a checked dimensioned FreeCAD PDF and SVG drawing package from a hardware part and its product record.
---

# CAD Drawings

TRIGGER
+ A hardware part is at L3 DETAIL and needs a release drawing.
- 3D motion, renderings, CAM, or non-FreeCAD CAD edits → use the owning workflow; this skill generates static drawings only.

## Workflow

1. Provide the part STEP file, matching `metrics.json` from its cad-model version, `hw/parts/<PN>/part.yaml`, and `hw/product.yaml` with part identity, title, material, revision, regime, and general tolerance.
2. Run `scripts/drawing.py <step> --part <part.yaml> --product <product.yaml> --metrics <metrics.json> --output-dir <dir> [--scale <ratio>] [--timeout <seconds>]` with FreeCAD 1.1.4 installed; timeout defaults to 120 seconds.
3. Review the JSON report and rendered raster previews of the PDF and SVG; confirm orthographic views, dimensions, title block, and projection symbol.
4. Record accepted drawing checks in the hardware project's `verification.csv` after a human reviews both raster previews.

## Inputs and outputs

- `part.yaml`: `PN`, `rev`, `title`, and `material` fields populate the template's title block.
- `product.yaml`: `regime` selects the shipped ISO or ASME template and first- or third-angle layout; `general_tolerance` fills the tolerance field.
- The STEP file and `--metrics` JSON must belong to the same model version. `--metrics` provides each bore's part ID, axis, position, and diameter for drawing callouts.
- Successful outputs are `drawing.pdf`, `drawing.svg`, their PNG raster previews, a run-specific completion marker, and a JSON summary; exit code 0 indicates all outputs passed validation.

## Rules

MUST Inspect the generated PDF and SVG raster previews to confirm non-empty projections, dimension placement, title fields, metric bore callouts, and the regime's projection symbol.
MUST Fail a run when any projected view has no visible outline or an SVG/PDF export is blank or lacks PN, revision, title, material, or tolerance.
MUST Require `metrics.json` for the same STEP version, and populate bore callouts from its per-part `holes` data rather than inferred cylinders.
MUST Treat a drawing as one static part pose; it does not describe dynamics, process plans, or assembly performance.
NOT Generated overall dimensions replace neither deliberate functional dimensioning nor tolerance review.
