---
name: cad-render
description: Renders each cad-model version into PBR product PNGs (iso, front, side, exploded, close-ups) for stage gates. Triggers on "render v3", "show me the renders".
---

# CAD Product Render

Stages L1 LAYOUT to L4 ANALYSIS: every commit batch renders its version after `cad-model run`,
and every stage gate shows the renders. L0 CONCEPT is excluded; it stays on `cad-concept`.
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
2. Render: `uv run --script scripts/render.py hw [--version latest|vN] [--views iso front side exploded closeup-<PN>]`
   -> `hw/renders/<vN>/<view>.png` and `manifest.json` (version, camera per view, material
   applied per PN, three and Chromium versions, wall times); JSON summary on stdout.
3. Close-ups: add `closeup-<PN>` for each part the batch changed.
4. Read every PNG before describing it. Name the material each PN shows from
   `manifest.json` `materials.<PN>` (`rule`, `label`, `applied`).
5. Gate: put the PNG paths in the gate report, one line each on what the image shows.

Exit codes: 0 every view passed, or a cache hit; 1 a quality failure, with renders and a
`status: fail` manifest still written; 2 usage or infrastructure error, nothing written.

| `quality.failures` entry | Meaning | Fix |
|---|---|---|
| `BLANK` | subject under 0.5 % of the frame, or nothing but backdrop | GLB empty or a WebGL failure; rerun with `--force`, then report |
| `CLIPPED` | a subject pixel touches the frame edge | report the view; framing is automatic |
| `NO_SHADOW` | shadow area under 4 % of product area, or under 22 luminance levels deep; a `closeup-<PN>` view needs only the 4 % area at 10 levels, since it may frame just a part high above the floor | report the view; check the ground part sits at the GLB minimum |
| `INVERTED_SHADOW` | the floor 3 to 10 px below a part standing on the floor is no darker (median) than the shadow core under a part high above it | report the view; the floor shadow must darken towards contact |

The floor shows only a baked studio shadow: a dark contact shadow at the foot of every part on
the floor, plus a wide, faint softbox shadow whose penumbra grows and darkness falls with a
part's height. The key light shades the parts onto each other, never the floor.

The cache key is the GLB, `part-map.json`, `assembly.yaml`, the resolved material per PN, and
the renderer files. A rerun with the same key and intact PNGs prints `"cache": "hit"`.

## Rules

MUST Map a new `part.yaml` material or finish in `assets/materials.json` before rendering; `rule: unmapped` renders neutral grey.
MUST Treat exit 1 as a failed render for the batch; report each view's `failures` and numbers verbatim.
MUST Run once with network access to fill the pinned three.js cache (`~/.cache/cad-concept/vendor`, SRI-checked); later runs are offline.
DEFAULT Default views are iso, front, side, and exploded at 1600x1200; `--size WxH` overrides.
NOT Render L0 concept variants here; `cad-concept` owns them.
NOT Hand-edit `hw/renders/`; it is derived and replaced whole on every miss.
NOT Install Blender for this skill; a Cycles hero-shot route is a future option, not installed.

OUTPUT
L1 RENDER vN: PASS|FAIL|CACHE HIT, <views> views, <wall s>
   Failures -- view, failure, and metric, only if any
   Renders -- PNG path and one line each on what it shows
CAP 80w clean · 160w with failures
