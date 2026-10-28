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
2. Run `scripts/drawing.py <step> --part <part.yaml> --product <product.yaml> --metrics <metrics.json> --output-dir <dir> [--scale <ratio>] [--timeout <seconds>]` with FreeCAD 1.1.4 installed (see Install FreeCAD); timeout defaults to 120 seconds. Headless `freecadcmd` runs `scripts/techdraw_job.py`: a TechDraw projection group places the front, top, and right views in the regime's projection angle. `--scale` is the largest scale tried; smaller standard scales follow until the views and annotations fit the drawing area.
3. `scripts/drawing.py` composes the sheet, then runs `scripts/layout_check.py` over the SVG. A violation fails the run with `layout_check_failed` and writes `drawing_<run>.rejected.svg`. The check rejects:
   - annotation text that overlaps a view, another text, the frame, or the title block
   - two views closer than 10 mm, or a view outside the frame
   - a projection symbol outside its title-block cell
   - a remaining template placeholder
4. `scripts/sheet_export.py` exports the checked SVG through FreeCAD's bundled Qt. `freecadcmd` runs `scripts/export_job.py` on Qt's offscreen platform, without a display or GUI FreeCAD.
   - The PDF page is the sheet size. Its text stays selectable, in FreeCAD's osifont lettering font.
   - A PNG preview at 144 dpi comes from the same painting.
   - The export reads the PDF back. A blank preview, or PDF text without a title-block value, fails the run with `empty_drawing`.
   - A Qt write failure, or a page size other than the sheet's, fails the run with `export_failed`.
5. Review the JSON report and the PNG preview. Confirm the orthographic views, dimensions, title block, and projection symbol.
6. After a human reviews the PNG preview, record the accepted drawing checks in the hardware project's `verification.csv`.

## Install FreeCAD

`drawing.py` takes the first `freecadcmd` it finds:

1. the path in `FREECADCMD`, used as given
2. `freecadcmd` or `FreeCADCmd` on `PATH`
3. `/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd`

The TechDraw templates come from the same FreeCAD, in `share/Mod/TechDraw/Templates` next to the resolved `bin/freecadcmd`. Name the bundle's own `freecadcmd` or a symlink to it. A wrapper script, such as the AppImage's `AppRun`, hides the templates.
- macOS: install `FreeCAD_1.1.4-macOS-arm64-py311.dmg` (or `-x86_64-`) from the [FreeCAD 1.1.4 release](https://github.com/FreeCAD/FreeCAD/releases/tag/1.1.4) into `/Applications`.
- Linux x86_64 or aarch64: download the matching `FreeCAD_1.1.4-Linux-<architecture>-py311.AppImage` and its published `-SHA256.txt` from the [FreeCAD 1.1.4 release](https://github.com/FreeCAD/FreeCAD/releases/tag/1.1.4). Compare the AppImage's SHA-256 digest with the published checksum before extracting it. Extraction needs no FUSE. Link `freecadcmd` onto `PATH`:
  ```sh
  # From the directory containing the downloaded AppImage and checksum file:
  sha256sum --check FreeCAD_1.1.4-Linux-x86_64-py311.AppImage-SHA256.txt
  chmod +x FreeCAD_1.1.4-Linux-x86_64-py311.AppImage
  ./FreeCAD_1.1.4-Linux-x86_64-py311.AppImage --appimage-extract   # writes ./squashfs-root
  ln -sfn "$PWD/squashfs-root/usr/bin/freecadcmd" ~/.local/bin/freecadcmd
  ```

  Keep `~/.local/bin` on `PATH`, or set `FREECADCMD` to the symlink. The AppImage carries its own Python, Qt and lettering font.

## Inputs and outputs

- `part.yaml`: `PN`, `rev`, `title`, and `material` fields populate the template's editable title-block fields.
- `product.yaml`: `regime` selects the shipped ISO 5457 A4 template with first-angle views, or the ASME ANSI A template with third-angle views; `general_tolerance` fills the tolerance field.
- Title-block fields the record does not carry (author, approver, issue date, company, CAGE code) are blank, never the template's sample text.
- The STEP file and `--metrics` JSON must belong to the same model version. `--metrics` provides each bore's part ID, axis, position, and diameter for drawing callouts; a bore that does not project onto a circle of its diameter fails the run with `metrics_mismatch`.
- Successful outputs are `drawing.pdf`, `drawing.svg`, a PNG preview, a run-specific completion marker, and a JSON summary; exit code 0 indicates all outputs passed validation.

## Rules

MUST Inspect the PNG preview, painted the same way as the PDF page, to confirm non-empty projections, dimension placement, title fields, metric bore callouts, and the regime's projection symbol.
MUST Fail a run when any projected view has no visible outline, the layout check reports a violation, the PNG preview is blank, or the PDF text lacks PN, revision, title, material, or tolerance.
MUST Require `metrics.json` for the same STEP version, and populate bore callouts from its per-part `holes` data rather than inferred cylinders.
MUST Treat a drawing as one static part pose; it does not describe dynamics, process plans, or assembly performance.
NOT Bores whose axis is not along the front view direction get no callout; the report lists them under `warnings`.
NOT Generated overall dimensions replace neither deliberate functional dimensioning nor tolerance review.
