---
name: cad-bom
description: Rolls up an engineering BOM from a STEP AP242 assembly and hw/parts metadata into bom.csv. Triggers on "build the BOM", "EBOM", "bill of materials".
---

# CAD EBOM Roll-up

Stage BOM, after L3 DETAIL; RECHECK reruns it from LAYOUT freeze onward.

TRIGGER
+ "build the BOM", "update bom.csv", "how many pins does the assembly use"
+ a STEP assembly or a `hw/parts/<PN>/part.yaml` changed after LAYOUT freeze
- a manufacturing BOM, purchasing list, or cost roll-up → out of scope; this skill emits the EBOM only
- the BOM skeleton during L1 LAYOUT, before a STEP exists → `cad-record`

## Workflow

1. Export the assembly as STEP AP242 with product names that start with the PN
   (`PIN-0001` or `PIN-0001 Dowel pin`).
2. `uv run --script skill://cad-flow/scripts/run.py cad-bom/scripts/bom.py ASSEMBLY.step --hw hw [--version vN|latest]` writes `hw/bom.csv` by default and prints JSON summary fields `status`, `rows`, `total_qty`, `missing_part_yaml`, `missing_in_step`, `unidentified`. With `--version`, `reconciled_against` names the selected version. The command reads metadata from that version's snapshot.
3. Exit 1 means the record and the model disagree; bom.csv is still written. Resolve each list:
   `missing_part_yaml` → create the part.yaml or rename the product;
   `missing_in_step` → remove the stale part or add it to the model;
   `unidentified` → give the leaf product a PN.
4. Rerun until exit 0, then COMMIT records the bom.csv change with the stage.
   Without `--version`, the current `hw/parts` records are reconciled; with it, BOM metadata and reconciliation use the selected version's snapshot, not current records.

## Semantics

- `level` 0 is a numbered top assembly; each child is parent + 1. Children of an unnumbered top assembly start at 1. The record validator uses the same rule, including accepting a numbered assembly row without `part.yaml` when it has child rows.
- `qty` counts instances per one parent. A repeated subassembly is one row with its qty; its children appear once beneath it. `total_qty` in the JSON multiplies through.
- An assembly product without a PN is a phantom group; its children merge into the nearest numbered parent.
- Assemblies need no part.yaml; leaf parts do. `mass` copies `mass_target` (grams).
- `unit` is `pcs`: `qty` counts STEP instances. `designation`, `manufacturer`,
  `manufacturer_part_number` and `supplier_part_number` copy part.yaml `procurement`;
  `specification_ref` and `specification_rev` copy its `specification` `reference` and `revision`.
  They stay blank when the part declares none.

## Rules

MUST Treat exit 1 as a check failure that blocks the stage gate.
MUST Edit part metadata in `hw/parts/<PN>/part.yaml`, never in bom.csv; the script overwrites bom.csv.
NOT Count parts by hand or from a viewer; quantities come from the STEP product tree.

```text
L1 BOM: {PASS|FAIL}, {rows} rows, {distinct PNs} part numbers
   Mismatches -- {each non-empty list from the JSON summary}
```
