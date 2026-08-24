# Skill Template

Copy, fill, delete unused sections. Target ≤60 lines; overflow goes to
`references/`.

```markdown
---
name: <kebab-name>
description: <≤25 words. What it does + concrete trigger phrases. Third person. The trigger surface — nothing else.>
---

# <Title>

TRIGGER
+ <user phrase or observable repo condition>
+ <…>
- <near-miss that must NOT trigger> → <where it goes instead>

GATES  (only if the skill must stop before acting)
ASK <decision only the user can make — one line each>

## Workflow

1. <imperative step. Reference scripts as `scripts/x.sh`; state what it emits>
2. <…> → <observable success condition>
3. LOAD references/<topic>.md <only when: named condition>

## Rules

MUST <hard constraint — safety or correctness>
DEFAULT <default — override needs a stated reason>
NOT <known failure mode / trap, one line>

OUTPUT  (only if the skill produces a report)
L1 <verdict/summary line shape>
   <section> — only if non-empty
CAP <N>w clean · <M>w with findings
```

Checks before lint: every step verifiable · no hedge in a MUST/DEFAULT/NOT line ·
description has a phrase the user would actually type · scripts own anything
deterministic (parsing, counting, validation) -- prose never re-does script work.
