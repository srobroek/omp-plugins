# orchestration

Multi-agent runs over a durable beads DAG, a merge-queue shepherd, and a signed GitHub webhook sensor. Deliberately unpublished in the marketplace until orchestrate and pr-shepherd are both installable together.

## Skills

- `orchestrate` — fan-out over beads using native `task` isolation and a conflict re-dispatch loop
- `pr-shepherd` — stateless drain of `pr:merge` beads
- `release-queue-watch` — local signed webhook receiver; supervise with `hub`; mutates nothing

## Agents

`architect`, `architect-high`, `orchestration-advisor`, `orchestration-reviewer`, `pr-shepherd`, `researcher`, `scribe`, `shepherd`. None named `reviewer` or `advisor` (those names are bundled and would shadow).

## Rules

- `orchestration-index` — always-apply pointer at the three skills

## Kept runtime

Scripts under `skills/orchestrate/scripts/` and `skills/pr-shepherd/scripts/` (scope-check, conflict-probe, bot-review-probe, resolve-queue-dispatch, run-status, merge-probe, watch-queue, landing-contract, resolve-queue-event). Reference docs and formulas under each skill. Webhook Node runtime under `skills/release-queue-watch/scripts/webhook/` (`package.json`, lockfile, `bin/`, `src/`). Do not vendor `node_modules`.

## Deleted (native or unenforceable on OMP)

| Deleted | Why |
|---|---|
| `discover-agents.py` | agents render into the `task` schema |
| worktree allocation and `worktree-sweep.sh` | `isolated: true` cleanup is unconditional |
| `inject-comms.sh`, `contract-start.py` | batch `context` reaches every spawn |
| `orchestrator-run-activate.py` | no `UserPromptSubmit`; identity is the spawn `name` |
| `orchestrator-claim-deny.py`, `orchestrator-activation-guard.py` | WAIT/CLAIM retired; become lead-prompt convention |
| `rules-eval.py`, its tests, fuzzer, and seven `rules/*.json` | no `SubagentStop` contract bus |
| `gen-domain-specialist-variants.py`, `domain-specialist-high` | per-item `effort` plus `thinking-level` |
| `hooks-smoke-test.py`, hook JSON files | no Claude hook runtime |
| `references/teams.md` | Claude agent-teams gone |
| `agent-models.yml` | model roles live in OMP config |
| `msg-lint.py` | `hub send` is free-text |
| `references/comms-block.md`, `message-grammar.md`, `spawn-brief.md` | merged into `skills/orchestrate/references/dispatch-contract.md` |
