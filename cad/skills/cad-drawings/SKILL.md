---
name: cad-drawings
description: Use for generating a dimensioned FreeCAD TechDraw PDF and SVG from a hardware part and its product record.
---

# CAD Drawings

TRIGGER
+ A hardware part is at L3 DETAIL and needs a release drawing.
- 3D motion, renderings, CAM, or non-FreeCAD CAD edits → use the owning workflow; this skill generates static TechDraw drawings only.

## Workflow

1. Provide the part STEP file, `hw/parts/<PN>/part.yaml`, and `hw/product.yaml` with the part identity, title, material, revision, regime, and general tolerance.
2. Run `scripts/drawing.py <step> --part <part.yaml> --product <product.yaml> --output-dir <dir> [--scale <ratio>]` with FreeCAD's GUI launcher available.
3. Check the JSON report, generated PDF/SVG, dimensions, title block fields, template choice, and warnings; the script writes a run-specific macro, marker, and the named PDFs/SVGs alongside the outputs.
4. Record the accepted drawing in `verification.csv`.

## Inputs and outputs

- `part.yaml`: `PN`, `rev`, `title`, and `material` fields populate the title block.
- `product.yaml`: `regime` selects the shipped ISO or ASME template; `general_tolerance` populates the title block.
- STEP input, output directory, and optional drawing scale are command-line arguments.
- Successful outputs are `drawing.pdf`, `drawing.svg`, a generated `.FCMacro`, a run-specific completion marker, and JSON summary on stdout.

## Rules

MUST Inspect the export and confirm the views, dimensions, title block, scale, and tolerance before release.
MUST Treat a drawing as documentation of one part pose; it does not describe dynamics, manufacturing process plans, or assembly performance.
NOT A generated overall dimension set does not replace a deliberate drawing review for functional tolerances.
