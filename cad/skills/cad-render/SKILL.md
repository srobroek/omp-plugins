---
name: cad-render
description: Renders cad-model versions into PBR product PNGs and checks requirement window visibility, for stage gates. Triggers on "render v3", "show me the renders".
---

# CAD Product Render

Stages L1 LAYOUT to L4 ANALYSIS: every commit batch renders its version after `cad-model run`,
and every stage gate shows the renders. Use `cad-concept` for L0 CONCEPT variants.
Paths below are relative to this skill's directory, `skill://cad-render/`.
Interactive look-dev (environment, exposure, shadow and AO tuning by eye) runs in OCP CAD
Viewer Studio mode through `cad-viewer`; this skill is the unattended renderer.

TRIGGER
+ "render v3", "show me the renders", "what does it look like now", "product shot"
+ an L1 to L4 commit batch after `cad-model run`, or any stage gate in `skill://cad-flow`
+ "can the pistons be seen through the cover": a requirement `visibility` binding, checked by every render
- L0 concept variants -> `skill://cad-concept`
- interactive look-dev, orbiting, section or explode by hand -> `cad-viewer` (OCP CAD Viewer Studio mode)
- a check result (validity, interference) -> `skill://cad-model` `check`; a render is never one

## Workflow

1. Build first: `skill://cad-model` `run` writes `hw/versions/vN/` and `latest.json`.
2. Render: `uv run --script skill://cad-flow/scripts/run.py cad-render/scripts/render.py hw [--version latest|vN] [--views ...] [--size WxH] [--subject S] [--replace] [--out-dir .cad-work/...]`
   -> immutable `hw/renders/<vN>/<subject>/` bundles with requested PNGs, `render.json`, and `manifest.json`.
   `--views` accepts `iso front side exploded`, `closeup-<PN>` / `part-<PN>`, and custom `dir-<X>-<Y>-<Z>` directions in assembly coordinates (+Z up, front -Y). Encode each signed decimal using `p` or `m` and `d` for the decimal point; for example `dir-p1-m1d5-p0-closeup-LMP-0004`. Directions are normalized. `-closeup-<PN>` or `-part-<PN>` optionally frames a PN from that direction; `@occurrence` uses the same explicit, filename-safe reference accepted by `closeup-@occurrence`. Names are deterministic and safe as `{VIEW}.png` bundle file names. Camera up switches to +Z near vertical directions.
   The bundle manifest seals its files and binds the bundle to the version manifest. `render.json` holds
   quality, retry, material and input decisions. A same-recipe bundle is reused, including with `--replace`;
   use `--replace` only when a conflicting recipe should be retained and replaced. `--out-dir` is
   scratch-only under `.cad-work/` and never overwrites an existing path.
   `--jobs` uses 1-8 dedicated pages in one Chromium process (default 1). Each page loads the scene once
   and renders its assigned views serially, while pages capture concurrently. On CPU-only SwiftShader, keep
   the default: SwiftShader already multithreads. Pace measured 11s at jobs=1, 12s at 2, and 17s at 4
   for five 800x600 views. Use higher values when tests on the target hardware show a benefit.
   The render metadata records page-load, view-capture, renderer, and PNG-encoding times.
   Per-view PNG SHA-256 values verify cache integrity. From this skill directory, run
   `uv run --script scripts/compare_renders.py DIR_A DIR_B` to compare render decisions and PNG pixels.
   At default 1600x1200, Mac serial runs and pace serial-vs-serial / serial-vs-jobs2 runs (30 views) matched
   byte-for-byte. The comparator uses exact parity.
   Each capture seeds GTAO noise from the view and retry index. The floor-shadow bake key includes visible part transforms and sampling settings.
   Motion frames: `render.py hw --version vN --motion SPEC.json --out-dir .cad-work/...` renders the
   frames, contact sheet and `motion-render.json` that cad-motion `motion.py render` writes the spec
   for and publishes; run it through motion.py. The camera is fixed per segment and the floor
   shadow is left out.
3. Close-ups: add `closeup-<PN>` for each part/interface to show, or `part-<PN>` for a studio view of
   one part in stable resting orientation with the other assembly parts hidden.
   A later version copies a view from a prior version's bundle of the same subject instead of rendering
   it, when every input of its pixels matches (see Reuse across versions).
4. Read every PNG before describing it. Name the material each PN shows from
   `render.json` `materials.<PN>` (`rule`, `label`, `applied`).
5. Gate: put each PNG's absolute path in the gate report, one per line, with one line on what the image shows. Absolute paths are clickable in the terminal; a path relative to `hw/` is not.

Exit codes: 0 every view is usable (pass or warning, including cache hits) and every visibility check
passes; 1 an unusable view remains after its retry ladder or a visibility check fails, with PNGs and a
`status: fail` render.json still written; 2 usage or infrastructure error (nothing written).

