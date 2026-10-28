# Build guide

Generate this page from the project record and built version with `uv run --script cad/skills/cad-record/scripts/build_guide.py hw --version vN --out docs`.

<!-- The generator keeps the parts source in sync with hw/bom.csv. -->
<parts src="../hw/bom.csv" />

## Overview

Generated from the product record, release manifest, and selected version.

## Parts to make

Generated parts list with manufacturing file paths.

## Parts to buy

Generated procurement list, including explicitly open sourcing fields.

## Tools and consumables

Only items recorded in assembly operations and interfaces are listed.

## Assembly steps

Generated in operation order using the assembly drawing note wording.

## Checks before use

Generated from the verification matrix.
