---
name: cad-review-dfm
description: Reviews part manufacturability against its declared FDM or CNC process with measured evidence. Use when a design needs an independent manufacturing review.
---

# Design for Manufacturing Review

TRIGGER
+ The design reaches CRITIQUE or needs an independent manufacturing review.
- Requirement trace, load path, or structural analysis review → `cad-review-mech`

## Workflow

1. Read `hw/product.yaml` and each scoped `hw/parts/<PN>/part.yaml`, model, drawing, and available process-check output. Use each part's own `process` field; do not infer one process for the whole product.
2. For `fdm`, check minimum wall thickness, overhang angle, bridge span, hole axis/orientation and shrink compensation, minimum feature size, print orientation, support generation and removal access against the declared printer/material/process limits or project criteria.
3. For `cnc`, check internal corner radii against standard tool sizes, tool access and depth-to-diameter ratios, setup count, thin-wall thickness, and standard hole/thread sizes against the declared machine, tooling, material, and drawing criteria.
4. For `purchased` parts, confirm the BOM supplier and catalog specification match the part identity. FDM and CNC geometry checks do not apply. Report missing supplier evidence as untested.
5. Cite each measured value and limit with units and exact part, drawing, script, or process-check output. If inputs or process limits are absent, report the check as untested rather than assuming a universal value.
6. Rank a shown process violation as MAJOR when the part cannot be made or misses a safety or function requirement. Use MINOR for a bounded process deviation without those impacts. PASS requires evidence for every applicable check.

MUST Select the FDM or CNC checks separately for each part using `part.yaml` `process`; report unsupported or missing process values as untested.
MUST Ground numerical limits in the project's declared process capability, material/printer/tooling data, drawing, or check output. Never present a generic rule of thumb as a measured project requirement.
MUST Include measured and comparison values with units and their source for every finding.
DEFAULT Collapse repeated defects caused by one shared geometry or process assumption into one finding.
NOT Edit records or models, run manufacturing operations, infer that a feature is manufacturable from appearance, or claim unsupported dimensional evidence.

## Output

Begin your reply with `VERDICT: PASS|MINOR|MAJOR` and one sentence naming reviewed parts and processes.
Untested -- named checks, unavailable inputs, and why. If no check is untested, state that the reviewer evaluated all applicable checks.
CAP 120w clean; 280w with findings.
MUST Never reprint code, diffs, file contents, or the caller's claim.
