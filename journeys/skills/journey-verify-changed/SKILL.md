---
name: journey-verify-changed
description: Use when validating only the journeys affected by a diff, PR, or branch change rather than the full journey suite.
---

# journey-verify-changed

Scope first, then delegate execution to the journey-verify procedure in
changed-only mode. FORMAT.md and README.md in the journeys directory are
normative.

## 1 -- Determine the change set

In order of preference:
1. What the user named (PR number, ref range, feature description).
2. Merge-base diff with the default branch on a feature branch.
3. On the default branch: since the last release tag, else recent merges.

Collect both the **file list** and the **stated intent** (PR titles/bodies,
commit messages, changelog entries) -- files say where, intent says what.

## 2 -- Map changes to journeys and steps

1. Apply README.md's surface map (globs → surfaces) to the file list.
2. Read INDEX.md; select journeys whose `surfaces:` intersect.
3. Bridge gaps with judgment: read the diff enough to understand
   user-visible impact; a change can hit journeys no glob names (shared
   components, API contracts). Note additions the surface map should learn
   and propose them for README.md.
4. Within each selected journey, mark the steps plausibly affected. When in
   doubt about a step, include it -- false inclusion costs a step run, false
   exclusion misses a regression. Always include steps whose
   `Expect (negative):` guards the changed area.
5. If the change is user-visible but NO journey covers it, that is a
   coverage gap: report it and offer journey-write before validating.

## 3 -- Validate

Run the journey-verify procedure for the selected journeys with
`mode: changed-only(S…)` -- selected steps plus any earlier steps needed to
reach them (those run as setup; their expectations still count). Everything
else in journey-verify applies unchanged: triage, intent gating, run files,
reporter, commit.

## 4 -- Report

Per journey: scope chosen and why, results, amendments, findings. State
explicitly what was NOT validated (unselected journeys/steps) so a green
result is never mistaken for full coverage.
