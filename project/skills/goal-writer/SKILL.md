---
name: goal-writer
description: Turn a vague goal into a structured measurable one with verifiable exit conditions. Use when asked to structure a goal or prep text for /goal.
---

# Goal Writer

Convert a vague goal into a structured, actionable one through an interview, save
it as a context doc, then emit a self-sufficient `/goal` block that references
the doc and tests done-ness via AND-joined exit conditions.

## Workflow

1. Read the user's goal prompt. Classify each template field (see below) as
   **strong** (present and passes its bar) or a **gap** (absent or below bar).
2. Grill the gaps (see Interview). Skip strong fields -- do not re-litigate a
   sharp answer.
3. Compose the full goal doc from `'/Users/sjors/.claude/skills/goal-writer/references/template.md'`, enforcing the chain
   **Results -> Outcomes -> KPIs -> Validation -> Exit conditions**.
4. Show the composed doc in chat for review; apply any adjustments the user asks
   for.
5. Persist the doc via `'/Users/sjors/.claude/skills/goal-writer/scripts/new-goal.py'` (see Persistence). Capture the path
   the script prints.
6. Emit the `/goal` block (see Output) using that real path, so it can be pasted
   immediately.

## Interview

Ask one question at a time and wait for the answer. Carry on until every gap is
sharp. For each question, provide your recommended answer. If the repo or the
prompt can answer a question, read it instead of asking.

Treat a field as a gap when it is missing **or** below its quality bar:

- **Outcomes** -- an observable change in behavior or state, not a task or
  artifact. (An artifact belongs in Results.)
- **Results** -- a concrete deliverable that exists when done. (A behavior
  change belongs in Outcomes.)
- **KPIs** -- each has an acceptance **band** plus a target and a measurement
  method. Bands are first-class; the exact target may firm up during execution
  as long as the band bounds it. If genuinely unmeasurable yet, allow
  `target: TBD -- proxy: <observable signal>`, never a bare vague metric.
- **Exit conditions** -- each is an independently verifiable predicate, authored
  so they can be AND-joined into one completion condition.

Push-back rules: a "Result" that is really a behavior change -> move to Outcomes;
an "Outcome" that is really an artifact -> move to Results; an Outcome with no
KPI -> attach one or it is not a tracked outcome.

## Output

Emit one `/goal` block in the shape given under "The /goal block" in
`'/Users/sjors/.claude/skills/goal-writer/references/template.md'` -- that section is the contract, and the worked example
below it shows a filled block. Use the real saved-doc path so the block can be
pasted immediately.

## Persistence

Run `'/Users/sjors/.claude/skills/goal-writer/scripts/new-goal.py'` to write the context doc to
`~/.local/state/agentic-tools/goals/<project-slug>__<goal-slug>.md` with
user-private permissions. Goals are kept (not overwritten) -- a project has many
goals over time; the goal-slug distinguishes them. The doc is ephemeral local
state, never committed. Pass `--title`, the user's original prompt verbatim via
`--source-prompt`, and the composed body on stdin; see the script's `--help`. If
the script is unavailable, create the same file contract manually: that
directory, `<project-slug>__<goal-slug>.md`, the frontmatter and body from
`'/Users/sjors/.claude/skills/goal-writer/references/template.md'`, mode `0600`.

## Rules

- Review with the user before saving (step 4), but always save (step 5) -- the
  `/goal` block references the doc by absolute path, so the file is a hard
  dependency, not an opt-in.
- Do not invent KPI targets the user did not give -- use the TBD-with-proxy form.
- Keep `Done when:` a literal AND-join; if it grows unwieldy, that signals too
  many exit conditions -- surface that in the interview, do not summarize.
- Do not store secrets or credential values in the goal doc.

## References

When composing the goal doc, LOAD `'/Users/sjors/.claude/skills/goal-writer/references/template.md'` for the section
contract, field bars, and the worked example.
