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
3. **Scope**: Route by the table below. Assess uncertainty, consequences, affected contracts, and recovery difficulty first; file and line counts estimate effort, not safety. Load `skill://quality-code-design` and its relevant lifecycle references; surface missing guidance.
4. **Fix**: QUICK FIX = bounded edit plus the focused check. STRUCTURED FIX = concise diagnosis and failure/recovery plan, then implement. FULL SPEC = iterate on the active spec or a new micro-spec (completed specs are never reopened). Complete reuse research before code writes; do not add a test or document solely to satisfy a label.
5. **Verify**: Check the accepted behavior and the reproduced failure; exercise credible failure cases. Run focused regression checks and every project-required suite/build/lint gate. Do not weaken expected behavior to get green tests. Report unavailable checks and evidence limits. On failure: back to Diagnose. Loop 3: expand the investigation or return a blocker; do not claim completion.

## Scope routing

| Situation → route | Evidence |
|---|---|
| Understood local behavior, bounded effects, easy recovery, no unresolved material risk → QUICK FIX | Direct edit and focused reproduction/regression check |
| Uncertain cause, security/data/concurrency risk, shared contract, or coordinated migration → STRUCTURED FIX | Resolve the uncertainty, identify affected consumers, and state failure and recovery checks |
| Unresolved requirements or consequential cross-system design needs an agreed contract → FULL SPEC | Use the active spec or a micro-spec to resolve it before implementation |

Bad: route an authorization bypass to QUICK FIX because its patch is one line.
Good: inspect the access boundary and verify denied cases; use STRUCTURED FIX even for a small diff.
Bad: require a full spec for a large mechanical rename with compiler-verifiable callers.
Good: use QUICK FIX when behavior and recovery are understood; preserve required checks.

## Rules

- NEVER skip Triage or Verify, even for obvious fixes.
- P0/P1 MUST have a GitHub issue for traceability.
- Side-issues: P0/P1 pause current fix, P2/P3 defer with issue.
- Store root-cause patterns to memory when the bug involved a non-local interaction, a surprising API constraint, or a recurring error class. Skip single-typo/off-by-one fixes.
