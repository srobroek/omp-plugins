# Fidelity ladder and detailing rules

Load at every L1 LAYOUT, L2 PARTS, or L3 DETAIL commit batch, and before any stage gate
from L2 PARTS onward.

## Ladder

| Level | Adds | Typical features |
|---|---|---|
| F0 massing | Envelopes and joint frames only | Boxes, cylinders, concept primitives; L0 CONCEPT and L1 LAYOUT |
| F1 functional | Real interfaces | Pin bores at the `cad-fits` class, bosses, mating faces, process wall thickness, ISO 273 fastener clearance, counterbores sized to ISO 4762 heads (dk + 1 mm, k + 0.5 mm) |
| F2 form | Product form language | Tapered, lofted, or swept links instead of boxes; one exterior fillet radius family per part; bore-entry chamfers; ribs or pockets for stiffness and mass; cable channel; base ballast cavity; revolved shade |
| F3 detail | Cosmetic and finishing detail | Engraved or embossed text, knurl or grip flutes, split lines, purchased parts as bought (real heads, sockets, retaining-ring grooves), warehouse fasteners in the assembly |

A level includes everything below it. Record the level a part reached in its commit-batch
note; a part whose interfaces change drops back to F1 until the new interface is re-detailed.

## Gate minimums

| Stage gate | Every made part | Purchased parts |
|---|---|---|
| VARIANT gate | F0 | not modelled |
| LAYOUT freeze | F0 envelope, joint origins and axes from `assembly.yaml` | envelope |
| L2 PARTS gate | F2, `form_check.py --fidelity F2` exit 0 | F1: real shank, head envelope |
| L3 DETAIL gate | F3, `form_check.py --fidelity F3` exit 0 | F3 as bought |
| BOM onward | no regression below F3 | no regression |

## Form language

- Derive a link's outline from two views (plan and side) and intersect them; taper toward
  the lighter end and sag or waist the span between the joints.
- Keep the kinks of the two outlines at different stations: coincident kinks make the
  silhouette fillet fail in OCCT.
- Keep each outline tangent-continuous wherever a silhouette fillet runs: leave a round on
  a tangent and blend every shallow kink between straight runs (40 mm on the links). A
  fillet rolled across a 2-5 degree kink leaves edges 0.03-0.14 mm out of tolerance, and
  the STEP read-back volume then drifts by ~1e-5: a blocking cad-model `step_readback`.
- Fillet every silhouette edge with one radius per part; leave tangent seams unfilleted.
- Put axisymmetric form (puck, boss, shade, cap, socket) into one revolved profile, with
  fillets and chamfers drawn as profile arcs and lines.
- Run cable channels along the underside, stop them with the cutter's own end form.
- Give two bores that meet in a T different radii. With equal radii the intersection
  curves cross at two singular points, and CadQuery 2.8 left an unorientable face there.

## FDM detailing (PETG, 0.4 mm nozzle)

| Feature | Rule |
|---|---|
| Exterior edges | Fillet >= 1 mm; bed-face edges get a 0.5-1 mm 45-degree chamfer, never a fillet |
| Walls | Multiples of the line width; 2.4 mm (six perimeters) for shells, 3 mm for bosses |
| Overhangs | <= 45 degrees from vertical; bridges <= 20 mm; give cavity roofs 45-degree flanks |
| Holes | Model at the `cad-fits` hole limit plus a 0.2 mm diametral allowance below 10 mm; vertical holes preferred |
| Threads | Thread-forming bore for M10x1 nipples and M3-M5 screws; heat-set inserts for repeated assembly |
| Detail | Text, flutes, and grooves >= 2 line widths (0.8 mm) wide, >= 0.6 mm deep; exempt from the edge fillet rule |

## CNC detailing (6061-T6, 3-axis)

| Feature | Rule |
|---|---|
| Internal vertical corners | Radius >= tool radius (default 1 mm; pockets here use 3-4 mm) |
| Pockets | Floor web >= 3 mm; depth <= 4 x tool diameter; stadium ends at the tool radius |
| Clevis slots | Open-ended; slot end radius = slot width / 2; slot depth clears the mating link through its full joint range |
| Pin bores | Use H7 for declared 5 H7/p6 press-fit holders and the declared `cad-fits` class for running bores; 0.5 mm 45-degree entry chamfers |
| Exterior edges | 1-1.5 mm fillets on silhouettes; break remaining edges 0.2-0.5 mm by drawing note, not in the model |
| Channels | Ball-end cut: full-radius floor and spherical ends |

## Self-check: block-like parts

`scripts/form_check.py` flags `block_like` from F2 when either holds for a made part:

1. >= 80 % of the surface area lies on planar faces normal to X, Y, or Z.
2. No fillet face (convex cylinder or torus, radius <= 10 mm, turning <= 120 degrees) and no
   freeform face (B-spline, loft, sweep, revolution).

Before the gate, also answer each of these by looking at a render, not at the code:

- Does any made part still read as its F0 primitive from three sides?
- Does the outline change section between joints, or is it a constant-section bar?
- Is every exterior edge blended at one radius family, with bores chamfered?
- Does each pocket, rib, or channel have a structural or routing reason?
- Do purchased parts show their bought form (head, socket, groove), not a bare cylinder?

Answer "yes" to the first question, or "no" to any of the others, and the part stays in the
current stage.
