---
name: authoring-no-generated-edit
description: Abort edits to generated agent runtime copies.
condition: ["(\\.agents/skills|\\.claude/agents|\\.claude/rules|/AGENTS\\.md|/CLAUDE\\.md)"]
scope: "tool:edit, tool:write"
interruptMode: always
---
Edit the APM/plugin source. Never generated `.agents/`, `.claude/agents|rules`, or compiled AGENTS.md/CLAUDE.md.
