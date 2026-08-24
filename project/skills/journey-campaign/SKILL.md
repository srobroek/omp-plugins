---
name: journey-campaign
description: "Use when running journey or issue-driven validation at fleet scale: fan out validators, fix defects, and re-validate until green."
---

# journey-campaign

Orchestrate validation at fleet scale. FORMAT.md and README.md in the
journeys directory are normative; the fix-loop policy comes from README
frontmatter (`fix_loop`, `fix_loop_max_iterations`) unless the invocation
overrides it.

## Mode

Two entry points, one engine. Take the mode from the invocation; when
unstated, infer it from the scope: a journey, a journey subset, or a diff
→ journey-driven; a tracker query or a list of issues → issue-driven.

- **journey-driven** (default) -- the unit of work is a journey. Validate to
  discover defects. Findings are **outputs**. Done when the journeys are
  green.
- **issue-driven** -- the unit of work is a tracker issue that already
  describes a defect. Findings are **inputs**. Fix first, then verify only
  the steps that cover the issue. Done when the issues are verified and
  closed.

Everything after selection is shared: exclusive-profile serialization,
validator agents, dedupe, the fix loop, hard stops, the report.

## Plan

1. Select the unit of work: journeys (all `active` by default, or the
   user's subset, or a `journey-verify-changed` scoping pass when the
   campaign is diff-driven), or issues (a reporter query).
2. Group by interface profile. Profiles with `exclusive: true` form a
   serial lane (one validator at a time -- typically a single desktop app
   instance); the rest run in parallel.
3. Announce the plan: mode, journeys or issues, lanes, fix-loop mode,
   iteration budget.

## Journey-driven campaign

Spawn one `journey-validator` agent per journey with: journey path,
journeys-dir path, mode (full or the scoped step set), and the resolved
profile. Each validator follows the journey-verify procedure end to end
(evidence, triage, intent-gated amendments, run file, findings via
reporter) and returns a structured result: per-step results, amendments,
finding ids.

Aggregate. **Dedupe across journeys**: one product defect surfacing in
several journeys is one finding -- file once, reference it from every
affected run file; do not spam the tracker. With the local tracker, id
assignment is single-writer: parallel validators return finding payloads
and the coordinator appends them to TRACKER.md in one pass (github-issues
validators may file directly). The coordinator owns the single reindex and
the single journeys-dir commit per wave.

Then run the fix loop over the `suspected-regression` findings.

## Issue-driven campaign

1. **Select** the issues from the reporter. Subtract any issue already
   owned by an in-flight branch or PR -- never double-assign a lane someone
   else holds.
2. **Map issue → journey + steps**, in precedence order: an explicit
   journey/step trace in the issue body; the `journey-<n>` label; else the
   product surface via README's surface map. The resulting step set **is**
   the verification scope. The mapping is the campaign's own artifact:
   where a label is missing but the mapping is certain, add it.
   - **Unmapped issues are not skipped.** They are fixed like any other,
     and the fixed behavior still gets an in-app check at the profile's
     fidelity, recorded as an ad-hoc verification on the issue. Each one
     also raises a **coverage proposal**: the existing journey plus the new
     step it belongs in, or a new journey when several orphans share one
     user goal. Proposals go to the human in the report -- never author or
     amend a journey to fit an issue you just fixed. That is self-review,
     and it invents intent the user never stated.
   - Issues with no user-observable behavior (refactors, tech debt) are
     marked `no-journey-surface`: they verify on the repo's own gates
     alone. Say so in the report; do not invent a journey for them.
3. **Lane** the issues and dispatch per `fix_loop`. One lane per issue,
   except that issues touching the same files share a lane -- the lane is
   the conflict unit, not the issue.
4. **Verify in waves, batched by journey.** Verification is the scarce
   resource on an `exclusive: true` profile; never spend one app session
   per issue. Once a wave's fixes have merged, group the merged issues by
   journey and spawn ONE validator per journey with
   `changed-only(<union of the steps covering that wave's issues>)`.
   Serialize those validators. A journey with no merged fixes is not
   re-run.
5. **Resolve per issue** from the wave's run file:
   - pass → comment the evidence (steps run, expected vs observed, run-file
     reference, fix commit or PR) on the issue, then close it.
   - fail → the issue stays open; route the finding back to its lane per
     the fix loop. One retry per issue, then hard-stop it and report.

   A step covering several issues can fail for one and pass for the rest --
   attribute per issue, not per step.
6. **Bank the by-product.** A wave often ends up running every step of a
   journey; when it does and all pass, that is a full run -- promote
   `draft` → `active` per FORMAT if the journey's Known gaps are all
   user-confirmed.

## Fix loop

Per `fix_loop` mode:

- **report-only** -- stop after the first validation pass; report.
- **dispatch-coder** (default) -- for each unique `suspected-regression`
  (journey-driven) or selected issue (issue-driven): dispatch a fresh coder
  agent (isolated worktree when parallel) with the defect (journey/step,
  expected vs observed, evidence, repro steps) and the repo's own gates
  (tests/lint) as its acceptance bar. The validator never fixes product
  code; the coder never edits journeys. When fixes land, re-validate
  **only** the failed journeys, scoped to failed/blocked steps plus what is
  needed to reach them. Iterate.
- **fix-direct** -- the campaign context fixes small regressions itself,
  then re-validates. Note in each finding that fixer and validator shared
  context (weakest evidence integrity; solo use).

**Hard stops** -- end the loop and hand to the human when:
- iteration count reaches the budget (default 3),
- the same finding or issue fails again after a fix attempt (one retry
  each),
- a finding is triaged `product-question` -- never auto-resolved; park it
  and continue the rest,
- the environment breaks (env findings spike) -- fix the harness or stop;
  do not burn iterations on a broken bench.

Re-triage after every iteration: a "fix" that changes behavior without
intent evidence is itself a regression.

## Report

Single campaign report at the end:
- per-journey final state (pass / fail / blocked, version validated,
  amendments with evidence),
- findings: fixed (with fix commits/PRs), still open, parked
  product-questions needing decisions,
- issue-driven also: issues closed with their evidence, issues still open
  and why, coverage proposals awaiting a decision, and the
  `no-journey-surface` set,
- iterations used; what was NOT covered and why,
- proposals: consolidation candidates (green journeys with Δ entries),
  coverage gaps, surface-map additions.

Commit journeys-dir changes per journey-verify's convention. Product-fix
commits follow the repo's workflow: a coder that commits owns its commit;
when the coder agent type does not commit, the coordinator commits the fix
citing the finding id. Never leave an applied fix uncommitted.
