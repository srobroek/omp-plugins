---
name: advisor-resample
description: Weekly census and hand-labeled precision sample of delivered advisor notes from session transcripts. Triggers on resample the advisor, is the watchdog still noisy, advisor precision.
---

# Advisor Resample

TRIGGER
+ weekly advisor check, or "resample the advisor" / "is the watchdog still noisy"
+ an advisor prompt, roster, model, or `advisor.*` setting changed since the last run
- writing or tuning a `WATCHDOG.yml` / `WATCHDOG.md` → `watchdog-files`
- one advisor note in the current session looks wrong → answer it in place
- coding/review task outcomes after steering, model, or tool changes → `skill://tune-model-prompt`; retain this skill for delivered-note precision

## Workflow

1. `bun scripts/advisor-census.ts --days 7` (after a change: `--since <change time>`)
   → census on stdout, labeling sheet `labels.csv` + `labels.md` under
   `$TMPDIR/advisor-resample-<date>` (`--out DIR` overrides; `--sample N`, default 30).
2. Read the census: per-advisor notes, severity mix, no-finding share of delivered
   notes and of `advise` calls, `turns_ago` p50/p90/max, notes in batches of 10 or
   more, notes after which the agent took no further turn, Jaccard ≥ 0.3 repeats.
3. Label every row of `labels.csv` from its `labels.md` excerpt: fill `label` and
   `reaction`. LOAD references/labeling.md for the rubric.
4. `bun scripts/advisor-census.ts <same window flags> --labels <dir>/labels.csv`
   → adds strict, population-weighted strict, inclusive, FP share, reactions, and
   a verdict per advisor.
5. Report the verdict table and the numbers that moved since the previous run.

## Decision rules

| Measurement | Rule |
|---|---|
| weighted strict precision U/(n−N) ≥ 25%, ≥ 10 labeled substantive notes | KEEP |
| weighted strict precision < 25% | RETIRE-CANDIDATE |
| < 10 labeled substantive notes | INSUFFICIENT → rerun with a larger `--sample` |
| no-finding share ≤ 5% of delivered notes and of `advise` calls | PASS, else FAIL |

RETIRE-CANDIDATE in two consecutive runs → propose disabling that advisor entry
to the owner. FAIL → propose a prompt fix for the silence rule, not a model change.

## Rules

MUST Never write config, `WATCHDOG.*`, or settings; the skill reports, the owner decides.
MUST Use the same window flags for step 4 as for step 1.
MUST Label from the transcript excerpt and next primary turns, not from the advisor's
  own justification.
DEFAULT Weekly window `--days 7`; seed 1 so a rerun reproduces the sheet.
NOT Read `advise` call counts as history: an `__advisor.<slug>.jsonl` transcript is
  rewritten when its advisor session restarts, so delivered notes are the population.
NOT Treat `no_finding_auto` as ground truth; the one no-finding row per stratum is
  its spot check.
