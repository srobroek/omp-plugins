---
name: beads-core
description: "Core bd contract: claiming, field taxonomy, routing, dependencies, sync authority, JSONL-over-git fallback, and database maintenance. Read when tracking work in a repo with .beads/."
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
MUST Claim before working with `bd update <id> --claim` (atomic CAS; first wins,
  idempotent). Never claim through labels.
MUST Discover work with `bd ready --unassigned --json`. Open and unassigned is
  self-serve; a live lease is not.
MUST Work only beads you own or that a parent, handover, or user names. Your
  session id in the assignee identifies ownership after resume or recovery.
MUST Refuse claim, assign, close, or reopen on another session's live lease;
  comments remain available.
MUST Prove a lease dead before taking it. Read `lease_host` and `lease_pid`,
  then on that host confirm `kill -0 <pid>` fails. A different host or missing
  anchors is unprovable: ask instead of taking it.
MUST Record a takeover comment naming the dead lease before claiming.
MUST Re-stamp your own anchors when resuming an earlier session:
  `bd update <id> --set-metadata lease_host=... --set-metadata lease_pid=...`.
DEFAULT `bd-lease-gate` stamps anchors after a successful claim; restamp by hand
  if it reports a failure.
DEFAULT Release with `bd update <id> --assignee '' --status open`.

FIELD TAXONOMY
| purpose | mechanism | writer |
|---|---|---|
| lifecycle | status (`open`, `in_progress`, `blocked`, `deferred`, `closed`) | worker |
| ownership | assignee (atomic via `--claim`) | worker |
| urgency | priority 0–4 | orchestrator/user |
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
MUST Give a bead an id, title, and one clause saying what it relates to:
  project area, producing work, or blocked work. Bare ids and titles are not a
  useful open-work report.
MUST Report your beads first, then others in a separate section naming each
  holder and whether its lease is live.
DEFAULT Pure id tables, counts, and prose that already explains a single bead
  may omit the relation clause. Keep agent-to-agent reports terse; use the
  [reporter contract]rule://beads-audit for machine-readable detail.

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
DEFAULT Do not routinely pull a local store; use one authority-aware push at
  orchestrator handoff. Cross-machine work uses one pull before fan-out and one
  push after durable updates at handoff.
MUST Prefer native `bd dolt pull`/`push`. These move the Dolt database, while
  `bd github` mirrors issues to GitHub and is a separate authority.
MUST Treat `issues.jsonl` as a fallback only where native Dolt sync cannot run;
  it carries issue rows, not Dolt branches, history, or other tables.
MUST Configure JSONL-over-git with `custom.jsonl-git-sync`, commit
  `.beads/issues.jsonl merge=union` in `.gitattributes`, and verify it is not
  ignored. Repository hooks or the agent own the commit.
NOT Use `bd import` as routine synchronization. Import is a restore operation;
  deliberate restores must name the snapshot and why it is authoritative.
MUST When authority is absent, record pending sync and report the exact command
  instead of running it. Lifecycle hooks must not pull or push.

MAINTENANCE
DEFAULT Probe with `bd flatten --dry-run --json`, then escalate only with human
  direction: `bd purge`, age-bounded `bd prune`, and finally `bd flatten --force`
  when loss of history is accepted. Never wildcard-force-prune routinely.

SESSION CLOSE
MUST File remaining and discovered work as beads and close finished work with
  a factual `--reason`; lifecycle and held-claim reporting live in
  [rule://beads-lifecycle]rule://beads-lifecycle and the session extension.
SETUP -- see [rule://beads-setup]rule://beads-setup.
