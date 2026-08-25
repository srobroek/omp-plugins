---
name: authoring-no-generated-edit
description: Abort edits to generated agent runtime copies.
condition:
  - "(?:^|[\\s\"'/])\\.agents(?:/|$)"
  - "(?:^|[\\s\"'])(?:\\./)?AGENTS\\.md(?:$|[\\s\"':])"
  - "(?:^|[\\s\"'])(?:\\./)?CLAUDE\\.md(?:$|[\\s\"':])"
scope: "tool:edit, tool:write"
interruptMode: always
---
Edit the APM/plugin source. Never generated `.agents/`, `.claude/agents|rules`, or compiled AGENTS.md/CLAUDE.md.
