---
name: cad-recheck
description: Use when committing a batch of CAD hardware project changes at or after its recheck threshold.
---

# CAD Recheck

TRIGGER
+ A user commits a batch of design changes in a CAD hardware project.
+ A hardware project's current flow stage reaches its recheck threshold.
- Live preview or draft edits → do not run checks or write a stamp.

## Workflow

1. On a batch commit only, read the staged `hw/product.yaml` fields `flow.stage` and `flow.recheck_from`.
2. Before the threshold, build and render only; do not run checks or write a stamp.
3. At or after the threshold, recheck changed parts and their dependents, including this stage's checks and every earlier stage's checks.
4. Write the check results as JSON, then run `uv run --script skill://cad-recheck/scripts/stamp.py --stage <stage> --checks <json-file> --passed` only when all required checks passed. Omit `--passed` for a failed result.
5. Stage the design changes and `hw/.cad/recheck.json`. The pre-commit hook accepts only a passing stamp for the exact staged `hw/` tree.
6. Install the hook in a hardware project's repository with `uv run --script skill://cad-recheck/scripts/install-hook.py --project <project-directory>`.

## Rules

MUST Re-run the checks and stamp after any staged `hw/` file changes.
MUST Preserve `hw/.cad/recheck.json` as generated project metadata, not as design input to its own tree hash.
NOT Run checks or stamp during live preview or draft feedback.
