# Agent Template

`agents/<name>.md` in the owning OMP plugin.
The description appears in the session's agent inventory.

```markdown
---
name: <kebab-name>
description: <≤25 words: what it does, when the parent should spawn it, one distinguishing boundary. Pipeline-internal agents (only spawned by name): ≤10 words.>
model: "@task"
thinking-level: medium
tools: read, grep, glob
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

MUST Choose a configured role selector, thinking level, and explicit tool set
  for the agent's work; the example above is a read-only role.

MUST Verdict enums in CAPS; every section conditional; cap stated in the contract.
MUST Phrase the first-line rule imperatively -- `Begin your reply with \`VERDICT:\`` -- not as a description. For scan/analysis agents that think out loud, add the draft/compose split: reasoning lives in working turns between tool calls, the final message is only the report, composed in one pass, with a check-the-first-line-before-sending instruction. "L1" is notation, never printed.
MUST Put task-specific constraints in the agent body or spawning prompt.
  Do not assume a lifecycle hook supplies them.
NOT No generic "how to be an agent" prose -- the harness covers it.
DEFAULT Worked scenarios: max 1, only when the failure mode is non-obvious.
