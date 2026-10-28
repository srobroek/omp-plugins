# Drawing intent and feature kinds

`part.yaml` `drawing` (schema: cad-record `schemas/drawing.schema.json#/$defs/part_drawing`) and the
model's `drawing_features` locators together define a part drawing. Locators identify faces;
part.yaml states intent; every value is measured from the STEP.

## Locators (`model.py` `drawing_features`)

Return semantic ID → `{kind, frame: assembly_zero, patches, anchors?, relations?}`. Give one patch per
final face, a witness point inside the face with its outward normal (for example the centre of the
face's largest mesh triangle projected onto the face). A face that no feature claims fails the
drawing with `geometry_unaccounted`.

| `kind` | Faces | Required characteristics |
|---|---|---|
| `plane_face` | coplanar planes | location along its frame axis (none for a datum or a plane through the origin) |
| `bore` | inward cylinders; optional floors and drill-point cones | diameter (radius if partial), axis location or circular pattern, depth when floored |
| `shaft` | outward cylinders | diameter, axis location |
| `slot` | two opposed walls, one or two end radii, optional floor | width, length (closed), centre location or pattern, depth from a planar entry or floor elevation |
| `groove` | root cylinder, two walls | root diameter, width, axial location |
| `chamfer` | cones and narrow bevel planes | size × angle per distinct size |
| `round` | tori, small cylinders, spheres | radius per distinct size (B-spline blends belong in a `surface`) |
| `taper` | cones | angle |
| `socket` | flats and one floor; `relations.entry: [face feature]` | across flats, depth |
| `surface` | any faces | profile tolerance (`profile: controlled_model` plus `profile_tolerance_mm` or a `profile_surface` tolerance) |
| `engraving` | text faces; `relations.on: [plane feature]` | depth, extent, centre location; text and font in a note with `reference: <id>` |

Every axial end of a bore, shaft, groove or taper cylinder or cone must lie on a located plane, or
meet a chamfer, round, taper, surface or socket face; otherwise request a `length` dimension.

## Intent (`part.yaml` `drawing`)

- `type`: `detail`, `vendor_specification` or `source_control`.
- `datum_features`: label → `{feature, role: plane|axis|point|center_plane|clocking_feature}`.
- `coordinate_frame`: `origin` (`intersection` of datums, or `at`), and axes `z`/`x`/`y` as `normal_to` or
  `parallel_to` a reference with an optional `toward` sense, or `toward` a clocking feature.
- `views`: the first orthographic view is the principal view; others take the projection method's
  place next to it. `normal_to` looks at a plane from its outward side; `along_axis`, `perpendicular_to`
  and `opposite` as named; `section` `through` an axis or plane; `detail` of a `feature`.
- `features`: one entry per locator: `size: general|interface`, `presentation`, `tolerance_policy`,
  `profile`, `profile_tolerance_mm`, `thread` (`designation` such as `M10x1-6H`, `standard`,
  `operation`, `full_depth_anchor`), and a feature's own `surface_texture` or `edges`, which are
  exceptions to the drawing's general ones and print in the feature's callout. A `round` or `chamfer`
  that is an edge fillet or edge break may take `presentation: general_note`: its size prints once in
  the general note of undimensioned fillets and edge chamfers. A contour radius gets its own callout.
- `dimensions`: extra measured requests (`length`, `plane_separation`, `axis_distance`, `location`, ...)
  with an explicit `tolerance` (`deviation_mm` or a named policy); below 0.5 mm ISO 2768-1 has no general
  value. A `plane_separation` or `thickness` is drawn from its first feature's plane to its second's,
  at the pair of parallel planes nearest each other (a slot's wall facing the other feature). Unless it
  is `reference: true`, it locates a second `plane_face` feature from the first in place of that
  plane's datum location, so a wall thickness is a chain dimension, never a redundant third one. A
  `location` on a plane feature replaces its datum-frame location, so a depth such as a counterbore
  floor's carries its own limits; the deviation applies to the printed distance from the datum.
- `geometric_tolerances`: `{id, characteristic, features, zone_mm, diameter_zone?, datum_frame?}`.
- `edges` (detail drawings, required): the general indication of the edges of undefined shape, ISO 13715
  limits `[lower, upper]` in mm for `external` and `internal` edges. A `+` value permits excess material
  (a burr, a passing) and a `−` value requires removal (an edge break, an undercut); a single limit pairs
  with 0, so `external: [-0.3, 0]` prints `−0.3`. The ISO sheet writes the sizes in a general note; the
  ASME sheet writes the same limits as a burr, edge-break and corner note.
- `surface_texture` (detail drawings, required): the general texture `{parameter: Ra|Rz, limit_um,
  process: any|removal_required|removal_prohibited}`, drawn as an ISO 21920-1 (ASME Y14.36) symbol in
  the notes, followed by the basic symbol in parentheses when features carry their own. A value with no
  basis is `{open: reason}`: the sheet prints it as OPEN and release stays blocked (`surface_texture_open`).
- `notes`: `{kind: process|finish|material|inspection|general, text, reference?}`; a detail drawing needs
  a `finish` note. Notes never carry dimension values; edge values belong in `edges`.
- `manufacturing`: `interface_condition` (an FDM interface tighter than its process policy needs
  `post_processed` or `finish_machined`), `dimensions_apply`, `post_processing`, `build_direction`.
- `sheet`: allowed `sizes`, `orientation`, `scale` (`auto` or `n:m`).

`interfaces.yaml` binds interface sizes: `press_fit`, `running_fit`, `locating_fit` with `hole` and
`shaft` endpoints `{PN, feature, region?}`; `heat_set[].feature` for the host seat; and
`retaining_ring.feature` with `groove_d` such as `4.8 h10` for the shaft groove.

## Recognised features

`feature_recognition` finds the manufacturing features on the STEP without the locators, and the gate
(`feature_coverage`) checks the sheet against them, so intent that names only the envelope fails:

| Category | Stated directly | Located |
|---|---|---|
| `hole` | diameter | axis; a blind depth directly or both ends from one datum frame |
| `boss`, `shaft`, `groove` | diameter; groove width | axis; a boss height directly or baseline |
| `pocket`, `notch`, `slot`, `cutout` | width, length, depth (a slot through its kind) | its walls |
| `rib`, `wall` | thickness (two opposed parallel planes with material between, thin against their extent) | its faces |
| `step` | | height, directly or baseline |
| `arc` | contour radius | its axis |
| `round`, `chamfer` | size, in a callout or the general note | |

A prismatic feature (planes normal to a frame axis, cylinders and cones on one) may not sit only in a
controlled-model `surface`. Inclined planes, spheres, tori and B-spline faces may; an inclined face's
angle is then the model's. `drawing_draft.py` proposes locators and the direct size requests from the
same recognition; faces that match no pattern are listed with the reason.

## Vendor specification and source control sheets

A catalogue item (`procurement.mode: catalog`) with `drawing.type: vendor_specification` or
`source_control` gets a sheet that controls only what its specification states:

- Every face still binds, but the envelope is illustrative: no face needs a feature intent, and no
  general tolerance or end location applies.
- The characteristics are the `dimensions` requests, each with the specification's limits as
  `deviation_mm` or marked `reference: true`, and any feature `thread` (`operation: vendor`).
- The procurement table prints designation, manufacturer and part numbers, specification and hash.

`procurement` needs `designation`, `manufacturer`, `manufacturer_part_number` and `specification`
(`reference`, `revision`, `sha256`, and an `artifact` under `hw/` or a `url`). A standard part names its
product standard in `standard` (such as `DIN 471`, from ISO, IEC, EN, DIN, BS, JIS, ANSI, ASME, SAE, NAS or
MS) and is ordered by that standard's designation, which `designation` must state (`DIN 471 - 5x0.6`): any
conforming source supplies it, so it needs no manufacturer or manufacturer part number. A field the buyer
cannot fill yet goes in `open` with the reason: the sheet prints it as OPEN and release stays blocked. A
`url` without an `artifact` makes the frozen copy a sourcing input outside the record: the sheet says
so and `package.json` lists it under `provenance.sourcing_inputs`. A standard or catalogue part
without `drawing` intent gets no sheet; its procurement record is still checked. A vendor sheet states
that edges and surface texture are as supplied to the specification; `edges` and `surface_texture` are
for detail drawings only.
