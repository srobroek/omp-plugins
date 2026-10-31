# Changelog

## [0.4.0](https://github.com/srobroek/omp-plugins/compare/cad--v0.3.0...cad--v0.4.0) (2026-10-31)


### ⚠ BREAKING CHANGES

* **cad:** check minimum walls per process and limit block_like to solid parts
* **cad:** the pair cache moves to hw/.cad/pairs-v2.sqlite; a sweep whose between-sample check leaves an interval unproved now reports status "incomplete" and exits 2 (use --no-continuous for a sampled-only run); sweep run records live under hw/.cad/runs/; timings_s counters are renamed (kernel_evaluations, exact_hits, ...).
* **cad:** catch missing retention and see-through FDM parts at L2

### Features

* **cad:** build only changed parts, store part outputs once, and keep results out of git unless approved ([0d8c248](https://github.com/srobroek/omp-plugins/commit/0d8c248fbb465e42757285d6d8056fb6f50371b5))
* **cad:** catch missing retention and see-through FDM parts at L2 ([d761ee9](https://github.com/srobroek/omp-plugins/commit/d761ee995e9038987aef8db91e026f950cc35d1e))
* **cad:** check minimum walls per process and limit block_like to solid parts ([dc89664](https://github.com/srobroek/omp-plugins/commit/dc89664da1d29f54f3edb8c6e62815dca552adbc))
* **cad:** check requirement window visibility and reuse unchanged views in renders ([94dbb08](https://github.com/srobroek/omp-plugins/commit/94dbb088769ecca152b5cf6d1a06660505a6fc8c))
* **cad:** check versions fail-fast and close each built stage with provisional and human gates ([6923317](https://github.com/srobroek/omp-plugins/commit/6923317beabc47eb019f229d81a2fe2466881e33))
* **cad:** prune versions after release and generate record docs ([e229d40](https://github.com/srobroek/omp-plugins/commit/e229d40af636a76b27d7974164dd5339d05f4676))
* **cad:** sweep v2 with between-sample proofs, subsystem runs and merges ([98102a0](https://github.com/srobroek/omp-plugins/commit/98102a0c14ac65ec3e3d952830424d13e8498edc))
* **cad:** tolerate cosmetic fillet failures and smoke FreeCAD runs ([358cdb2](https://github.com/srobroek/omp-plugins/commit/358cdb2589f9c2c99d602204db5b0e3a921118ca))


### Bug Fixes

* **cad:** diagnose CalculiX crashes and timeouts, and allow per-case FEA time limits ([a2b4fb0](https://github.com/srobroek/omp-plugins/commit/a2b4fb0805335e347fb4dfa87da7cd12bf4a7bc3))
* **cad:** dimension hole centres from datum planes and print feature tolerances on drawings ([b3dbfe7](https://github.com/srobroek/omp-plugins/commit/b3dbfe71d2f38dc5b46336641643d21476519a45))
* **cad:** repair tool defects found by the Claude Code E2E run ([beea91e](https://github.com/srobroek/omp-plugins/commit/beea91e5283d15d184a22f4a11ce237c743fc93e))


### Documentation

* **cad:** state that visibility fractions apply to each target ([4e9488e](https://github.com/srobroek/omp-plugins/commit/4e9488e0c735adf7d2138c0748fcef6738214e08))

## [0.3.0](https://github.com/srobroek/omp-plugins/compare/cad--v0.2.0...cad--v0.3.0) (2026-10-30)


### Features

* **cad:** render custom view directions and assess shadows only when the floor is in frame ([12031db](https://github.com/srobroek/omp-plugins/commit/12031db46e5bd4120368ec857ed3ffa83221d2ce))


### Bug Fixes

* **cad:** clear error when a model version label already exists ([00e7dbf](https://github.com/srobroek/omp-plugins/commit/00e7dbf43f700a0de1c8f2998b7836577b10b272))
* **cad:** distinguish blocks from planar frames ([9e08010](https://github.com/srobroek/omp-plugins/commit/9e080107afc9f664dca19edd970c4ffff166dc52))
* **cad:** save concept viewer screenshots ([533654f](https://github.com/srobroek/omp-plugins/commit/533654fd1d02addfb2b3a6567dea854c1e56b6a2))


### Performance

* **cad:** clear far pair-poses by mesh bounds and reuse periodic placements in sweeps ([30083fc](https://github.com/srobroek/omp-plugins/commit/30083fc8fc37c4018c410f5f8623f08ded469ba2))

## [0.2.0](https://github.com/srobroek/omp-plugins/compare/cad--v0.1.0...cad--v0.2.0) (2026-10-30)


### Features

* **cad:** add the CAD design plugin ([ab1dac9](https://github.com/srobroek/omp-plugins/commit/ab1dac9e4828b0dd20535c352960c54e0151cca4))


### Bug Fixes

* **cad:** serve the concept viewer's modules and deliver scratch parts past build output ([a065283](https://github.com/srobroek/omp-plugins/commit/a065283e504e900c6be9520c6b25c8bcfb5ae777))


### Documentation

* **delivery:** align review loop limits ([#405](https://github.com/srobroek/omp-plugins/issues/405)) ([5cd2b7b](https://github.com/srobroek/omp-plugins/commit/5cd2b7b2589aa27edc1d0c549a7f533171b672a4))

## 0.1.0

### Features

- Scope cad-viewer hosts by project and harness or named session; add idle shutdown and per-session stop instructions.
- Add runtime preflight for CAD tools, kernel environments, drawing templates, and harness installation.
- Add `cad-flow/scripts/setup.py`, which runs the user-level setup steps preflight reports missing. It requires FreeCAD 1.1.4 before it continues; the user installs FreeCAD from the official release and verifies its published checksum.
- Add `cad-record` for design records, `cad-concept` for three.js concept exploration, `cad-model` for CadQuery/build123d builds and checks, and `cad-design` for the F0–F3 fidelity ladder and form checks.
- Add `cad-motion` for kinematic poses/sweeps, `cad-render` for automated PBR images, and `cad-viewer` for interactive OCP inspection and Studio look-dev.
- Add `cad-recheck` for batch-boundary/dependent rechecks, `cad-fits` for fits and stack-ups, and `cad-bom` for EBOM roll-up.
- Add `cad-review-mech` and `cad-review-dfm` skills and their read-only critique agents.
- Add `cad-flow` for the staged prototype-to-release workflow; `cad-analysis` for static FEA; and `cad-drawings` for technical drawings.
- `cad-drawings` part drawings bind `drawing_features` locators to the final STEP, measure every required characteristic in the datum frame, take fit limits from cad-fits, and fail a completeness gate with the drawing architecture's codes. Catalogue items get vendor specification sheets that control only the specification's limits; a specification can be cited by url and sha256, its frozen copy recorded as a sourcing input. Every lamp template part carries drawing or procurement intent. Section views fill each cut face on its own and every face of a part alike (ISO 128-3, ASME Y14.3): 45° lining spaced a third of the part's typical width (0.7 to 3 mm), or solid when that width is under 2.1 mm; the `section_hatch` gate checks each face's filled area and each part's single fill, line density and solid-only-when-thin.
- Add assembly drawings to `cad-drawings`: ISO 6433 / ASME Y14.34 balloons on each occurrence's visible geometry, a parts list from `bom.csv`, and assembly notes whose seating is measured on the model; `assembly_check.py` re-checks a package. `cad-record` gains the `assembly.yaml` `drawing` schema, and the lamp template its drawing intent and ring occurrence pairs.
- Publish part and assembly drawings as immutable bundles by version and subject (`hw/drawings/vN/<PN|assembly>/`), reusing a matching recipe, refusing a changed one without `--replace`, and keeping rejected drafts under `.cad-work/`. cad-record's layout/release integration, frozen-version flow, migration reporting, and the lamp manufacturing policy are summarized with the model changes below.
- Add `cad-record/scripts/build_guide.py`: a GitBuilding guide per version with tables for parts to make (linking each part's manufacturing STEP/STL) and to buy (designation or order code, OPEN items with their reasons, bought-to-drawing sheet PDFs), tools and consumables per step, numbered assembly steps worded and measured as the assembly drawing's notes, and checks before use. The index, DIN SPEC checklist and OKH templates stay generic.
- Workflow reports give print/make files, purchases, assembly steps and checks as lists or tables with absolute paths, never inline prose.
- Part drawings state ISO 13715 edges and ISO 21920-1 surface texture (ASME notes and Y14.36 symbols in the ASME regime): a `part.yaml` `drawing.edges` general indication with per-feature exceptions, a general `surface_texture` in the notes (or `open` with its reason, a `surface_texture_open` release blocker), and per-feature texture symbols in the feature's callout; the gate requires both on a detail drawing. A `location` dimension request gives a plane its own limits. A standard part names its `procurement.standard` and is orderable by its designation without a manufacturer part number. The lamp template applies the accepted DR-004 tolerances, edges and textures.
- Add eleven Beads formulas: the `cad-touch`, `cad-part`, and `cad-product` orchestrator roots, whose stages fan out bondable worker molecules (`mol-cad-variant`, `mol-cad-part`, `mol-cad-sourcing`, `mol-cad-detail`, `mol-cad-analysis`) in one parallel batch before one lead integration step and one human gate, plus the `mol-cad-concept`, `mol-cad-iterate`, and `mol-cad-release` sub-workflows.
- Add the `cad-concept-designer`, `cad-part-designer`, `cad-sourcing-researcher`, and `cad-analyst` worker agents. A part designer builds and checks a scratch copy of `hw/` (`cad-flow/scripts/scratch.py`) and delivers only its own part directories, so `hw/versions/` changes only in the lead's integrated builds.
- Generate Claude Code, Kiro, and OpenCode files for every CAD agent from the canonical OMP agents, with write access only under `.cad-work/` and shell access only for `uv`.
- Add the eval harness for cross-harness/model trials, geometry and record graders, smoke tests, and pairwise judging.
- Add per-pair clearance requirements: an `interfaces.yaml` `type: clearance` interface names a `pair` and `min_clearance_mm`, validated by `cad-record`, held by cad-model `check` (`pair_clearance`) at the nominal pose and by cad-motion `sweep.py` at every sample, joint-connected and fitted pairs included; `--pair-clearance REF:REF=MM` adds or overrides one for a run, and a cached pair measurement near a threshold is measured again. A pair declared as a press fit, running fit or heat-set insert no longer inherits the sweep's global `--min-clearance`, and the `minimum_clearance` worst case ranks each pair against its tightest requirement.
- Add bounded `--jobs` concurrency to part and assembly drawings, isolate each FreeCAD job's user/config/cache/temp state, preserve report order, and terminate every active FreeCAD process group on SIGINT/SIGTERM.
- Pin generated drawing text to FreeCAD's bundled Osifont for repeatable PDFs; draw registered symbols absent from the font as vectors and reject every other unsupported glyph.
- Add bounded `--jobs` capture in cad-render. Each Chromium page loads the scene once and captures its assigned views concurrently. Seed GTAO noise per view/retry and invalidate floor-shadow bakes when visible geometry or framing changes so parallel images remain deterministic.
- Add `cad-render/scripts/compare_renders.py` for exact image-and-decision parity checks. Store the measured parity policy in the cache key so changing acceptance invalidates stale render manifests.
- Measure the pairs of cad-motion `sweep.py` and cad-model `check` with one pair measurer, `cad-motion/scripts/pair_measure.py`. Every reported value is bitwise the one a separate measurement of each pair request gives. The speed-ups:
  - A pair whose bounding boxes are apart skips OCCT's containment test.
  - The sweep reuses a measurement only on the exact bits of a pair's placement, which it composes from the joints below the pair's lowest common ancestor.
  - The sweep skips a request when an exact lower bound (the box gap, or a nearby sample's distance minus the motion between them) lies beyond the pair's minimum and each of its thresholds.
  - By default (`--jobs 1`), measurements run in one process on OCCT's thread pool. `--jobs N` measures in N worker processes; `--jobs auto` uses the CPU count, at most 8.
  - A pair cache keeps measurements across runs and tools, `$XDG_CACHE_HOME/cad-motion/pairs.sqlite` (`--cache DIR`, `--no-cache`). Its key is both parts' geometry, the exact placement, the measuring code, OCP version and platform.

  On pace (32 cores, load average about 20), the lamp template's default sweep went from 1 147 s to 35 s, and to 5 s with a warm cache. After one part changed, it took 13.6 s instead of 45.6 s. Its check went from 39.0 s to 6.6 s, and to 4.0 s warm.
- Two outputs moved once with the new measurer, at float-noise level only. Exact reuse resolves a tie between equally close samples as a separate measurement does. On the V6 fixture, 17 of 210 pairs report another tied sample at the same distance. Its `minimum_clearance` worst case is now crank 640°, the 360° repeat of crank 280°, with the same pair and 0.8788 mm. On the lamp template, 8 of 66 pairs report another tied sample. cad-model `check` now measures part b in part a's definition frame, like the sweep, so that the two share cache entries. Its reported distances and volumes moved by at most 2.6e-13.
- Sweep `timings_s` drops `threshold_rechecks` and gains `pair_requests`, `pruned` and `disk_hits`. Check `timings_s` gains `pair_evaluations` and `disk_hits`. A sweep stopped by `--time-limit` reports only the leading samples it measured in full. Requests are measured out of sample order, so that can be fewer samples than before. A kernel exception during a sweep exits 2 with a message instead of a traceback.
- Add cad-record's generated `layout.json` path contract and `layout.py` API for immutable, manifest-bound bundles, version record snapshots, scratch-only output overrides, stage-graded migration findings, manufacturing outputs, frozen-version anchors and `release.py` packages. CAD workflows, formulas, agents and generated harnesses use that one path table; existing projects can inspect a read-only migration plan, and legacy versions/releases remain unchanged. Every custom-made part is built with checked STEP output and FDM STL where applicable. The lamp example declares manufacture policy/mesh tolerance and printer envelope, preserves its prototype revisions, and the build guide links to versioned manufacturing files and drawing sheet PDFs.
- cad-model passes a SHA-256-verified FreeCAD TechDraw Osifont path to opted-in text models and refuses `text()`/`Text()` calls without an explicit font file path, preventing kernel font fallback from varying by host.
- Add cad-motion `motion.py plan|render`. Case `default` is generated from the record; an authored case is `hw/motion/cases/<case>/plan.yaml`, which cad-record `validate.py` loads as `motion.py` does. Every independent joint must visit its whole range, and a gap fails unless the plan declares `partial` with a reason. A render publishes `hw/motion/vN/<case>/` as an immutable bundle: an animated `motion.glb` built from the version's own GLB, a captioned contact sheet, a constant-fps H.264 `video.mp4` (imageio-ffmpeg 0.6.0) and frames drawn by cad-render. `--crosscheck freecad` solves a coupled record in FreeCAD on the same frames. cad-viewer `animate --case` plays a plan. cad-flow runs the default motion render on every L1-L4 batch once a joint moves, and `cad-analyst` gains the `motion` case kind.

### Bug Fixes

- The interference rule of cad-model `check` and cad-motion `sweep.py` reports a part buried inside a solid of a compound part (a definition that reads back as a COMPOUND, such as one fused from separate solids), no faces touching, as overlapping at distance 0. BRepExtrema detects containment only inside a SOLID or COMPSOLID operand, so such a part read as clear before.
- `check.build_volume` now fits an oriented box with its axes assigned to the printer axes in each order and measures each candidate after rotating it. Before, it tested the box extents in their own order and then lowered the height, which could report a fit that does not fit an asymmetric printer volume. It also fits an FDM part in the state it is printed in, against the printer of the version's record snapshot.
- `release.py` releases a version built with `--attach`. It counted each `REF=PARENT_REF` entry as a part and refused every such release.
- `validate.py` no longer requires the originals of a version 2 release to exist; it checks the package's own copies. An edit to `hw/docs/` or a part source after release no longer fails validation and blocks the next release.
- `release.py` refuses verification evidence that cites a missing file inside the frozen version or a selected bundle.
- `build_guide.py` links the release frozen at the guide's version instead of the newest release, and no release when none holds that version.
- The `cad-product`, `cad-part`, `cad-touch` and `mol-cad-release` formulas hold the RELEASE gate before `release.py`, so a declined release no longer uses up its revision letter. The lead records the approval as the release decision after the gate.
- `cad-touch` takes the product release letter as a new required `release_rev` variable instead of the part's `to_rev`, so a second ECO that bumps another part from A to B can still be released.
- The cad-flow reference's `release.py` example uses revision `A`; `X` is not a release revision.
- cad-drawings draft and merge resolve `latest` through the layout API (they called a missing function), the assembly drawing accepts `--version latest`, and draft output must stay under `.cad-work/`. Drawings read the version's `record/interfaces.yaml` and bind its hash into the recipe, so a fit change no longer reuses a stale bundle. Sealed `package.json` paths are project-relative.
- Assembly drawings no longer report numbered BOM assembly rows as geometry mismatches, report the kept rejected sheets and their previews, look sheets up by number, and finish publishing before acting on an interrupt. The perpendicularity symbol is drawn the right way up.
- One FreeCAD lookup, cad-flow preflight's, serves drawings, FEA and the motion cross-check, including `~/.local/bin/freecadcmd` off PATH; an invalid `FREECADCMD` is refused rather than skipped. The drawing runtime's signal handler no longer deadlocks, and an unknown memory size (macOS) no longer forces `--jobs 1`.
- `setup.py` imports `subprocess` (its `--yes` path crashed), lists the GL/X11/expat libraries OCP needs on headless Linux, and offers `playwright install-deps` on Debian and Ubuntu. Preflight reports a missing OCP shared library with that fix instead of a network hint.
- The motion FreeCAD cross-check and cad-viewer `animate`/sections include the version's `--attach` joints. The generated default motion plan scales its step to stay under the frame cap. Motion frames are written as they render instead of held in memory. cad-render close-up alternates stay inside the frame, and a clean candidate beats a clipped one.
