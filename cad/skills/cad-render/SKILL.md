---
name: cad-render
description: Renders cad-model versions into PBR product PNGs (iso, front, side, exploded, close-ups, part views) for stage gates. Triggers on "render v3", "show me the renders".
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
- L0 concept variants -> `skill://cad-concept`
- interactive look-dev, orbiting, section or explode by hand -> `cad-viewer` (OCP CAD Viewer Studio mode)
- a check result (validity, interference) -> `skill://cad-model` `check`; a render is never one

## Workflow

1. Build first: `skill://cad-model` `run` writes `hw/versions/vN/` and `latest.json`.
2. Render: `uv run --script skill://cad-flow/scripts/run.py cad-render/scripts/render.py hw [--version latest|vN] [--views ...] [--size WxH] [--subject S] [--replace] [--out-dir .cad-work/...]`
   -> immutable `hw/renders/<vN>/<subject>/` bundles with requested PNGs, `render.json`, and `manifest.json`.
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
4. Read every PNG before describing it. Name the material each PN shows from
   `render.json` `materials.<PN>` (`rule`, `label`, `applied`).
5. Gate: put each PNG's absolute path in the gate report, one per line, with one line on what the image shows. Absolute paths are clickable in the terminal; a path relative to `hw/` is not.

Exit codes: 0 every view is usable (pass or warning, including cache hits); 1 an unusable view remains
after its retry ladder, with PNGs and a `status: fail` render.json still written; 2 usage or
infrastructure error (nothing written).

| Finding | Classification | Meaning and action |
|---|---|---|
| `BLANK` | unusable | subject under 0.5% of frame or nothing but backdrop; retry once on fixed views, use the close-up ladder before failing |
| `CLIPPED` | unusable | a subject pixel touches the frame edge; reframe; close-ups continue through the camera/ghost/isolated ladder |
| `OCCLUDED` | unusable close-up | less than 25% of isolated subject pixels remain visible; retry alternate camera angles, ghost context, then isolated fallback |
| `NO_SHADOW` | warning | shadow below threshold; keep PNG and report warning |
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

## Rules

MUST Treat exit 1 as a failed render for the batch; report unusable findings and metrics verbatim.
MUST Keep warning-only renders; report warning, retry strategy, and each requested view's absolute PNG path.
MUST Install the headless browser once per machine: `uv run --with playwright==1.64.1 playwright install chromium`. The manifest's `renderer.playwright` is the installed version.
DEFAULT Default views are iso, front, side, and exploded at 1600x1200; `--size WxH` overrides.
NOT Render L0 concept variants here; `cad-concept` owns them.
NOT Hand-edit `hw/renders/`; it is derived and replaced whole on every miss.
NOT Install Blender for this skill; a Cycles hero-shot route is a future option, not installed.

```text
L1 RENDER vN: PASS|FAIL|CACHE HIT, {views} views, {wall s}
   Failures -- {view, failure, and metric, only if any}
   Renders -- {absolute PNG path and one line each on what it shows}
```
CAP 80w clean · 160w with failures
