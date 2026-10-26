---
name: cad-viewer
description: Shows cad-model versions in OCP CAD Viewer with a parts, findings, and measurements panel. Triggers on "show v3", "compare v2 and v3", "animate J-002".
---

# CAD Viewer

Stages L1 LAYOUT to L5 RELEASE of `skill://cad-flow`: the live CAD view after every build, the
review surface at each gate, and the screenshots a gate or the user reads. L0 CONCEPT stays in
`skill://cad-concept`. Paths below are relative to this skill's directory, `skill://cad-viewer/`.

TRIGGER
+ "show the model", "show v3", "open the viewer", "keep the viewer on the latest build"
+ "compare v2 and v3", "side by side", "isolate the lower link", "ghost the rest"
+ "explode it", "section through the elbow pin", "animate J-002", "screenshot the iso view"
+ "look-dev", "studio lighting" for interactive renders
- L0 concept variants -> `skill://cad-concept`
- building, checking, or diffing a version -> `skill://cad-model`
- joint sweeps, collisions, worst-case pose -> `skill://cad-motion`

## Workflow

Run every command as `uv run --script scripts/viewer.py <command>`; each prints one JSON object.

1. `serve` -> starts or reuses the host: OCP viewers A and B, once for the user's tab and once
   for a headless presenter page that captures read, plus the panel page. Prints `url` (send it
   to the user), `pid`, `ports`, and the `stop` command.
2. After each cad-model `run` and `check --out FILE`: `show hw [--version vN] --check FILE`.
   The first push fits the camera; later pushes keep it. The panel lists parts and groups
   (Hide, Iso, Ghost rest), per-part findings from the check JSON, and metrics.json numbers.
3. At a gate or for "what changed": `compare vA vB --hw hw --check-a FA --check-b FB` -> A and
   B side by side, cameras synced both ways. `mode single --active A|B` flips one viewer.
4. `parts hide|iso|ghost|reset [PN|subassembly]` does what the panel buttons do.
5. `animate --joint J-00x --from V --to V [--at 0..1]` -> keyframes from cad-motion's chain.
   A value outside the joint's assembly.yaml [min, max] exits 1 with `joint_limit` findings
   and pushes nothing. `--at` holds one pose for a capture.
6. `capture --view V --out PNG [--crop page|viewer|canvas]` -> V is iso, front, side, top,
   exploded, `isolate:<PN|group>`, `section --joint J-00x` (plane along the joint axis), or
   current (the state as left, no refit). `current` takes the user's camera when their tab is
   open (`camera_from: user`). Every view but section and current is refitted, and the user's
   view follows the refit: `frames.a.in_frame` true and `fill` near 0.84 mean the whole
   product is in frame. -> read every PNG before describing it.
7. `stop` -> stops the host, its viewers, and the presenter; reports `ports_free`.

| command output | meaning |
|---|---|
| `capture` `status: fail` | a blank canvas; the PNG is not evidence |
| `capture` `in_frame: false` | the product touches the frame edge; retake or say so |
| `cameras` | position, quaternion, target, zoom per viewer after the capture |

## Studio look-dev

Realistic renders per commit batch come from the three.js PBR renderer (`skill://cad-render`);
Studio mode is the interactive route. `studio --environment studio --tone-mapping ACES
--exposure 1.0 [--env-intensity] [--env-rotation] [--background] [--shadow-intensity]
[--shadow-softness] [--ao-intensity] [--texture-mapping]` switches both viewer pairs to the
Studio tab, and `capture --view current` records it. Settings the user changes by hand in their
tab stay in their tab: only `studio` flags reach captures. The next push returns the viewer to
the Tree tab.

## Rules

MUST Read the PNG before any claim about a view; a pass status only says the canvas is not blank.
MUST Run `stop` when the session ends and report its `ports_free`.
DEFAULT One host per user (session file `$CAD_VIEWER_SESSION`, else `~/.local/state/cad-viewer/session.json`).
NOT Use ocp_viewer `save_screenshot`: headless it returns a black frame. Captures are browser screenshots.
NOT Treat the viewer, a render, or a capture as a check result; `skill://cad-model` `check` is the gate.

## Limits

- Headless WebGL is SwiftShader in Playwright Chromium: correct pixels, slow frames (seconds per capture).
- Colours are cad-render's `assets/materials.json` rule for part.yaml `material` and `finish`
  (`skill://cad-render`); an unmapped material shows the table's neutral default.
- OCP CAD Viewer does not replay a model to a newly opened page, and serves only the last page that
  connected: the user's tab and the presenter each have their own viewers, and the panel asks the
  host to push again on each viewer load, which restores the camera and a held animation pose.
- Cylindrical bores come from metrics.json `parts.<PN>.holes` (diameter, through or blind, depth). The
  list includes every concave full-circle cylinder, so recesses and cavities appear beside drilled
  holes; a missing or empty field shows "no cylindrical bores".

OUTPUT
L1 VIEWER <SERVE|SHOW|COMPARE|ANIMATE|CAPTURE|STOP>: <PASS|FAIL>, <version(s)>, <url or PNG>
   Findings -- per-part check findings shown, only if any
   Captures -- PNG path, view, in_frame, and one line on what the PNG shows
CAP 80w clean · 160w with findings
