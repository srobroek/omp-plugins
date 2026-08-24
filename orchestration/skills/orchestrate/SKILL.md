---
name: orchestrate
description: Decompose multi-agent work over a durable beads DAG using native task isolation, hub, and a conflict re-dispatch loop. Use when asked to orchestrate, fan out specialists, or run a gated multi-writer plan.
---

# Orchestrate

Fan out writers and reviewers over a beads DAG. Native `task` isolation, `hub`, and a caller-chosen spawn `name` replace the Claude hook bus. The `orchestrate` magic keyword is a per-turn user-attributed notice; it is not this skill.

TRIGGER
+ "orchestrate", fan-out specialists, gated multi-writer plan, merge-queue run with beads
- Single-file edit, one reviewer, or a stateless PR drain → do not start a run

## Identity exists before the child runs

Each `task` item carries a caller-chosen `name`. That name becomes the registry and IRC id. The call returns `Spawned agent <id> (job <jobId>)` synchronously. Identity exists before the child acts.

That removes the entire legacy WAIT/CLAIM handshake, the two-phase activation guard, and the `.orchestration/.active-run` marker. Do not reintroduce them. Do not send `CLAIM {id}` as a prompt. Put the bead id, scope, and BRIEF on the bead; put shared policy in the batch `context` field. See `skill://orchestrate/references/dispatch-contract.md`.

## Writer topology

Writers run `isolated: true` with `apply: false`. Review the retained `<id>.patch` or the `omp/task/<id>` branch, then dispatch a **fresh** isolated fixer carrying the findings.

Isolated agents park **without a reviver**. Messaging a parked agent is the only resume primitive and it does not apply to isolation. The same specialist can never be woken again. A FIX or CONFLICT is a new spawn, not a CLAIM of the old node onto the same runtime.

The isolation baseline carries the parent's dirty WIP: staged, unstaged, and untracked-but-not-gitignored. Gitignored files are excluded. A child builds on the working tree, not clean HEAD. Cap is 1 GiB; exceeding it refuses the spawn.

## Merge and conflict re-dispatch

Native branch merge (`task.isolation.merge: branch`) stops at the **first** conflict and marks every remaining branch `failed`. A conflict re-dispatch loop is mandatory: treat the failed branch as a new fixer brief, continue the rest, never assume remaining branches landed.

A stash-pop conflict after cherry-pick is **partial success**: the cherry-picked commits already landed on HEAD; the stash is preserved. Do not rewind those commits.

Preflight collisions with `skill://orchestrate/scripts/scope-check.py` before claim. Predict merge conflicts with `skill://orchestrate/scripts/conflict-probe.sh`. Classify review-bot rounds with `skill://orchestrate/scripts/bot-review-probe.py`. Bridge watcher records with `skill://orchestrate/scripts/resolve-queue-dispatch.py`. Snapshot a run with `skill://orchestrate/scripts/run-status.py`.

## Beads stay

Beads (`bd`) is the only cross-process, crash-resumable DAG. Native job rows expire minutes after settle (`task.agentIdleTtlMs` is minutes). There is no native dependency graph, gate, or merge slot. Keep gate parking, the cross-run merge queue, and `metadata.integration_owner=orchestrate` on every merge bead this run creates so repository-global pr-shepherd does not drain mid-flight.

Set `BEADS_ACTOR` / `BD_ACTOR` to the spawn `name` on every mutating beads process.

Durable contracts: `skill://orchestrate/references/beads-store.md`, `skill://orchestrate/references/planning.md`, `skill://orchestrate/references/lifecycle.md`, `skill://orchestrate/references/queue-watcher.md`, `skill://orchestrate/references/roles.md`, `skill://orchestrate/references/decisions.md`.

Formulas under `skill://orchestrate/formulas/` remain valid for dead-claim recovery, bounce, land-branch, and architect setup/teardown.

## REGRESSION — unenforced conventions

Lead-never-claims, flat-tree spawn authority, and message-grammar conformance were hook-enforced denials under Claude (`PreToolUse`, `SubagentStart`, `SubagentStop`). On OMP they are **unenforced conventions**, only partially backed by frontmatter `spawns` and `task.maxRecursionDepth` (default 2). This is the largest behavioural regression in the migration. Do not soften it. The lead must still refuse claims in prose; children must still not spawn writers; `hub send` is free-text and is not linted.

## Dispatch

1. Write node metadata and one `BRIEF` comment. Read both back.
2. Required metadata: `scope`, `base_ref`, `base_sha`, `execution_task_kind`, `execution_kind`, `artifacts_dir`, `execution_dispatch`, `execution_agent`, `complexity_tier`. `base_ref` is the ref that actually carries the work.
3. `skill://orchestrate/scripts/scope-check.py` must report the candidate disjoint from every in-flight node.
4. Spawn with `task`: caller-chosen `name`, `isolated: true`, writers `apply: false`, shared policy in batch `context` from `skill://orchestrate/references/dispatch-contract.md`.
5. Review retained patches. Fresh fixer for findings. Conflict re-dispatch on first merge failure.
6. Shepherd merge beads via the run-scoped shepherd or `skill://pr-shepherd/SKILL.md`. Watcher input via `skill://release-queue-watch/SKILL.md`.

OUTPUT
L1 ORCH: spawned N / reviewed R / fixers F / conflicts C / merged M
CAP 200w clean · 400w with findings
