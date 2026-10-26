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
2. Run `scripts/drawing.py <step> --part <part.yaml> --product <product.yaml> --metrics <metrics.json> --output-dir <dir> [--scale <ratio>] [--timeout <seconds>]` with FreeCAD 1.1.4 installed; timeout defaults to 120 seconds. Headless `freecadcmd` runs `scripts/techdraw_job.py`: a TechDraw projection group places the front, top, and right views in the regime's projection angle. `--scale` is the largest scale tried; smaller standard scales follow until the views and annotations fit the drawing area.
3. `scripts/drawing.py` composes the sheet, then runs `scripts/layout_check.py` over the SVG. A violation fails the run with `layout_check_failed` and writes `drawing_<run>.rejected.svg`. The check rejects:
   - annotation text that overlaps a view, another text, the frame, or the title block
   - two views closer than 10 mm, or a view outside the frame
   - a projection symbol outside its title-block cell
   - a remaining template placeholder
4. `scripts/svg_to_png.swift` and `scripts/svg_to_pdf.swift` export the checked SVG through macOS AppKit/PDFKit, not GUI FreeCAD; the PDF page matches the sheet size.
5. Review the JSON report and both raster previews; confirm orthographic views, dimensions, title block, and projection symbol.
6. Record accepted drawing checks in the hardware project's `verification.csv` after a human reviews both raster previews.

## Inputs and outputs

- `part.yaml`: `PN`, `rev`, `title`, and `material` fields populate the template's editable title-block fields.
- `product.yaml`: `regime` selects the shipped ISO 5457 A4 template with first-angle views, or the ASME ANSI A template with third-angle views; `general_tolerance` fills the tolerance field.
- Title-block fields the record does not carry (author, approver, issue date, company, CAGE code) are blank, never the template's sample text.
- The STEP file and `--metrics` JSON must belong to the same model version. `--metrics` provides each bore's part ID, axis, position, and diameter for drawing callouts; a bore that does not project onto a circle of its diameter fails the run with `metrics_mismatch`.
- Successful outputs are `drawing.pdf`, `drawing.svg`, their PNG raster previews, a run-specific completion marker, and a JSON summary; exit code 0 indicates all outputs passed validation.

## Rules

MUST Inspect the generated PDF and SVG raster previews to confirm non-empty projections, dimension placement, title fields, metric bore callouts, and the regime's projection symbol.
MUST Fail a run when any projected view has no visible outline, the layout check reports a violation, or an SVG/PDF export is blank or lacks PN, revision, title, material, or tolerance.
MUST Require `metrics.json` for the same STEP version, and populate bore callouts from its per-part `holes` data rather than inferred cylinders.
MUST Treat a drawing as one static part pose; it does not describe dynamics, process plans, or assembly performance.
NOT Bores whose axis is not along the front view direction get no callout; the report lists them under `warnings`.
NOT Generated overall dimensions replace neither deliberate functional dimensioning nor tolerance review.
