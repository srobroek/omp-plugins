---
name: authoring-omp-steering-precedence
alwaysApply: true
---

When guidance conflicts, apply these layers in order:

1. The user's current request and the harness/system prompt
2. Repository `AGENTS.md`
3. Global `~/.omp/agent/AGENTS.md`
4. TTSR rules
5. Plugin rules
6. Skills
7. Agent prompts

Lower layers add; they never override a higher layer.
