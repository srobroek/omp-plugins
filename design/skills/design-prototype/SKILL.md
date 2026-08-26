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

1. Pick the route from the fidelity table below, then resolve it by KIND, because the rows
   are not all skills.
   - An UPSTREAM SKILL row: check the name is in your available skills before loading it,
     since reading a `skill://` path that does not exist throws `Unknown skill`. Present:
     LOAD and follow. Absent: STOP. Report the gap, name the install command from
     `skill://design-prototype/references/upstream.md`, and ASK the user to run it; an
     install applies only from the NEXT session. Do NOT take a different row instead: each
     row answers a different question, and a substituted fidelity reads like the real one.
   - An MCP SERVER row: check the tool is in your available tools. MCP connects only at
     session startup, so a declared server is not a connected one. Absent: STOP and say so,
     naming `/mcp reconnect <name>` as the user's move. Do NOT drop to another row.
   - A BUILT-IN row such as `xd://generate_image`: check the tool is present, and STOP and
     say so if it is not, rather than substituting a different fidelity.
   -> the chosen route and its kind are both named before any file is written.
2. Produce exactly one artifact on that route. -> the artifact opens or renders, and its
   path is reported.
3. SERVE it whenever it is interactive, rather than handing over a file path. A clickable
   prototype judged by reading its source is not judged at all.
   -> `hub` op `start`, name `prototype`, `python3 -m http.server <port> --bind 127.0.0.1`
   with `cwd` set to the artifact's directory, and `ready = { "port": <port> }`.
   -> SELF-CHECK before reporting, because this is the step that silently does not happen:
   fetch your own URL and report the status, `curl -s -o /dev/null -w '%{http_code}'
   "http://127.0.0.1:<port>/<file>"`. A 200 is the only proof it ran. With no status line,
   report NOT SERVED plus the blocker, the absolute file path, and the one-line command a
   human runs from that directory. Never report a URL you did not fetch.
   -> Then drive it yourself with `skill://ui-review` at 1440, 768, and 375 before claiming
   the flow works. An SVG or a single HTML file serves the same way.
   -> Leave the server running when you report. Stopping it strands the artifact.
4. State what the artifact does not answer. -> a named gap list, because a low-fidelity
   artifact settles layout and flow, never final visual detail.

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
MUST Report the measured HTTP status beside any URL you hand over. A URL with no status
  behind it is exactly the failure the self-check exists to catch.
DEFAULT One artifact per question. A second fidelity level is a second request.
NOT Present a generated image as an implementation plan.
NOT Take a hosted route before the user confirms the account it needs.

## Output

L1 ARTIFACT: path, plus the route that produced it.
   Served -- the URL and the HTTP status you measured, or NOT SERVED plus the blocker,
   the absolute path, and the command to serve it.
   Answers -- the layout or flow question it settles.
   Open -- what it does not answer.
CAP 100w
