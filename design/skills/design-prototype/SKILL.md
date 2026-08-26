---
name: design-prototype
description: Routes a wireframe, mockup, prototype, or deck request to the right artifact producer. Triggers on wireframe this or make a prototype.
---

# Design Prototype

Phase SPECIFY. Produce a throwaway artifact that answers a layout or flow question
before anything real is built.

TRIGGER
+ "wireframe this", "make a prototype", "show me a mockup"
+ "what should this look like" asked before any implementation exists
- implementing a real surface against the system -> `ui-ux-specialist`
- verifying a surface that already renders -> `ui-review`
- recording the durable visual system -> `design-md`

## Workflow

1. Pick the route from the fidelity table below, then check that name is in your available
   skills BEFORE loading it. Reading a `skill://` path that does not exist throws
   `Unknown skill`. -> present: LOAD and follow. Absent: STOP, emit the install command
   from `skill://design-prototype/references/upstream.md`, and run it. Do not silently
   drop to a lower-fidelity route: the artifact would answer a different question than
   the one asked.
2. Produce exactly one artifact on that route. -> the artifact opens or renders, and
   its path is reported.
3. State what the artifact does not answer. -> a named gap list, because a
   low-fidelity artifact settles layout and flow, never final visual detail.

| need | route |
|---|---|
| low-fidelity layout, one self-contained file | upstream `html-wireframe` |
| wireframe inside a Markdown doc, git-diffable | `skill://wireloom`, vendored here, always available |
| clickable multi-screen flow with keyboard support | upstream `html-prototype` |
| vector wireframe as SVG, PNG, or PDF | the `wire-dsl` MCP server, which ships declared in this package |
| raster visual concept | `xd://generate_image`; reference images go in `input` |
| fixed 16:9 deck or PDF | upstream `frontend-slides` |
| flow or architecture sketch | the `excalidraw` MCP server, from the `diagram` package |
| favicon, app icon, or social image files | upstream `web-asset-generator` |
| hosted concept exploration | upstream `superdesign`, after the user confirms the account |
| rendered surface against a reference mockup | `tab.screenshot()` then `inspect_image` with an explicit comparison question |

## Rules

MUST Prefer the local account-free route before any hosted service.
MUST State which route produced an artifact. A reader cannot judge fidelity without it.
MUST Report an `inspect_image` comparison as a vision judgement. OMP has no
  pixel-diff primitive, so the result carries no measured claim.
DEFAULT One artifact per question. A second fidelity level is a second request.
NOT Present a generated image as an implementation plan.
NOT Take a hosted route before the user confirms the account it needs.

## Output

L1 ARTIFACT: path, plus the route that produced it.
   Answers -- the layout or flow question it settles.
   Open -- what it does not answer.
CAP 100w
