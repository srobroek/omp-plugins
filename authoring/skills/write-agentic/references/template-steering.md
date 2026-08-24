# Steering Template

Two files. The pointer is always-loaded -- every word there is paid each
session. The context loads on demand.

## Pointer -- `.apm/instructions/NN-<name>.instructions.md`

```markdown
---
description: <≤15 words>
# Omit applyTo for unconditional instructions compiled into global context.
applyTo: "<optional glob — include only for genuinely file-scoped rules>"
---

For <topic list, ≤12 words>, read [<name>](../context/<name>.context.md).
```

NN prefix = load order band: 0x meta/style · 1x toolchain · 2x-3x structure ·
4x workflow · 5x domain · 7x language/docs · 8x tools.

## Context -- `.apm/context/<name>.context.md`

```markdown
# <Topic>

<AREA-1>
MUST <hard rule>
DEFAULT <default>

<AREA-2>
ASK <confirm with user>
| situation | choice |
|---|---|
| <observable condition> | <decision> |
```

## Rules

MUST Decisions and gotchas only -- never explain what a well-known tool is or why
  a choice is right. The choice IS the content.
MUST One home per fact: if another steering file owns it, delegate with one line
  ("see steering-x") -- never restate.
MUST No hedges: every rule uses MUST, DEFAULT, ASK, or NOT + an observable condition.
DEFAULT Target ≤50 lines context, ≤6 lines pointer.
DEFAULT Omit `applyTo` for unconditional instructions; scope file-specific rules
  with the narrowest truthful glob.
NOT Rationale paragraphs, aphorisms, scope disclaimers, command catalogs.
