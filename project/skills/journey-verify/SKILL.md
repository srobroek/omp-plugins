---
name: journey-verify
description: "Use when validating user journeys against the running product: drives each step, triages mismatches, and records run results."
---

# journey-verify

Coordinate validation of one or more journeys. `FORMAT.md` in the journeys
directory is normative; read it plus `README.md` (config) and the target
`journey.md` files first.

Formula templates and their copy helper live in this skill's directory:
`'/Users/sjors/.claude/skills/journey-verify/formulas/*.formula.toml'` and `'/Users/sjors/.claude/skills/journey-verify/scripts/install_formulas.py'`.

## Beads formula provisioning

When the repository contains `.beads/`, run
`python3` on `skill://journey-verify/scripts/install_formulas.py` with `<repo-root>`
before validation. The helper copies the package-owned formulas into
`.beads/formulas/` and leaves identical copies unchanged. If a destination
differs, stop and ask before rerunning with `--force`.

Use `journey-step-agentic-verification` when the result needs no human gate.
Use `journey-step-human-verification` when a human must approve the triaged
result before evidence is recorded. Pour one molecule per selected journey
step; both formulas fan out runtime, definition, and acceptance checks before
triage.

## Who validates

Spawn one `journey-validator` agent per journey -- the complete validation
procedure (driving, evidence, triage, intent-gated amendment, run file,
findings) is owned by that agent's definition, not restated here. Respect
profile `exclusive: true`: serialize journeys sharing an exclusive profile;
the rest run in parallel.

- If the `journey-validator` agent type is unavailable, validate inline one
  journey at a time: read the agent definition
  (`.claude/agents/journey-validator.md`, or `agents/journey-validator.md`
  in this package) and follow it verbatim.
- Never validate a journey your own context authored or amended in this
  conversation -- that is self-review. Hand it to a validator agent or
  report that first validation needs a fresh context.

## Coordinator duties

1. **Resolve scope and inputs.** Which journeys; for each, the profile from
   its `interfaces:` and README.md. Pass each validator: journey path,
   journeys dir, run mode (`full` or `changed-only(S…)`), profile name, and
   the repo's commit convention (in fan-out: validators do not commit -- you
   commit once per wave).
2. **Aggregate.** Collect the validators' structured results. With the
   local tracker and parallel validators, id assignment is single-writer:
   have validators return finding payloads and append them to TRACKER.md
   yourself in one pass (github-issues validators may file directly).
3. **Promotion.** A `draft` journey may become `active` only when every
   step passed AND its Known gaps are all user-confirmed; note the
   promotion in the run file. Otherwise leave `status` untouched.
4. **Reindex once** per wave: `python3 <journeys-dir>/journeys.py index
   <journeys-dir>` (the helper lives in the journeys directory), then lint.
5. **Commit** journeys-dir changes as
   `journey(J<id>): validate v<version> — <result>` -- unless the caller or
   repo workflow forbids committing; then leave uncommitted and say so.

## Close the loop

Report per-journey results, amendments (with evidence), findings filed.
Then offer next actions -- never auto-run them when invoked directly:
`journey-consolidate` when green with Δ entries or when `runs/` exceeds
README `runs_keep` (retention is enforced only at consolidation -- say so);
the fix loop per README `fix_loop` for regressions (`journey-campaign`
owns the autonomous loop).
