---
name: beads-core
description: "Core bd contract: claiming, field taxonomy, routing, dependencies, and database maintenance. Read when tracking work in a repo with .beads/."
---

# Beads (bd)

SCOPE
MUST Use `bd` for task tracking when the repository has `.beads/` (`bd where`
  succeeds). Do not substitute TaskCreate or markdown task lists.
DEFAULT Keep SpecKit artifacts (`spec.md`, `plan.md`) as the source for what to
  build; beads records execution state, not requirements.

IDENTITY
MUST Set `BEADS_ACTOR` (`<harness>/<agent-name>/<session-id>`) on every
  mutating command when acting as a subagent. Export the same value as
  `BD_ACTOR` until the project hook accepts `BEADS_ACTOR`.

CLAIMING AND LEASES
Claim and lease lifecycle choreography is supplied by the session lifecycle and orchestration harness. Read `rule://beads-lifecycle` for the bead-state contract; do not duplicate hook-managed claim, release, or takeover steps here.


FIELD TAXONOMY
| purpose | mechanism | writer |
|---|---|---|
| lifecycle | status (`open`, `in_progress`, `blocked`, `deferred`, `closed`) | worker |
| ownership | assignee (atomic via `--claim`) | worker |
| urgency | priority 0-4 | orchestrator/user |
| work kind | type (`bug`, `feature`, `task`, `epic`, `chore`) | creator |
| bounce-back | `discovered-from` dependency plus comment; release | integrator |
| routing queue | label `agent:<name>` | orchestrator/formula |
| group dispatch | assignee = pool alias (`claim.pools`) | orchestrator |
| category | lowercase-hyphenated labels, at most ten/repo | any |
| state cache | `bd set-state <id> dim=value --reason` | owning agent |
| execution hints | `execution_*` metadata before spawn | orchestrator |
| git anchors | `repo`, `branch`, `base_sha`, `worktree`, `pr`, `merge_sha` metadata | worker/integrator |
| lease holder | `lease_host` + `lease_pid` metadata | worker |
| PR linkage | `pr` metadata, comma-separated for several PRs | worker/integrator |
| rationale | description and notes, never labels/metadata | any |
| requirements | `--spec-id` plus `discovered-from` dependencies | creator |

ROUTING
DEFAULT Workers poll `bd ready --label agent:<kind> --unassigned --json` and
  claim what they take; labels route by kind and assignee pins the instance.
MUST Orchestrators set routing labels and `execution_*` metadata at creation;
  model and effort are fixed at spawn.
NOT Use labels as locks or gate substitutes. Gate beads and `bd gate check`
  own blocking waits; `bd set-state` is non-blocking.

REPORTING TO THE USER
Semantic event and report requirements live in `rule://beads-audit`; use that rule instead of duplicating its output contract here.


DEPENDENCIES
DEFAULT Use `blocks` for ordering and `parent-child` for epics; use
  `discovered-from` for follow-up work found mid-task. `related` and `tracks`
  are non-blocking.
MUST Model fan-in with an aggregate issue depending on each part, not comments.

WORKFLOW ROUTING
DEFAULT Read only the relevant contract:
- [Carriers]rule://beads-carriers
- [Lifecycle and gates]rule://beads-lifecycle
- [Semantic audit and reporting]rule://beads-audit
- [Formulas, molecules, bonds, and wisps]rule://beads-composition
- [Swarms and merge slots]rule://beads-coordination

JSON DETERMINISM
MUST Parsers set `BD_JSON_ENVELOPE=1` and read `.data`/`.error` plus
  `schema_version`; ad hoc readers may use bare `--json`.
DEFAULT Non-interactive contexts export `BD_NO_PAGER=1 BD_NON_INTERACTIVE=1`.

SYNC AUTHORITY
MUST Use the embedded `.beads` store pinned by the session lifecycle through `BEADS_DIR`; linked worktrees share that store and do not use an external Dolt server.
For persistence and migration details, read `skill://beads-storage-mode` when that skill is installed.

MAINTENANCE
DEFAULT Probe with `bd flatten --dry-run --json`, then escalate only with human
  direction: `bd purge`, age-bounded `bd prune`, and finally `bd flatten --force`
  when loss of history is accepted. Never wildcard-force-prune routinely.

SESSION CLOSE
MUST File remaining and discovered work as beads and close finished work with
  a factual `--reason`; lifecycle and held-claim reporting live in
  [rule://beads-lifecycle]rule://beads-lifecycle and the session extension.
SETUP -- see [rule://beads-setup]rule://beads-setup.
