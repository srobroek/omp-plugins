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
+ "show me the previews", "open the gallery", "where are the renders"
+ "compare v2 and v3", "side by side", "isolate the lower link", "ghost the rest"
+ "explode it", "section through the elbow pin", "animate J-002", "screenshot the iso view"
+ "look-dev", "studio lighting" for interactive renders
- L0 concept variants -> `skill://cad-concept`
- building, checking, or diffing a version -> `skill://cad-model`
- joint sweeps, collisions, worst-case pose -> `skill://cad-motion`

## Workflow

Run viewer commands through cad-flow's shared environment:
`uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py <command> [args...]`.
Once per machine, install the headless browser captures use:
`uv run --with playwright==1.64.1 playwright install chromium`.

Session identity:
- OMP and Claude Code expose session IDs. OpenCode and Kiro do not have a verified shell ID.
  For them, set `CAD_VIEWER_SESSION_NAME` or pass `--session NAME`, using a session ID or worker name.
- Reuse the name for each command. Different names in one project get separate hosts.
- The project root contains `hw/`. Commands with `hw/` derive it from that path; other commands use cwd.
- Run `serve` from the project root unless you name the session. `CAD_VIEWER_SESSION` still overrides
  the session-file path.
1. `serve [--session NAME] [--idle-timeout MIN]` starts or reuses this session's host.
   The host runs the user and presenter OCP viewer pairs and the panel.
   The timeout defaults to 30 minutes. Pass `0` to disable it.
   Viewer commands and user-panel requests reset the clock. The Referer separates user and presenter polls.
   Output shows the `url`, `pid`, `ports`, timeout, and stop command.
2. After each cad-model `run` and `check --out FILE`: `show hw [--version vN|latest] --check FILE`.
   The first push fits the camera; later pushes keep it. The panel lists parts and groups
   (Hide, Iso, Ghost rest), per-part findings from the check JSON, and metrics.json numbers.
   `--version latest`, the default, makes A follow `hw/versions/latest.json`, which the host
   checks every 0.5 s: a new build loads and the open tab updates without a reload. A `vN` pins A.
3. At a gate or for "what changed": `compare vA vB --hw hw --check-a FA --check-b FB` -> A and
   B side by side, cameras synced both ways. Either side may be `latest`. `mode single --active A|B`
   flips one viewer.
   The panel's Versions section shows a labeled select for each shown version (A, plus B side by side).
   It lists `latest (vN)`, then every `hw/versions/vN` newest first with build time and part count.
   Picking one loads it into that slot and keeps the camera and view state. `show` and `compare`
   update the selects. When a version cannot load, such as a missing part STEP, the error shows
   under its select and the slot keeps its model. Command output reports `versions.<A|B>.selected`
   (`latest` or vN) beside `label`, and `latest` (the vN latest.json names).
