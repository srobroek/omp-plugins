# Orchestrate

Orchestrate runs a delivery DAG through ledger-backed role workers, independent review, and exact-head integration.

## Topologies

| Situation | Topology |
|---|---|
| One delivery stream | One-tier: the current session leads the full DAG. |
| Multiple independently deliverable streams | Two-tier: the lead decomposes the work into epics and dispatches one orchestrator per epic. |

The two-tier topology requires `task.maxRecursionDepth` of `3`. One-tier works with the default depth of `2`.

Both topologies label every bead before dispatch, use pull-based worker execution, require independent review before merging, and close the parent only after repository verification passes with evidence recorded.

## Roles

| `role:` label | Agent | Responsibility |
|---|---|---|
| `implementer` | `implementer` | Implements assigned product changes. |
| `work-reviewer` | `work-reviewer` | Independently reviews completed work against acceptance criteria. |
| `researcher` | `researcher` | Investigates one scoped question and records evidence. |
| `merger` | `merger` | Integrates reviewed work at an exact verified head. |
| `shepherd` | `shepherd` | Aggregates one review round into one traceable fix bead. |
| `operator` | bundled `sonic` | Performs mechanical steps without choosing product behavior. |

## Measured benchmark

Two graded benchmark arms were green: each reached `verify.sh` exit 0 with 28/28 tests, zero open beads, zero blocked beads, and evidence on every close. One-tier cost `$6.88`; two-tier cost `$11.45`.
