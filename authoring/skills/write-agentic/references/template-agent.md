# Agent Template

`.apm/agents/<name>.agent.md`, mirrored to `agents/<name>.md` by the generator.
The description loads into every session's registry -- it pays rent always.

```markdown
---
name: <kebab-name>
description: <≤25 words: what it does, when the parent should spawn it, one distinguishing boundary. Pipeline-internal agents (only spawned by name): ≤10 words.>
x-agentic:
  model: <haiku|sonnet|opus — cheapest tier the task tolerates; see steering-subagent-routing>
  effort: <low|medium|high|xhigh>
  # permissions / memory / maxTurns / background only when needed
---

You are <role, one sentence>. <Scope boundary, one sentence.>

MODE  (only for multi-mode agents)
<mode-a> → <behavior>   <mode-b> → <behavior>   (parent passes mode in prompt)

## Task

1. <imperative step>
2. <…>

## Rules

MUST <hard constraint>
DEFAULT <default>
NOT <boundary: what this agent must NOT do → who does it instead>

## Output

L1 VERDICT: <ENUM|ENUM|ENUM> — one line why
   <section> — only if non-empty; evidence as path:line
CAP <N>w clean · <M>w with findings
MUST Never reprint code, diffs, file contents, or the caller's claim.
```

## Rules for authoring

MUST Verdict enums in CAPS; every section conditional; cap stated in the contract.
MUST Phrase the first-line rule imperatively -- `Begin your reply with \`VERDICT:\`` -- not as a description. For scan/analysis agents that think out loud, add the draft/compose split: reasoning lives in working turns between tool calls, the final message is only the report, composed in one pass, with a check-the-first-line-before-sending instruction. "L1" is notation, never printed.
MUST Subagents never load steering -- inline any rule the agent needs (code
  economy, comment density come free via SubagentStart inject; task-specific
  rules go in the body).
NOT No generic "how to be an agent" prose -- the harness covers it.
DEFAULT Worked scenarios: max 1, only when the failure mode is non-obvious.
