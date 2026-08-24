# beads

Work tracking on the [beads](https://github.com/steveyegge/beads) issue tracker (`bd`): a
dependency-aware DAG that survives across processes and crashes, which no native OMP
surface provides. Background: native background-job rows expire minutes after settling,
and there is no native dependency graph, gate, or merge slot.

Install this plugin in any repository that has a `.beads/` directory.

## Skills

| Skill | Use when |
|---|---|
| `build-formula` | Authoring a bd formula, deciding whether work should be a formula at all, or debugging one that pours the wrong DAG. |
| `adr` | Recording an architecture decision as a decision bead, superseding one, or acting on `bd lint` findings. |

## Rules

`beads-index` is always applied and lists the rest; every other rule is fetched on demand
through `rule://<name>`.

| Rule | Covers |
|---|---|
| `beads-core` | Claiming, field taxonomy, routing, dependencies, sync authority, JSONL-over-git fallback, database maintenance. |
| `beads-setup` | Initialisation and install verification. |
| `beads-lifecycle` | Status transitions and gate beads. |
| `beads-carriers` | Comments, decision beads, wisps, artifacts, and which one is authoritative. |
| `beads-composition` | Issue, epic, formula, molecule, bond, wisp. |
| `beads-coordination` | Swarms, merge slots, and passing a bead id at spawn so the worker claims it. |
| `beads-orchestration-doctrine` | Claim-as-contract doctrine consumed by orchestration workflows. |
| `beads-audit` | Explicit `bd audit record` entries for semantic events. |
| `beads-github-mirror` | Mirroring beads out to GitHub issues. |
| `beads-adr` | Architecture decisions as decision beads. |

## Notes

The rule bodies carry the sync-hook policy from the legacy package, including the Dolt-first
ordering and the JSONL-over-git fallback. Those hooks were Claude and Codex session-event
scripts; OMP has no equivalent event, so the policy is documented here and the hooks
themselves did not migrate.
