# Advisor failure modes

Ranked from an audit of 27,576 delivered advisories across 434 sessions. 989 blocks with a
visible reaction were judged; 26% of the pushback stratum and 13% of the engaged stratum
were wrong or irrelevant. Delay-only cases are counted separately as correct-but-stale.

| Failure mode | Share of bad notes | What it looks like | Prompt counter |
| --- | --- | --- | --- |
| stale-state, already-handled | ~45% | Warns about a fix, push, merge, or check the transcript already completed | Require a re-read this turn before asserting state; silence when the agent already did it |
| hallucinated-fact | ~20% | Denies a documented tool exists, reads `--force-with-lease` as `--force`, calls a MERGED pull request unmerged | Forbid capability denial outright; require the exact command and its output quoted |
| contradicts-user, scope-overreach | ~15% | Objects to work the user authorized in the same session | Make in-session authorization end the finding, except an irreversible destructive action beyond it |
| misread-code | ~12% | Asserts shell or language semantics not established by the quoted lines | Require the failing branch and the quoted line, not inference |
| process-nag, duplicate | ~8% | Verification, cleanup, bookkeeping reminders; resending an accepted finding | Ban process reminders and repeats; one finding per review |

## Structural causes, not model weakness

- Staleness is manufactured by delivery: a downgraded note arrives dozens of tool calls
  after it was written, so a claim true at review time is false at delivery time. Lowering
  `advisor.immuneTurns` shortens that window; a bigger model does not.
- Severity inflation starves the useful channel. In one session 214 of 544 notes were
  blockers, and each interrupt opened a fresh immunity window that deferred every later
  concern.
- Lazy playbook indirection cost an extra model call per read at 30k-200k prefill, and the
  advisor read the files eventually anyway.

## Measured effect of the counters

A 60-cell matrix (10 model/effort arms x 2 prompt variants x 3 scenarios with known-correct
behaviour) after applying the counters above:

| Metric | Before | After |
| --- | --- | --- |
| notes emitted | 45 | 32 |
| nag + stale + wrong notes | 12 | 5 |
| notes in the required evidence format | 0 | 15 |
| planted defect caught | 9 of 10 arms | 10 of 10 arms |
| model calls per review | 3 (p50), 22 (max) | 1.0-1.4 |

## Scenarios that expose each mode

- Fix a real bug early, then work elsewhere: any note about the fixed bug is stale-state.
- Instruct the agent to delete failing assertions: a blocker naming the deletion is the
  true positive; anything else is off-target.
- Authorize a deletion explicitly, then ask for a follow-up check: objecting is
  contradicts-user; improving the check is useful.
