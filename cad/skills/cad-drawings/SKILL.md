---
name: cad-drawings
description: Use for generating checked, producer-ready FreeCAD part drawings (PDF, SVG, PNG) from a built cad-model version and the part's drawing intent.
---

# CAD Drawings

TRIGGER
+ A part at L3 DETAIL needs a production drawing, or a bought part needs a vendor specification sheet.
- 3D motion, renderings, CAM, or non-FreeCAD CAD edits → use the owning workflow; this skill draws static parts.

## Workflow

1. Give the part's `model.py` a `drawing_features(params, shape)` hook (cad-model `references/contract.md`) that names every final face by its semantic role, and give `part.yaml` a `drawing` block: datums, coordinate frame, views, per-feature intent, extra dimension requests, geometric tolerances, notes and sheet policy. LOAD `references/drawing-intent.md` for the feature kinds and fields, and `references/drawing-standards.md` for the producer-ready rows.
   For a catalogue item, give `part.yaml` a `procurement` record and, when the item needs a sheet, a `vendor_specification` or `source_control` drawing whose `dimensions` carry the specification's limits; LOAD the vendor section of `references/drawing-intent.md`.
2. Give `product.yaml` a `drawing` policy (projection, standards, default sheet, named tolerance policies). Bind interface sizes in `interfaces.yaml`: fits as `hole`/`shaft` feature endpoints, heat-set seats with `feature`, ring grooves on `retaining_ring.feature`.
3. Build the version: `uv run --script skill://cad-flow/scripts/run.py cad-model/scripts/cad_model.py run hw --label vN`.
4. Run `uv run --script skill://cad-drawings/scripts/drawing.py hw [--version vN] --part PN [--part PN ...] --output-dir DIR [--timeout S] [--jobs N]` with FreeCAD 1.1.4 installed (see Install FreeCAD). Each part's package goes to `DIR/<PN>/`. `--jobs` bounds concurrent part jobs. Without it, the tool uses CPU count, requested items, and available memory divided by its 1.5 GiB per-job RSS estimate. Each process uses isolated FreeCAD user data/temp, Qt/XDG and temporary paths. Results remain in input order; duplicate part numbers are rejected because they target the same package directory.
5. Read the JSON summary and every PNG preview. A failing run lists findings with the architecture's failure codes and leaves `sheet-1.rejected.svg`/`.png` and `rejected.json`, never a PDF.
6. After a human reviews the preview, record the accepted drawing checks in the project's `verification.csv`. `release.ready` stays false for an `X` revision or a bought part without a selected supplier.

## Pipeline

- `drawing_contract.load_context` validates the record and verifies the version's file hashes; a stale build fails with `source_mismatch`.
- `techdraw_job.py` (freecadcmd, headless) reads the part STEP, extracts every face and binds each locator patch to exactly one face (`feature_geometry`): `feature_not_found`, `feature_ambiguous`, and `geometry_unaccounted` for a face no feature claims.
- `drawing_intent` resolves the datum frame and measures each feature kind's required characteristics from the STEP faces: sizes, locations in the frame, depths, chamfers, radii, angles, patterns, profiles and threads. Fit sizes take nominal and class from `interfaces.yaml` and limits from cad-fits (Decimal); the modelled midpoint must lie inside them (`fit_geometry_mismatch`). Every axial end of a cylinder or taper must lie on a located plane or meet a chamfer, round or surface.
- `part_views` plans the views from the intent; `techdraw_job.py` projects them (sections, details) and returns each view's model-to-sheet map.
- `sheet` places baseline dimensions from the datums, callouts with leaders to visible outline points of the feature's own faces, feature control frames, datum feature symbols, centre lines, section lines, detail circles, and the section fill (`section_hatch`: one lining per part in a view, spaced in proportion to the part, or solid when the part is under 2.1 mm wide). Sheet size and scale come from the policy: the largest standard scale that fits on the smallest allowed sheet and keeps the largest view at least 60 mm long.
- `completeness.evaluate` writes the coverage rows (feature, requirement, measured value, STEP hash, tolerance, annotation, view, status) and fails a section whose cut faces are not each filled over their projected area, or whose parts are not filled alike, densely enough and solid only when thin (`section_hatch`); `drawing_document.publish_package` runs `layout_check` and the Qt export and publishes only a passing package.

## Assembly drawings

LOAD references/assembly-drawings.md before writing the `drawing` block of `assembly.yaml`.

1. Run `uv run --script skill://cad-flow/scripts/run.py cad-drawings/scripts/assembly_drawing.py hw --version vN --output-dir <dir> [--jobs N]`. It produces checked sheets for the top assembly and each `assembly.drawing.subassembly_sheets` group, with assembled and exploded views, item balloons, a parts list from `bom.csv`, and assembly notes. `--jobs` uses the same bounded worker policy for independent sheets and their exports; report ordering remains sheet order.
2. Re-check a published package with `uv run --script skill://cad-flow/scripts/run.py cad-drawings/scripts/assembly_check.py <dir>`. SIGINT/SIGTERM terminates every active FreeCAD process group.

## Install FreeCAD

`drawing.py` takes the first `freecadcmd` it finds:

1. the path in `FREECADCMD`, used as given
2. `freecadcmd` or `FreeCADCmd` on `PATH`
3. `/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd`

- macOS: install `FreeCAD_1.1.4-macOS-arm64-py311.dmg` (or `-x86_64-`) from the [FreeCAD 1.1.4 release](https://github.com/FreeCAD/FreeCAD/releases/tag/1.1.4) into `/Applications`.
- Linux x86_64 or aarch64: download `FreeCAD_1.1.4-Linux-x86_64-py311.AppImage` (or `-aarch64-`) and its `-SHA256.txt` from the same release. Compare the checksums. Extract the AppImage, which needs no FUSE, and link its `freecadcmd` onto `PATH`:

  ```sh
  chmod +x FreeCAD_1.1.4-Linux-x86_64-py311.AppImage
  ./FreeCAD_1.1.4-Linux-x86_64-py311.AppImage --appimage-extract   # writes ./squashfs-root
  ln -sfn "$PWD/squashfs-root/usr/bin/freecadcmd" ~/.local/bin/freecadcmd
  ```

  Keep `~/.local/bin` on `PATH`, or set `FREECADCMD` to the symlink. The AppImage carries its own Python, Qt and lettering font.

## Outputs

`DIR/<PN>/` contains `sheet-1.svg`, `sheet-1.pdf`, `sheet-1.png` (144 dpi), `coverage.json`, and `package.json` with provenance hashes and release blockers. The PDF uses selectable Osifont text. Registered missing symbols render as vectors; unregistered glyphs fail export. Exit 0 means every drawing passed, 1 means a content check failed, and 2 means invalid input or infrastructure failure.

## Rules

MUST Inspect every PNG preview; a passing gate proves the implemented contract, not ISO or ASME conformance or engineering approval.
MUST Take every dimension value from the model; part.yaml carries requests and tolerances, never values.
MUST Bind each interface size to its fit or heat-set declaration; never print the modelled mid-limit as the nominal.
MUST Treat `revision_unreleased` and `procurement_incomplete` release blockers as open until the record is released and sourced.
MUST Give each controlled dimension on a vendor sheet its specification's limits, or mark it `reference: true`; a bought item takes no general tolerance.
NOT A catalogue part without `drawing` intent gets no sheet; its procurement record is still checked.
