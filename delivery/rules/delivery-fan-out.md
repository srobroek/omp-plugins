---
name: delivery-fan-out
alwaysApply: true
---

# Fan-out delivery

LEGEND: Rules carry stable IDs (FO-n).

Rationale: in chat requests with several independent changes, a lead given these rules
fanned out every change, while a lead without them fanned out none. Loaded lazily as a
domain rule, the rules were never opened in a full user environment (fan-out 0 of 21
changes); loaded always-on they restored full fan-out at equal quality. A pinned higher
implementation tier added cost without quality.

## Split

MUST FO-1: split work into units ONLY when ALL hold: the units are independent (establish it from source, imports, contracts, and tests, never from titles), write no shared file, region, or state, need no fixed order, and each carries meaningful work (a whole acceptance criterion or file group, never one trivial edit). Otherwise keep the work whole: one causal chain, one root-cause investigation, or a shared write stays with one agent.

MUST FO-2: give each shared region (contract, schema, registry, generated artifact, shared config) ONE owner unit. Only units that need its output wait for it. When units are beads, create `blocks` edges only under the dependency semantics in `rule://beads-ledger`.

## Dispatch

MUST FO-3: size by independent ready units. With 2 or more, dispatch the lesser of the unit count and 8 in ONE `task` batch; queue the rest for the next batch. NEVER serialize independent units.

MUST FO-4: every brief is self-contained; subagents share no conversation. State the goal, the exact target files, the interface or contract it must honor, observable acceptance, and "run only the focused commands needed to prove your own change; skip repository-wide builds, test suites, linters, and formatters, which the lead runs after integration (FO-7)".

MUST For code design, investigation, implementation, or review, pass `rule://quality-code-design` and `skill://quality-code-design` to every worker, including `implementer-high`, `implementer`, built-in `task`, `scout`, and reviewer agents. Supply core and task-relevant reference text when the child cannot resolve those URIs; report missing policy instead of claiming coverage. Select language guidance from the actual code-work scope. Preserve read-only roles and fixed assignments; scouts report evidenced design observations, not edits or unsolicited approvals.

MUST FO-5: read each bead's `execution_agent_type` metadata before spawning, and dispatch the bead to the agent it names: default `implementer`; `implementer-high` only when the bead says so under the criteria in `rule://beads-ledger` (root-cause/debugging work, concurrency or data-integrity logic, cross-module contract changes, algorithmic or numeric precision rules, or acceptance that needs design judgment beyond the bead text). A spawn with no bead, or a bead with no `execution_agent_type`, goes to `implementer` unless the brief states one of those implementer-high criteria. Pass `execution_reasoning_effort` when set. NEVER pin a higher tier for a bead without that metadata.

## Helpers

Start a helper only where it pays:

| Need | Helper |
|---|---|
| Broad read-only lookup across unknown files | `scout` |
| Risky diff: security, data loss, concurrency, public contract | `reviewer` or `security-reviewer`, before landing |
| External question that needs cited sources | one `task` research brief returning cited findings |
| A few reads, one `grep`, or one script answers it | none: do it inline |

## Isolate and integrate

MUST FO-6: when two or more agents edit concurrently, give each its own linked worktree cut from one recorded base commit (`rule://worktrunk-worktree-required`). Integrate each finished branch into the lead branch by merge. A conflict means the split overlapped: resolve it once in the lead branch against both units' acceptance criteria.

MUST FO-7: verify worker claims against the diff, then run the repository-wide verification command ONCE after integration, in the lead branch. A red result is the lead's: dispatch a targeted fix and re-verify before landing through `rule://delivery-git-workflow`.
