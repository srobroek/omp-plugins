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
MUST Refuse claim, assign, close, or reopen on a live lease; comments remain available.
MUST Classify a held bead before touching it:
| state | evidence | action |
|---|---|---|
| live | the holder's agent is running or idle in `hub list`, or its job is running in `hub jobs`, or `orc_status.held` shows `worker … running` | refuse |
| worker ended | `orc_status.held` shows its worker ended `completed`/`failed`/`aborted`, or `hub jobs` shows the job settled with the bead still `in_progress` | release with a comment naming the ended worker |
| own | assignee is your actor (`omp/<session id>`) | release or restamp freely |
| unprovable | different host (`lease_host`), no anchors, no worker record | ask, or release with `force`/an explicit takeover comment only when a human or the run lead asked for recovery |
| closed | `status: closed` | never reassign; reopen is a separate decision |
DEFAULT `lease_pid` is the OMP process id; every subagent of one OMP process shares it, so `kill -0` only proves a *different* OMP process died. Never treat a live pid as proof that a specific subagent is alive.
MUST Release with show, update, then show: `bd show <id> --json` (record the assignee), then `BEADS_ACTOR='<actor>' BD_ACTOR='<actor>' bd update '<id>' --assignee '' --status open --set-metadata 'release_actor=<actor>' --set-metadata 'released_at=<UTC ISO>' --set-metadata 'released_from=<holder>'`. Run `bd show <id> --json` again. An assignee still present means a concurrent claim, so inspect rather than repeat. Add `--if-assignee '<holder>'` when `bd update --help` lists it.
MUST Record a release or takeover comment (`bd comments add <id> -m …`) naming the evidence before the update.

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
MUST In prose, immediately follow every Beads ID with a brief parenthetical
  description. For example: `chezmoi-l3ig (find-tools routes discovery
  incorrectly)`. Keep the brief description on every mention, including when an
  expanded description has already been given.
MUST When prose specifically references a Beads ID as the subject of a statement or
  question, or as the conversation's main topic, give one expanded description
  at that point covering its scope and current status, plus its relevance. Do
  not repeat that expanded description while the same subject remains active.
  Reset the one-time expanded-description rule only after the conversation
  subject changes away from that bead and later returns to it.
MUST Label unavailable metadata as unavailable. NEVER infer unavailable metadata.
MUST Give every table containing Beads IDs a separate Description column and
  populate it with each ID's brief parenthetical description; do not use a pure-ID
  table as a substitute.
MUST Give a bead an id, title, and one clause saying what it relates to:
  project area, producing work, or blocked work. Bare ids and titles are not a
  useful open-work report.
MUST Report your beads first, then others in a separate section naming each
  holder and whether its lease is live.
DEFAULT Keep agent-to-agent reports terse while retaining the required brief
  description and relation clause; use the [reporter contract]rule://beads-audit
  for machine-readable detail.

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
