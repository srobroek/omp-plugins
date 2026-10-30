---
name: cad-design
description: Grows CAD parts from massing blocks to realistic products through fidelity levels F0-F3, rendered every batch. Triggers on "make it look real", "detail the parts".
---

# CAD Design Fidelity

Stages L1 LAYOUT to L3 DETAIL of `skill://cad-flow`: how far each part's form must have grown
before a gate, and how to check that it no longer reads as a block.
Paths below are relative to this skill's directory, `skill://cad-design/`.

TRIGGER
+ "make it look like a real product", "these parts are just blocks", "detail the parts"
+ an L1, L2, or L3 commit batch, or an L2 PARTS or L3 DETAIL gate in `skill://cad-flow`
- fit classes, limits, or stack-ups -> `skill://cad-fits`
- joint posing, sweeps, or collisions -> `skill://cad-motion`
- L0 concept variants -> `skill://cad-concept`

## Workflow

1. LOAD `references/fidelity.md`. Read each part's `material` and `process` from
   `hw/parts/<PN>/part.yaml` and the joints from `hw/assembly.yaml`.
2. Write or grow `hw/parts/<PN>/model.py` to the stage's level: F0 at L1 LAYOUT, F1 then F2
   during L2 PARTS, F3 during L3 DETAIL. Follow the model.py contract: one `KERNEL`, a JSON
   `PARAMS` dict in mm and degrees, `build(params)` returning one part in place at the zero pose.
3. Start by using the skill's own references: read `references/fidelity.md`, the model.py contract, and the fidelity ladder. Extract the applicable shape and detail decisions from the part's requirements, interfaces, joints, material, and process; do not assume a reference model belongs to an installed skill.
   Checkout users may optionally read `cad/examples/lamp-arm/reference/` as a worked example; it is not a runtime dependency.
4. On "commit batch", use cad-render to review the built version. The lamp reference aid writes temporary CAD files to the output directory you provide. Run `build_reference.py --kernel cadquery|build123d --out DIR` or `review_render.py --out DIR`. Never set a hardware project as `DIR`.
5. Export one STEP per part in the temporary build output, then run `uv run --script skill://cad-flow/scripts/run.py cad-design/scripts/form_check.py --hw hw --parts-dir DIR --fidelity F2|F3`. JSON reports per-part validity, area shares, blends and joint-bore offsets; exit 0 means no findings, 1 means findings, and 2 means usage error. When DIR contains `build.json`, form_check also compares in-memory checks with STEP read-back.
6. Walk the render self-check questions in `references/fidelity.md` against the renders. A part that fails stays in the stage; report the level it reached.

## Rules

MUST Reach F2 on every made part before the L2 PARTS gate and F3 before the L3 DETAIL gate.
MUST Treat `form_check.py` exit 1 as a gate blocker; `block_like` is never waived by a render.
MUST Put every joint bore on its `assembly.yaml` origin and axis (form_check tolerance 0.05 mm).
MUST Size bores from `skill://cad-fits` output and counterbores from ISO 4762 head sizes, never from memory.
DEFAULT Model CadQuery fastener heads natively; `cq_warehouse` is not on PyPI. bd_warehouse 0.4.0 serves build123d.
NOT Call a part detailed from code alone; a render, read back, is the evidence.
NOT Treat a render as a check result; it is review material for the user.

```text
L1 DESIGN {stage}: {PN count} parts at {lowest level}, form_check PASS|FAIL
   Findings -- {check, part, and value per form_check finding, only if any}
   Renders -- {absolute PNG paths and one line each on what they show}
```
CAP 80w clean · 160w with findings
