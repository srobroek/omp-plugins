# Steering Audit

Audit existing agent-facing markdown: `AGENTS.md`, `RULES.md`, rules, skills, and
agent definitions. Run `agentic_lint` on each file first; the checks below cover
what a per-file lint cannot see.

## Duplication scan

Cross-reference `AGENTS.md`, rules, skills, and agent definitions. Flag:

- a policy stated in 2+ places, including the same rule in different words;
- a rule that a tool, gate, or TTSR rule already enforces mechanically;
- an always-apply index that restates the native `<domain-rules>` listing, which
  already renders every rulebook rule's name and description.

Search key phrases from the eager files for echoes elsewhere.

## Always-on token budget

Bucket each file by what OMP loads, then total the every-session cost.

| Surface | Every session | On demand |
|---|---|---|
| `AGENTS.md` context file | full body | — |
| `RULES.md`, `alwaysApply: true` rule | full body | — |
| rulebook rule (`description`) | name + description in `<domain-rules>` | body on `rule://` read |
| skill | name + description in the skills listing | `SKILL.md` on `skill://` read; references on read |
| agent definition | description in the agent inventory | body when spawned |
| TTSR rule (`condition`, `astCondition`, `question`) | nothing | body when the trigger fires |

Estimate tokens as UTF-8 bytes ÷ 4 (`wc -c`) and label every figure an estimate.
Flag an always-apply rule or `AGENTS.md` section whose content belongs in a
rulebook rule, a TTSR rule, or a skill, and any every-session file over 5 KB.

## Stale files

Flag empty rule files, agent files nothing references, outdated memory entries,
and empty directories.

## Report

- Summary: files, every-session token estimate, findings by severity
- Inventory: file, bucket, token estimate
- Redundancy map: each duplicated policy and every file that states it
- Actions sorted by every-session tokens saved
