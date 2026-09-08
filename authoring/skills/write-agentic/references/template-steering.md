# Steering Template

Native OMP rules are standalone Markdown files discovered from plugin `rules/*.md`
or project `.omp/rules/*.md`. OMP reads each rule directly.

Choose exactly one runtime surface:

## Rulebook rule

Use for guidance the model should discover by description and read on demand.

```markdown
---
name: <plugin>-<topic>
description: <when this rule is relevant, ≤25 words>
globs: ["<optional/file-glob>"]
---

<rule body>
```

`description` places the rule in `<domain-rules>`; `globs` label the listing but
do not select rulebook content automatically. Read it with `rule://<name>`.

## Always-apply rule

Use for unconditional guidance that belongs in every session.

```markdown
---
name: <plugin>-<topic>
alwaysApply: true
---

<rule body>
```

OMP injects the body into the system prompt and keeps it addressable through
`rule://<name>`.

## TTSR rule

Use for guidance that must be injected when prose or a tool stream matches a
regex or AST pattern.

```markdown
---
name: <plugin>-<topic>
condition: ["\\b<regex>\\b"]
scope: "tool:<name>(<file-glob>)"
interruptMode: never
---

<rule body>
```

Use `astCondition: ["<ast-grep-pattern>"]` for structural edit/write matches.
TTSR rules take precedence over rulebook and always-apply buckets when the
condition registers successfully. Keep `name` equal to the filename stem.
