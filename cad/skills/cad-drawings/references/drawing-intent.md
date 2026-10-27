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
| `chamfer` | cones | size × angle per distinct size |
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
  `operation`, `full_depth_anchor`).
- `dimensions`: extra measured requests (`length`, `plane_separation`, `axis_distance`, ...) with an
  explicit `tolerance` (`deviation_mm` or a named policy); below 0.5 mm ISO 2768-1 has no general value.
- `geometric_tolerances`: `{id, characteristic, features, zone_mm, diameter_zone?, datum_frame?}`.
- `notes`: `{kind: process|edge|finish|material|inspection|general, text, reference?}`; a detail drawing
  needs an `edge` and a `finish` note. Notes never carry dimension values.
- `manufacturing`: `interface_condition` (an FDM interface tighter than its process policy needs
  `post_processed` or `finish_machined`), `dimensions_apply`, `post_processing`, `build_direction`.
- `sheet`: allowed `sizes`, `orientation`, `scale` (`auto` or `n:m`).

`interfaces.yaml` binds interface sizes: `press_fit`, `running_fit`, `locating_fit` with `hole` and
`shaft` endpoints `{PN, feature, region?}`; `heat_set[].feature` for the host seat; and
`retaining_ring.feature` with `groove_d` such as `4.8 h10` for the shaft groove.
