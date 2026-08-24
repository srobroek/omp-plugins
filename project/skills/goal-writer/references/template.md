# Goal Doc Structure

The context doc has YAML frontmatter for selection plus nine body sections. Write
it to `~/.local/state/agentic-tools/goals/` (see SKILL.md Persistence). Prefer
`scripts/new-goal.py`; it normalizes slugs, writes frontmatter, scaffolds the
sections, and sets user-private permissions (`0700` dir, `0600` file).

Open the doc body with a short "how to use" note so the across-turn agent treats
it as actionable, not just background:

```
> **How to use this doc:** the Results and Exit conditions below are the work to
> execute -- derive your task plan from them (this doc is not an ordered plan;
> build the plan at execution time). The other sections are context to steer by.
> The `/goal` completion line references this file by path.
```

## Frontmatter

```yaml
---
project: project-slug
goal: goal-slug
repo_root: /absolute/repo/root
source_prompt: the original vague goal prompt, verbatim
created: <ISO-8601 timestamp>
---
```

## Body sections (in order)

The sections encode one causal chain. Author them so the chain holds top to
bottom: **Results -> cause -> Outcomes -> measured by -> KPIs -> proven by ->
Validation -> gated by -> Exit conditions.**

1. **Goal** -- one sentence: what we are trying to achieve and for whom.
2. **Context / why now** -- the trigger, the problem, the cost of not doing it.
3. **Outcomes** -- the changes in behavior or state the goal produces. Each is a
   *change in the world*, not a thing you build. Test: "is this a change, not an
   artifact?" Every outcome must trace to at least one KPI.
4. **Results (deliverables)** -- the concrete artifacts that exist when done.
   Each is something you can point at or check off. Test: "can I point at it?"
5. **KPIs** -- one row per metric: `metric | acceptance band | target | measurement method`.
   The band is the range of acceptable values; the target is the point goal (may
   be `TBD` while bounded by the band, resolved during execution). When a metric
   genuinely cannot be measured yet, use `target: TBD -- proxy: <observable signal>`.
6. **Measurement** -- how and when each KPI is read: the tool, query, dashboard,
   or command, and the cadence. No KPI without a way to read it.
7. **Validation** -- how we *prove* the outcomes happened, beyond the raw KPI:
   the test, demo, review, or sign-off that confirms the change is real.
8. **Exit conditions** -- a checklist of independently verifiable predicates.
   These are AND-joined verbatim into the `/goal` completion line, so each must
   be testable on its own and unambiguous.
9. **Out of scope / non-goals** -- what this goal explicitly does not cover, to
   keep the exit conditions honest and bounded.

## Field bars (what counts as "strong")

| Field | Strong when | Push back when |
|---|---|---|
| Outcome | observable behavior/state change | it names an artifact (-> Results) or a task |
| Result | a concrete deliverable | it describes a behavior change (-> Outcomes) |
| KPI | band + target (or TBD+proxy) + method | bare metric, no number/band, no method |
| Exit condition | independently verifiable predicate | not testable, or depends on opinion |

## The /goal block

The block must be self-sufficient to *steer* (the across-turn agent loses
chat/compacted context) and sharp to *test*. Four parts, in order:

```
Goal: <one-sentence destination>

Work definition (execute the Results + Exit conditions; build your task plan
from them, re-read for diagnosis/bands/constraints):
<absolute path to the saved goal doc>

Constraints: <the few non-negotiables that must survive compaction --
measurement protocol, scope boundaries, key decisions>

Done when: (1) <exit condition 1> AND (2) <exit condition 2> AND (3) <exit condition 3>
```

The `Done when:` line is the mechanical AND-join the `/goal` command
re-evaluates each turn -- only verifiable predicates, no rationale. The Goal,
doc reference, and Constraints carry just enough context to steer; the full
nine-section doc lives at the referenced path, not in the block. Never paste
Outcomes or TBD-target KPIs into the completion condition.

## Worked example

Source prompt: *"make the API faster"*

```
## Goal
Reduce checkout-API latency so users stop abandoning slow requests.

## Context / why now
p95 latency regressed to ~600ms after the v3 rollout; support tickets about
"slow checkout" tripled this month.

## Outcomes
- Users experience checkout as responsive (no perceptible wait on the hot path).
- The team can detect latency regressions before users do.

## Results (deliverables)
- Profiled hot path with the top 3 contributors fixed.
- A p95-latency alert wired into the existing Grafana board.

## KPIs
| metric | acceptance band | target | measurement method |
|---|---|---|---|
| checkout p95 latency | 150-250ms | 200ms | Grafana `checkout_p95` panel |
| checkout error rate | <= 0.5% | TBD -- proxy: no new 5xx in canary | Datadog monitor |

## Measurement
Read both panels over a 24h window post-deploy; alert fires on band breach.

## Validation
Load test at 2x peak traffic shows p95 within band; canary 24h shows no error-
rate regression; on-call sign-off.

## Exit conditions
- [ ] checkout p95 latency is within 150-250ms over a 24h production window
- [ ] checkout error rate stays <= 0.5% in the 24h canary
- [ ] the p95 alert is live on the Grafana board

## Out of scope / non-goals
- Search and catalog APIs (separate goal).
- Front-end render performance.
```

`/goal` block:

```
Goal: reduce checkout-API latency so users stop abandoning slow requests.

Work definition (execute the Results + Exit conditions; build your task plan
from them, re-read for diagnosis/bands/constraints):
~/.local/state/agentic-tools/goals/shop__reduce-checkout-latency.md

Constraints: measure p95 via the Grafana checkout_p95 panel over 24h windows;
band 150-250ms; scope is the checkout API only (search/catalog out of scope).

Done when: (1) checkout p95 latency is within 150-250ms over a 24h production
window AND (2) checkout error rate stays <= 0.5% in the 24h canary AND (3) the
p95 alert is live on the Grafana board
```
