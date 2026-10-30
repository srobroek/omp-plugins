# Concept scene format

Schema: `skill://cad-concept/assets/schemas/concept-scene.schema.json` (JSON Schema 2020-12).
Worked example: `skill://cad-concept/assets/examples/lamp-arm.scene.json`, a desk lamp arm
with three variants and joints base -10..80 deg, elbow -120..0 deg, head -45..45 deg.
`scripts/concept.py check` enforces the schema plus the cross-field rules marked CHECK.

## Frames

| Quantity | Convention |
|---|---|
| Up axis | +Z. The viewer camera looks from -Y, so variants read left to right along +X |
| Length | mm (`"units": "mm"`) |
| `position` | node origin in the parent frame, default `[0,0,0]` |
| `rotation` | XYZ Euler degrees, three.js `XYZ` order (R = Rx * Ry * Rz), default `[0,0,0]` |
| Primitive | centred on its part origin |

## Top level

```json
{ "format": "cad.concept-scene", "version": 1, "id": "lamp-arm", "title": "Desk lamp arm",
  "units": "mm", "variants": [ ... ], "retired": [ ... ], "chosen": "long-reach" }
```

- `variants`: 1-4 live variants. Draft 2-4; fewer than 2 only after drops.
- `retired`: `{id, label, disposition: dropped|merged, into?, reason}`; `merged` needs `into`, a live variant (CHECK).
- `chosen`: set only at the VARIANT gate; must name a live variant (CHECK).

## Variant

`{id, label, summary?, params?, root, joints?}`. `label` is the title under the variant,
e.g. `"A · Short reach"`. `params` maps `snake_case` names to numbers, strings, or booleans
and flows into the handoff verbatim. `root` is a group that stands for the variant.

## Nodes

Group: `{kind: "group", id, label, position?, rotation?, children: [node, ...]}`.
Part: `{kind: "part", id, label, position?, rotation?, shape, color?}`.

| `shape.type` | Fields | Notes |
|---|---|---|
| `box` | `size: [x, y, z]` | |
| `cylinder` | `radius`, `height` | axis along local Z |
| `capsule` | `radius`, `height` | axis along local Z; `height` is tip to tip, at least 2 x radius (CHECK) |
| `sphere` | `radius` | |

Ids match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and are unique within a variant (CHECK). Reuse
the same id for the same concept part in every variant. Every part and group gets a label
in the viewer; the root group is labelled by the variant `label`.

## Joints

`{id, label?, type: revolute|prismatic, parent, child, axis, origin, min, max, nominal}`

- `child` is a direct child of `parent` in the tree (CHECK); a node is the child of at most one joint (CHECK).
- `axis` (non-zero, CHECK) and `origin` are in the parent frame.
- The authored child transform is its value-0 frame; the viewer places it at `nominal`.
- Joint axes, origins and limits are carried to L1 LAYOUT in the handoff.
- Revolute values are degrees within one turn, prismatic values mm. `min < max` and `min <= nominal <= max` (CHECK).
- Single DOF only. Cylindrical, ball, and fixed joints are authored at L1 LAYOUT.


The viewer omits joint axis arrows. They indicate mechanism direction but show no articulation and do not help compare concept variants.
## Viewer surface

| Route or call | Use |
|---|---|
| `/?scene=<file>` | open one scene; a picker appears when the dir holds several |
| `window.cadConcept.save()` | the Save screenshot button: `hw/concept/screenshots/<scene-sha256>/<capture-sha256>/preview.png`; each bundle manifest records the scene and viewer-state digests |
| `/events` | Server-Sent Events; `change` carries `{"files": [...]}` |

The viewer shows all variants at their authored nominal configuration; joint fields remain in the
scene for validation and the L1 LAYOUT handoff. A scene that fails to parse or wire keeps the last
good render and shows the error in the panel.

## Handoff manifest

`scripts/concept.py handoff <scene> [--variant ID] [--out FILE]` writes
`skill://cad-concept/assets/schemas/handoff.schema.json`: the scene digest, the chosen
variant's `params`, every node in parents-first order with `path` (slash-joined ids), authored
transforms, and an envelope (bounds in the node frame with joints at nominal), every joint with a
unit axis and `unit: deg|mm`, and each alternative's fate (`not-chosen`, `dropped`, `merged`).
