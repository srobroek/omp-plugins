# Agent Optimization Rules

## R1: Frontmatter

Every file must have YAML frontmatter with a `description` field. Third
person, present tense. For skills: be specific about triggers -- mention
keywords the user might say.

## R2: Language

- Remove model family names
- Frame as actions to take, not things to avoid
- For non-obvious rules, add a brief reason

## R3: Structure

- Tables for mappings (tool selections, phase routing, choices)
- Bullets for rules and constraints

## R4: Template

`write-agentic` owns the per-kind format contract and enforces it with
`scripts/lint.py`. Audit against its templates (`references/template-skill.md`,
`template-steering.md`, `template-agent.md`) and run its linter -- never against
a restated copy of the conventions, which drifts from the enforced version.

## R5: Cross-References

- Steering files: relative paths from the steering root
- Skills and agents: backtick-wrapped canonical names
- Consistent naming throughout -- no synonym drift

## R6: File Size

`write-agentic`'s `lint.py` sets the per-kind caps (skill 70, context 60,
pointer 10, agent 90 non-empty lines). Split files with two distinct topics,
routing + detail content, or multiple independent tables. Compress by merging
similar rules, removing redundant explanations, and tightening table cells.

## R7: Progressive Disclosure

Index files contain routing tables only -- what file covers what topic, when to load it. No rules or procedures inline. Three-tier loading: L0 index (always), L1 phase docs (when active), L2 references (when consulted).