4. `parts hide|iso|ghost|reset [PN|subassembly]` does what the panel buttons do.
5. `animate --joint J-00x --from V --to V [--at 0..1]` -> keyframes from cad-motion's chain.
   A value outside the joint's assembly.yaml [min, max], or one that puts a coupled joint outside
   its limits, exits 1 with `joint_limit` findings and pushes nothing. `--at` holds one pose for a
   capture. Animate independent joints only: coupled joints follow their driver at every keyframe,
   and naming a coupled joint exits 2 with its driver.
   `animate --case C [--at 0..1]` plays a cad-motion motion plan instead: case `default` (generated
   from the shown version's record snapshot) or `hw/motion/cases/<C>/plan.yaml`, one key per plan
   frame at its fps, every driver the plan moves at once. Use it for coupled and multi-pivot records.
   A frame outside a joint's limits exits 1; a coverage gap still plays and `coverage` reports it.
6. `capture --view V [--out .cad-work/unit/.../capture.png] [--replace]` -> V is iso, front, side, top,
   exploded, `isolate:<PN|group>`, `section --joint J-00x` (plane along the joint axis), or current
   (the state as left, no refit). By default captures publish an immutable `bundle.captures` at
   `hw/captures/<vN>/<subject>/`; `--out` is accepted only under `.cad-work/` and an existing file
   is never overwritten. `--replace` retains a conflicting prior bundle. `capture.json` records the
   displayed version, view and viewer state; the recipe binds view, state and viewport size.
   `current` takes the user's camera when their tab is open (`camera_from: user`). Every view but section
   and current is refitted, and the user's view follows the refit: `frames.a.in_frame` true and `fill`
   near 0.84 mean the whole product is in frame. While a capture runs, every other command or panel
   button that would change the view is refused with `capture in progress`; retry it after. Read every PNG.
7. `gallery hw [--version vN]` -> opens the record in the preview gallery. Prints `url`
   (`http://127.0.0.1:<panel port>/gallery?version=vN`) and, under `files`, the absolute path of
   each listed file. `show` and `compare` also open their record and print a `gallery` URL per
   version. Give the user the URL and the absolute paths.
8. `stop [--session NAME]` -> stops only this session's host, its viewers, and presenter; reports
   `ports_free`. Run the exact `stop` command printed by `serve` when the viewer is no longer
   needed at the end of the review/stage and before handoff. Tell the user the URL that is going
   away. The 30-minute idle timeout is a fallback; an open tab does not keep the host alive.

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

## Preview gallery

The host serves a read-only gallery at `/gallery` beside the panel, on the same origin and
behind the same Host and Origin checks. Pick a version from the bar. Each tile shows its image,
its absolute path with a Copy path button, and opens full size in a new tab. The bar also links
to the live 3D viewer.

| section | source | caption |
|---|---|---|
| Renders | `hw/renders/<vN>/<subject>/{render.json,*.png,manifest.json}` (`skill://cad-render`) | view quality, retry strategy, and material/input decisions from render.json |
| Viewer captures | `hw/captures/<vN>/<subject>/{capture.json,<view>.png,manifest.json}` | captured view and state bound to one version |
| Drawings | `hw/drawings/<vN>/<subject>/{package.json,sheet-1.png,sheet-1.pdf,manifest.json}` | status, scale, projection and Open PDF with its absolute path |
| Concept screenshots | `hw/concept/screenshots/` (`skill://cad-concept`) | scene and variant |

The version picker uses built labels from cad-record layout. Each option includes the build date and part
count, plus counts of valid render sets, capture bundles and drawing preview bundles; choose Gallery to
see the actual images. The file route serves only PNG, JPEG, and PDF files inside the open `hw/`.

## Rules

MUST Read the PNG before any claim about a view; a pass status only says the canvas is not blank.
MUST Run the exact `stop` command printed by `serve` when the user is done with the viewer (end of
  review/stage, before handoff), and tell the user the URL that is going away.
DEFAULT One host per project and session: session files under the state directory are keyed by a
  harness session ID or `CAD_VIEWER_SESSION_NAME` / `--session NAME`, plus the project root.
NOT Use ocp_viewer `save_screenshot`: headless it returns a black frame. Captures are browser screenshots.
NOT Expose the host beyond loopback: it answers only `Host` 127.0.0.1 or localhost on its port,
  refuses another site's `Origin` (403) and a non-JSON POST (415), and writes a capture only as
  a `.png` into a folder that already exists.
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

```text
L1 VIEWER {SERVE|SHOW|COMPARE|ANIMATE|CAPTURE|GALLERY|STOP}: {PASS|FAIL}, {version(s)}, {url or PNG}
   Findings -- {per-part check findings shown, only if any}
   Captures -- {absolute PNG path, view, in_frame, and one line on what the PNG shows}
   Gallery -- {gallery URL, then each listed file's absolute path, only for GALLERY}
```
CAP 80w clean · 160w with findings
