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

## F2 process wall check

`form_check.py --fidelity F2` measures each made part's minimum wall against its
process minimum: FDM 1.2 mm (three 0.4 mm perimeters) unless `hw/product.yaml`
`manufacturing.min_wall_mm` sets `fdm` or `cnc`, each above 0 mm. An invalid override
stops the check with exit 2. Purchased parts, `make_buy: buy` parts, and a process with
no minimum (CNC without an override) are not scanned; their `min_wall` is
`{"required_mm": null}`.

- Samples: each face gets a uniform UV grid, at most half the minimum apart in both
  directions where the surface stretches most, and at most 4096 per face
  (`capped_faces` counts the faces sampled coarser). The grid spans the face's full UV
  range, so a bore's seam does not decide where samples land. Samples within four B-rep
  tolerances (at least 0.1 µm) of a trim boundary are skipped; a seam is no boundary.
- Chord: each sample casts a ray along its inward normal to the first exit. The exit
  counts only when an exit face's normal is within 20° of antiparallel, so two faces
  meeting at an acute edge never read as a wall. `tapered` counts the samples whose exit
  did not, so a part whose thinnest region is a taper shows low coverage.
- Persistence: a chord below the minimum counts only when the wall continues at least
  its own thickness. Along both UV directions, on either side, the face's own sample a
  chord length away must leave through the same exit face, at any thickness up to twice
  the minimum, or through another opposing face below the minimum. So a bore web
  thinnest at one spot still counts. Where that point leaves the face, a ray parallel to
  the chord stands in. Relief, such as the lands between engraved letters, ends at its
  own edge and is counted in `shallow`, with the thinnest such chord in
  `shallow_thickness_mm` and `shallow_location_mm`.
- Report: `thickness_mm` and `location_mm` (the sample point), `faces`,
  `faces_sampled`, `samples`, `measured`, `tapered`, `shallow`, `capped_faces`,
  `spacing_mm` and `seconds`. A ray stops at the running minimum, so `measured` also
  counts samples that bound the wall at or above it, and `tapered` and `shallow` count
  only exits shorter than it. A part with no measured wall is a `min_wall_unmeasured`
  finding, never a pass.

Limits: the minimum is sampled, not certified. A curved wall reads slightly thick (a
0.8 mm web beside a Ø10 bore reads 0.81 mm), a thin region smaller than a capped face's
spacing can be missed, and a taper whose faces are more than 20° from antiparallel is
not measured; its samples show in `tapered`. Measuring a taper by the shortest distance
to the face it exits through would also read every acute edge and chamfered edge as a
thin wall. The kernel tolerance is 1e-7 mm and rays start 1e-5 mm inside the face.

`block_like` applies only to `form_class: solid` in `part.yaml`; absent means `solid`.
Frame, plate, skeleton, and shell are exempt. Solid parts retain the existing OBB tests:
the face-area rule, minimum 0.20 OBB fill, and shortest OBB extent above 0.10 of the
second-shortest extent.

## Self-check: block-like parts

`scripts/form_check.py` flags `block_like` from F2 when either face condition is met
and both OBB exemption tests pass:

1. At least 80% of face area is planar and normal to a principal axis, or the part has
   no recognized blend or freeform faces.
2. The solid material occupies at least 20% of the oriented bounding-box volume.
3. The shortest OBB extent exceeds 10% of the second-shortest extent.

These measures catch solid placeholder blocks while exempting thin open frames and
sheet-like parts.

Before the gate, also answer each of these by looking at a render, not at the code:

- Does any made part still read as its F0 primitive from three sides?
- Does the outline change section between joints, or is it a constant-section bar?
- Is every exterior edge blended at one radius family, with bores chamfered?
- Does each pocket, rib, or channel have a structural or routing reason?
- Do purchased parts show their bought form (head, socket, groove), not a bare cylinder?

Answer "yes" to the first question, or "no" to any of the others, and the part stays in the
current stage.
