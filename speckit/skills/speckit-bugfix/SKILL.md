---
name: speckit-bugfix
description: Use when fixing bugs in a SpecKit repo. Scales from quick fixes to full bug workflows.
---

# Bug Fix

Structured loop: **triage -> diagnose -> scope -> fix -> verify**. Max 3 loops.

When the fix needs a tracked trail on an active molecule, bond
`mol-speckit-bugfix` instead of (or after) this skill:

```
bd mol bond mol-speckit-bugfix <implement-step-id> --var feature=<NNN-slug>
```

The patch step must not write `specs/*/tasks.md` — create child beads.

## Phases

1. **Triage**: Parse input (issue, stack trace, or description). Gather context in parallel. Classify P0-P3. Ensure GitHub issue for P0/P1.
2. **Diagnose**: Reproduce (failing test, code trace, error search). Check `git log` on affected files. Form 1-3 ranked hypotheses. Present hypotheses ranked by likelihood; in non-interactive runs proceed with the top-ranked.
3. **Scope**: Score complexity 0-6 (files, lines, tests, behavior, blast radius, spec context). Route: 0-2 Quick Fix, 3-4 Structured Fix, 5-6 Full Spec.
4. **Fix**: Quick = direct edit + repro test. Structured = scratch report + implement. Full Spec = iterate on active spec or new micro-spec (completed specs are never reopened).
5. **Verify**: Repro test passes. Regression suite green. Diff review clean. Build and linter pass. On failure: back to Diagnose. Loop 3: expand scope or abandon.

## Rules

- NEVER skip Triage or Verify, even for obvious fixes.
- P0/P1 MUST have a GitHub issue for traceability.
- Side-issues: P0/P1 pause current fix, P2/P3 defer with issue.
- Store root-cause patterns to memory when the bug involved a non-local interaction, a surprising API constraint, or a recurring error class. Skip single-typo/off-by-one fixes.
