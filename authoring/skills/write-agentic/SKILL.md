---
name: write-agentic
description: Author or update skills, steering, or agent definitions using the standard templates and lint validation. Triggers on create/write/rewrite/optimize a skill, steering, or agent.
---

# Write Agentic Assets

One workflow for three asset kinds. Pick the template, author at source, lint.

## Kind → template

| Writing a… | Template | Install shape |
|---|---|---|
| skill | skill://write-agentic/references/template-skill.md | `skills/<name>/SKILL.md` (+ `references/`, `scripts/`) |
| steering | skill://write-agentic/references/template-steering.md | `rules/<plugin>-<topic>.md` |
| agent | skill://write-agentic/references/template-agent.md | `agents/<name>.md` |

## Workflow

1. MUST Edit the authoritative source (APM package repo).
2. Gather only what the repo cannot answer: purpose, trigger boundaries and
   non-triggers, install target, script/reference needs, external overlap.
3. LOAD the matching template and follow it exactly.
4. MUST lint with `agentic_lint` → fix every ERROR; justify or fix WARNs.
5. Review what lint cannot judge: are the triggers phrases a user would type, and
   is every reference one level deep?

## Format rules (all kinds)

MUST Enums in CAPS (`PASS|PARTIAL|FAIL`); decision tables as `situation → choice`.
MUST No hedge words on normative lines (lint list); replace with an observable condition.
MUST No model names in prose -- tier routing lives in steering-subagent-routing.
MUST State the rule, never argue for it. A steering line is read as an instruction,
  so a defence of why the rule exists is tokens the agent pays on every load and
  cannot act on. Write the reason only when it IS the rule (the measured number
  that set a threshold, the failure the rule prevents, a gotcha the agent cannot
  infer) or when an agent that does not know the reason would route around the
  rule.
DEFAULT Gotchas/env-facts may stay single sentences when a table would lose the trap.
NOT User-facing text (reports, PR bodies) -- never keyword prefixes.