| Finding | Classification | Meaning and action |
|---|---|---|
| `BLANK` | unusable | subject under 0.5% of frame or nothing but backdrop; retry once on fixed views, use the close-up ladder before failing |
| `CLIPPED` | unusable | a subject pixel touches the frame edge; reframe; close-ups continue through the camera/ghost/isolated ladder |
| `OCCLUDED` | unusable close-up | less than 25% of isolated subject pixels remain visible; retry alternate camera angles, ghost context, then isolated fallback |
| `NO_SHADOW` | warning | when the camera frustum intersects the ground plane, the shadow is below threshold; tight close-ups that exclude the floor are not graded for a ground shadow |
| `INVERTED_SHADOW` | warning | contact shadow is no darker than high-overhang shadow; keep PNG and report warning |

Every attempt records its strategy, camera, findings, and metrics in the manifest. A requested view
is never silently dropped. Report warnings and the strategy used, with the absolute PNG path for
each view. A view may be omitted only with an explicit reason.

`part-<PN>` hides every other part, rests it on the floor, and frames the part with its floor shadow.


The floor shows only a baked studio shadow: a dark contact shadow at the foot of every part on
the floor, plus a wide, faint softbox shadow whose penumbra grows and darkness falls with a
part's height. The key light shades the parts onto each other, never the floor.

The cache key includes every version-bound scene input, resolved material and exact-parity policy.
Repeating the same version and subject reuses its verified immutable bundle, including with `--replace`;
`--replace` retains and replaces a bundle only when its recipe differs. Compare bundles or scratch directories through their `render.json` files.

## Requirement visibility

Every render checks each `visibility` binding of the current `hw/requirements.yaml`, read through
cad-record `design_rules.visibility_bindings`, on the selected version's geometry at its built
(nominal) pose. A binding's view is `iso`, `front`, `side` or `dir-X-Y-Z`; any other view refuses it
(exit 2), as does a window or target part the version does not place once.
- The camera looks along the view, framed on the window and target parts. Every other part is hidden and the floor is left out.
- A target's visible fraction is the share of its own silhouette, drawn alone, where it stays the nearest surface once the occluders are drawn. The occluders are the other window and target parts.
- A part whose `part.yaml` declares `transparency: transparent` is see-through. `opaque` (the default) and `translucent` parts occlude.
- Each target must reach the binding's `min_visible_fraction` (default 0.5); the check fails when any target does not.

`render.json` `visibility` lists each check with its camera, `see_through` parts, and each target's
`silhouette_px`, `visible_px`, `visible_fraction` and `status`; the stdout summary has
`visibility.<REQ-ID>/<index>` with the status and fraction per target. `inputs.requirements_yaml_sha256`
records the requirements file. The resolved checks are part of the cache key, so rewording a
requirement keeps a cache hit, and changing a binding does not.

## Reuse across versions

Every view records `render_inputs`, the inputs its pixels depend on: the view spec, image size,
renderer hash and parity policy, plus:
- a part view (`part-<PN>`, `dir-...-part-<PN>`): the subject's GLB mesh data and world placement, and its PN's resolved material. The part STEP alone would not do: cad-model tessellates with a deflection relative to the assembly's size.
- every other view, close-ups in context included: the whole GLB and every scene part, material and explode offset. It re-renders when any occurrence changes.

Before capturing, render.py looks for each view in the prior versions' bundles of the same subject,
newest first. It copies the PNG and view record from a bundle that verifies, when the image was usable
(pass or warn), its PNG still matches its hash, and its `render_inputs` are equal. The copied record keeps its
quality and adds `reused` (`version`, `bundle`, `rendered_in`, `sha256`); the summary lists them under
`reused`. Copied views are not captured.

## Rules

MUST Treat exit 1 as a failed render for the batch; report unusable findings and metrics verbatim.
MUST Report a failed visibility check as a failed requirement: requirement, target, `visible_fraction` and `min_visible_fraction`.
MUST Keep warning-only renders; report warning, retry strategy, and each requested view's absolute PNG path.
MUST Install the headless browser once per machine: `uv run --with playwright==1.64.1 playwright install chromium`. The manifest's `renderer.playwright` is the installed version.
DEFAULT Default views are iso, front, side, and exploded at 1600x1200; `--size WxH` overrides.
NOT Render L0 concept variants here; `cad-concept` owns them.
NOT Hand-edit `hw/renders/`; it is derived and replaced whole on every miss.
NOT Install Blender for this skill; a Cycles hero-shot route is a future option, not installed.

```text
L1 RENDER vN: PASS|FAIL|CACHE HIT, {views} views, {wall s}
   Failures -- {view, failure, and metric, only if any}
   Visibility -- {REQ-ID/index: PASS|FAIL, each target's visible_fraction, only if bindings exist}
   Reused -- {view <- version it was copied from, only if any}
   Renders -- {absolute PNG path and one line each on what it shows}
```
CAP 80w clean · 160w with failures
