---
name: cad-concept
description: Iterates 2-4 rough three.js concept variants in a live viewer, then exports the chosen one for CAD. Triggers on "sketch some concepts", "pick a variant".
---

# CAD Concept (L0)

Stage L0 CONCEPT of `skill://cad-flow`: rough primitive variants the user compares, poses,
refines, merges, or drops until the VARIANT gate, then a handoff manifest for L1 LAYOUT.
Paths below are relative to this skill's directory, `skill://cad-concept/`.

TRIGGER
+ "sketch some concepts", "show me a few options", "compare variants", "pick a variant"
+ `hw/product.yaml` has `flow.stage: concept`
- envelopes, interfaces, or a BOM skeleton -> L1 LAYOUT in `skill://cad-flow`
- real geometry in CadQuery or build123d -> L2 PARTS in `skill://cad-flow`

GATES
ASK which live variant passes the VARIANT gate; record nothing as chosen until the user names it.

## Workflow

1. Read `hw/product.yaml` and `hw/requirements.yaml`, then LOAD `references/scene-format.md`.
2. DRAFT 2-4 variants in `hw/concept/<product-id>.scene.json`, each a different answer to
   the main trade-off, with that trade-off in `params` and one-line `summary`.
3. Run `uv run --script scripts/concept.py check <scene>` after every edit. -> exit 0, `"ok": true`.
4. Start the preview once as a long-running process:
   `uv run --script scripts/serve.py --scene-dir hw/concept --port 8765`. -> first stdout
   line is `{"url": ...}`; send the user that URL. Each saved edit reloads the open viewer.
5. Collect feedback. Drive the viewer yourself when the harness has a browser; otherwise
   ask the user to pose it and press Save screenshot. -> the PNG plus pose JSON land in
   `hw/concept/screenshots/`; read both.
6. Apply each request as one operation from the table, then re-run step 3.
7. On "commit batch": run step 3 and save one screenshot per live variant. No other checks
   run before LAYOUT freeze. Hand the batch to `skill://cad-flow` for COMMIT.
8. "More detail?" -> back to step 5. Otherwise ASK the VARIANT gate, set `chosen`, and run
   `uv run --script scripts/concept.py handoff <scene> --out hw/concept/handoff.json`.
   -> exit 0 means the manifest passed `assets/schemas/handoff.schema.json`.
9. Stop the server. Report the handoff path to `skill://cad-flow`, which opens L1 LAYOUT.

| user says | operation |
|---|---|
| "make B taller", "try a 300 mm reach" | REFINE: edit that variant in place; ids unchanged |
| "B with A's base" | MERGE: edit B, then move A to `retired` with `merged`, `into: B`, reason |
| "drop C" | DROP: move C to `retired` with `dropped` and the user's reason |
| "one more option" | ADD: a new variant; at most 4 stay live |

## Rules

MUST Keep node ids stable across edits and variants: the same concept part carries the same id everywhere. The handoff and L1 key on them.
MUST Retire a variant into `retired` with a reason; never delete it.
MUST Fix every `concept.py check` error before pointing the user at the viewer.
DEFAULT One scene file per product; joint limits from the requirements, else the user's numbers.
NOT Model fits, fasteners, fillets, or tolerances here; that is L3 DETAIL.
NOT Export a handoff before the user names the chosen variant.

The viewer pins three@0.186.1 by import map with SRI digests. `serve.py` needs network on
first load, then serves the verified modules from `~/.cache/cad-concept/vendor`
(`$XDG_CACHE_HOME` when set) offline.

OUTPUT
L1 CONCEPT: <scene path> -- <live variant count> live, <retired count> retired, gate PENDING|PASSED <chosen id>
   Viewer -- URL while serving, or STOPPED
   Handoff -- path and node/joint counts, only after the gate
CAP 80w
