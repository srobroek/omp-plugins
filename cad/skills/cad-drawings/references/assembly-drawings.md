# Assembly drawings

`scripts/assembly_drawing.py` draws one checked package for `assembly.yaml` `drawing`. Sheet 1
shows the whole assembly, and each `subassembly_sheets` group gets a sheet of its own. Item
numbers are the same on every sheet. Every sheet has:

- an assembled view;
- an exploded view with item balloons;
- a parts list generated from `bom.csv`;
- numbered assembly notes.

```sh
uv run --script skill://cad-flow/scripts/run.py cad-drawings/scripts/assembly_drawing.py HW \
  --version vN --output-dir OUT [--timeout SECONDS]
uv run --script skill://cad-drawings/scripts/assembly_check.py OUT
```

Exit 0 means that the run published the package. Exit 1 means content findings; the run publishes
nothing. Exit 2 means invalid input or an infrastructure failure. Any failure replaces an earlier
package in OUT with `rejected.json`, so `package.json` always belongs to the latest run.

`assembly_check.py` re-checks a published package against the evidence in its `coverage.json`.
An edit to a sheet SVG makes the re-check fail.

## Intent

```yaml
drawing:
  number: LMP-ASM                     # drawing number; one package, sheets 1..N
  rev: X1
  title: Lamp arm assembly
  scope: modeled_mechanical_assembly  # or complete_assembly
  excludes: ["lampholder and wiring (IF-005)"]   # named in the scope note
  views:
    - {id: assembled_front, kind: assembled, direction: front}
    - {id: exploded_iso, kind: exploded, direction: iso}
  explode:                            # presentation offsets, mm, assembly frame
    - {ref: LMP-0005, offset_mm: [0, 0, 45]}
  items:
    - {item: 5, PN: LMP-0005}
    - {item: 11, PN: LMP-0011, occurrences: ["@ring-base", "@ring-elbow", "@ring-head"]}
  subassembly_sheets: [base_sub, arm_sub]
  operations:
    - id: press_base_pin
      kind: press_fit                 # press_fit | heat_set | retaining_ring
      part: LMP-0005                  # the occurrence installed
      into: LMP-0002                  # the occurrence that receives it
      interface: IF-001               # its limits.<kind> joins part and into
      direction: [0, 0, -1]           # in the receiving part's model frame
      acceptance: {kind: standoff, features: [head_underside, hub_top_face]}
      verify_joint: J-001             # optional free-movement check
```

- `direction` names one of `front back left right top bottom iso`. `iso` looks from (1, -1, 1)
  with the view's +X along (1, 1, 0).
- Balloons go on exploded views. A sheet with operations also needs an orthographic view, because
  the frame note says which way the assembly axes point in it.
- An item row stands for one PN. A PN placed more than once lists its occurrences, and its
  quantity is their count. Every occurrence of the assembly STEP must be in exactly one item.
- An explode offset carries the occurrence's kinematic children along: offsets add down the joint
  tree, so a link takes its pins with it. Offsets move presentation copies only. The assembled
  views and every measurement use the STEP placements.
- Each operation becomes one note. The note states:
  - which item goes into which item;
  - the installation axis in the assembly frame;
  - the seating that ends the installation;
  - the interface's fit, insert hole, or ring and groove.

  The drawing never states process values such as a press force or a torque. When one is
  necessary, the record must supply it first.

## Acceptance is measured on the assembled model

| Kind | Features | Model evidence the run requires |
|---|---|---|
| `seated` | part's, receiving part's | contact (gap at most 0.01 mm) along the installation direction |
| `standoff` | part's, receiving part's | a gap above 0.01 mm there; the note states its measured value |
| `flush` | part's, receiving part's | a plane of the receiving part within 0.02 mm of the part's trailing end |
| `engaged` | receiving part's groove | the two parts within 0.01 mm of each other |

The gap is measured by casting rays along the direction from the installed part's faces that face
the direction. Rays that start inside the receiving part are skipped, because a press band
overlaps its bore by design. The feature names are labels in the note. The measurement, not the
name, proves the relation.

## Stages and checks

1. `drawing_contract.load_context` validates the record and the version hashes.
2. `assembly_geometry.read_assembly` binds every occurrence to its STEP component. It uses
   cad-motion `pose.read_assembly_step` and `pose.bind_components`, and writes each definition
   once. `assembly_check.reconcile` then checks items, BOM quantities, operation limits and
   subassembly scopes.
3. A FreeCAD job (`assembly_techdraw_job.py`) applies each placement once and measures every view
   at scale 1. It finds a visible surface point on every occurrence to balloon. A point qualifies
   when it faces the viewer and a ray from it toward the viewer meets no solid.
   `assembly_sheet.plan_sheet` takes the smallest allowed sheet and, on it, the largest ISO 5455
   scale at which everything fits. Every ballooned occurrence must also be at least 3 mm across.
   A second job draws the views and projects the balloon points.
4. `assembly_check.check_sheet` reads each composed SVG back. Then
   `drawing_document.publish_package` runs the layout check and exports PDF and PNG.

`check_sheet` requires the following on every sheet:

- Every parts-list item has exactly one balloon in each exploded view.
- Every balloon has a parts-list row and prints its item number.
- A balloon names an occurrence of its item. Its leader ends with the dot on the measured point
  of that occurrence, inside the view.
- The quantity of each row equals the item's occurrences on the sheet. On sheet 1 it also equals
  the `bom.csv` roll-up.
- The other cells of each row equal its BOM row: PN, rev, title, material, designation.

| Code | Meaning |
|---|---|
| `invalid_drawing_intent` | missing or malformed `drawing`, unresolved reference |
| `bom_geometry_mismatch` | BOM quantity, the STEP's occurrences and the item disagree; STEP and record disagree |
| `assembly_item_unidentified` | occurrence without an item; balloon or parts-list row missing, duplicated or wrong |
| `assembly_instruction_incomplete` | operation without its interface limit or movable joint, or contradicted by the model |
| `feature_not_presentable` | an item has no visible occurrence in an exploded view: change its explode offset |
| `sheet_no_fit` | no allowed sheet fits the views legibly |

## Outputs

OUT holds `sheet-N.svg`, `.pdf` and `.png`, plus `coverage.json` and `package.json`.

- Coverage rows of kind `assembly_sheet` record, per sheet, the evidence that `check_sheet`
  compares the SVG with.
- Rows of kind `assembly_operation` record the measured acceptance and the installation axis of
  each operation.

The designation column of the parts list comes from the procurement columns of `bom.csv`. It is
blank when the BOM does not carry them.
