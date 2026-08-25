---
name: beads-core
description: "Core bd contract: claiming, field taxonomy, routing, dependencies, sync authority, JSONL-over-git fallback, and database maintenance. Read when tracking work in a repo that has .beads/."
---

# Beads (bd)

SCOPE
MUST Use bd for all task tracking when the repo has `.beads/` (`bd where`
  succeeds); do not use TaskCreate or markdown task lists.
DEFAULT SpecKit artifacts (spec.md/plan.md) stay the source for WHAT to build;
  beads tracks execution state, not requirements.

MEMORY
DEFAULT `bd remember "insight" --key <slug>` for repo-scoped durable facts any
  agent or tool must see (gotchas, conventions, decisions). `bd prime` injects
  every memory verbatim each session, so keep the set ≤30.
MUST Route each captured lesson by what it lands on:

| the memory is | verb |
|---|---|
| wrong | `bd remember --key <k>` -- the same key updates in place |
| obsolete | `bd forget <k>` |
| neither | a new key |

MUST Where a recalled memory contradicts what you observe, suspect the memory.
DEFAULT Epic-scoped `<epic>-*` keys perish fastest, and a run reviews them at
  run end.
DEFAULT MemPalace keeps cross-session semantic recall; user/global knowledge
  stays in Claude auto-memory.

IDENTITY
MUST Set BEADS_ACTOR (`<harness>/<agent-name>/<session-id>`) on every mutating
  command when acting as a subagent -- the session id distinguishes dead claims.
DEFAULT BD_ACTOR is legacy (Beads 1.1.0 commit trailer only); export the same
  value in both until the hook accepts BEADS_ACTOR.

CLAIMING
MUST Claim before working: `bd update <id> --claim` (atomic CAS; first wins,
  idempotent). Never claim via labels -- not atomic.
MUST Discover work with `bd ready --unassigned --json`; never pick up work
  assigned to another actor unless the parent hands you its id.
MUST On refusal, coordinate with holder; `bd unclaim --force` only after
  confirming the holding session is dead.
DEFAULT Release with `bd unclaim <id>`.

FIELD TAXONOMY
| purpose | mechanism | writer |
|---|---|---|
| lifecycle | status (open/in_progress/blocked/deferred/closed) | worker |
| ownership | assignee (atomic via `--claim`) | worker |
| urgency | priority 0 to 4 | orchestrator/user |
| work kind | type (bug/feature/task/epic/chore) | creator |
| bounce-back | fix bead `discovered-from` + `bd dep add` + comment; release | integrator |
| routing queue | label `agent:<name>` | orchestrator/formula |
| group dispatch | assignee = pool alias (`claim.pools`) | orchestrator |
| category | labels, lowercase-hyphenated, ≤10/repo | any |
| state cache | `bd set-state <id> dim=value --reason` | owning agent |
| execution hints | metadata `execution_*` (type, model, effort, group) | orchestrator, BEFORE spawn |
| git anchors | metadata (repo, branch, base_sha, worktree, pr, merge_sha) | worker/integrator |
| scope globs | metadata `scope` | orchestrator |
| dedupe keys | metadata (CVE, PR#, file:line) | finder skills |
| rationale | description + notes, never labels/metadata | any |
| requirements | `--spec-id` + `discovered-from` deps | creator |

ROUTING
DEFAULT Workers poll `bd ready --label agent:<kind> --unassigned --json` and
  `--claim` what they take; labels route by KIND, assignee pins INSTANCE.
MUST Orchestrators set routing labels and `execution_*` metadata at creation --
  model/effort are fixed at spawn, too late after delegation.
NOT Labels as locks or gate substitutes -- gate beads + `bd gate check` own
  blocking waits; `bd set-state` is non-blocking only.

DEPENDENCIES
DEFAULT `blocks` for ordering; `parent-child` for epics; `discovered-from` for
  follow-up work found mid-task; non-blocking types (`related`, `tracks`) never
  affect `bd ready`.
MUST Model fan-in with an aggregate issue depending on each part, not comments.

WORKFLOWS
DEFAULT Read only the relevant workflow contract:
- [Carriers: comments, decision beads, wisps, artifacts]rule://beads-carriers
- [Lifecycle and gates]rule://beads-lifecycle
- [Semantic audit and reporting]rule://beads-audit
- [Formulas, molecules, bonds, and wisps]rule://beads-composition
- [Swarms and merge slots]rule://beads-coordination
- [Orchestration doctrine: claim⟺contract, wisps, links, labels, gates]rule://beads-orchestration-doctrine

FINDINGS
DEFAULT Unactioned findings (audits, deferred items, failed checks) become beads
  via `bd create --discovered-from <active>`, one per finding, with machine keys
  (CVE, PR#, file:line) in metadata for dedupe.

JSON DETERMINISM
MUST Scripts and hooks parsing bd output set `BD_JSON_ENVELOPE=1` and read
  `.data` / `.error` + `schema_version`; agents reading ad hoc may use bare
  `--json`.
DEFAULT Non-interactive contexts export `BD_NO_PAGER=1 BD_NON_INTERACTIVE=1`.

SYNC
DEFAULT Local: no routine pull; one push at orchestrator handoff.
DEFAULT Cross-machine: one pull before fan-out, one push after updates.
NOT `bd import` of issues.jsonl by hand -- `bd dolt pull` is the sync path,
  and in a JSONL-over-git repo (below) the agent or the repo's own git hooks
  own both halves.
NOT Treating Dolt sync and the GitHub mirror as one thing: `bd dolt` moves the
  beads database between machines, `bd github` mirrors beads to GitHub issues.
  The containerized `dbd` wrapper injects credentials for the Dolt verbs only, so
  `bd github` runs on the host with `GITHUB_TOKEN` supplied per invocation.

SYNC (Dolt first, JSONL only as fallback)
MUST Prefer native sync. `bd dolt pull`/`push` moves Dolt commits; JSONL carries
  issue rows only -- no Dolt branches, commit history, or non-issue tables. Reach
  for JSONL only where the native path cannot run.
DEFAULT Auto-pull with `bd config set custom.dolt-auto-pull true` -- the "repo
  config" authority the rule above allows. Pull is read-only and cannot lose
  local work; bound it (`BEADS_SYNC_PULL_TIMEOUT`, default 60s) because an
  unreachable remote does not always fail fast.
DEFAULT Auto-push with `bd config set custom.dolt-auto-push true`. Acceptable to
  automate because what moves is task records, not source: a Dolt push writes
  only `refs/dolt/blobstore/`, touches no branch, and is additive.
DEFAULT One push per session, not per commit. An incremental push costs ~12s of
  which ~8s is process startup rather than transfer (measured: 12.2s incremental,
  8.1s for a no-op, against a 311 MB / 4354-commit database), so per-commit
  pushing made a ten-commit session pay two minutes for what one push covers.
  Pushes are additive and idempotent, so pushing once at the end loses nothing.
MUST Detach rather than block. A first push of a never-synced database uploads
  its whole history -- over 550s on that same repo -- and no session should wait
  on that.
MUST Close the feedback loop when detaching. A detached process cannot report to
  the session that spawned it, and a silently failed push is the worst outcome
  here: state looks published while sitting on one machine. The push writes its
  verdict to `.beads/last-push.log`, which the session-beads-lifecycle extension
  reports and consumes at the next session start.
DEFAULT Check before pushing: the probe is `git push --dry-run`, which runs the
  same pre-push path while transferring nothing. Three outcomes, and the
  difference matters -- goes through, rejected at pre-push, or no answer
  (unreachable/timeout: stay quiet and let the next session try, since advising a
  strategy change over a dropped network is worse than silence).
MUST Where a direct push does not go through, set `custom.bd-push-command` to a
  wrapper that runs bd with network access (`bd config set
  custom.bd-push-command dbd`). That key is the redirect; do not invent a second
  pusher path.
GOTCHA Git resolves the remote host BEFORE running pre-push hooks, so an
  unreachable URL yields no answer either way.
DEFAULT Prefer bd's own `export.auto` (throttled export after every write).
  `export.git-add: true` does not actually stage the file, and throttling lets
  export lag the database at the moment of commit -- stage `.beads/issues.jsonl`
  yourself when committing in a JSONL-over-git repo.
GOTCHA `bd config set export.auto true` appends a FLAT `export.auto:` key rather
  than nesting it under `export:`. The flat key does work: measured, it produced
  an identical `.beads/issues.jsonl` to a hand-nested block, while an
  unconfigured repository produced none. Note that `bd config get export.auto`
  reports `true` for either carrier, so it cannot tell you which one is in force.

JSONL OVER GIT (fallback where `bd dolt push` cannot run)
DEFAULT Off. Exists for repos where the native push cannot run -- it writes
  `refs/dolt/blobstore/` and needs credentials Dolt cannot prompt for. Note pull
  and push can differ: fetches may work where pushes do not.
MUST Opt in per repo with `bd config set custom.jsonl-git-sync true`, commit
  `.beads/issues.jsonl merge=union` to `.gitattributes`, and confirm the file is
  not git-ignored (a stealth `bd init` excludes `.beads/` via
  `.git/info/exclude`, which makes `git add` fail silently -- detect this and
  say so).
MUST Leave both halves to the repo's own git hooks or the agent; neither
  commits, so the agent's own commit carries the file.
DEFAULT Trust the importer's resolution: newer `updated_at` wins, ties keep
  local, comments/labels/dependencies merge, local-only beads are never deleted,
  and stale rows are skipped and reported. `union` deliberately leaves duplicate
  ids in the file for the importer to resolve.
NOT `--allow-stale` unless deliberately restoring an older snapshot -- it
  overwrites newer local state.
MUST On a stale-skip warning, commit a fresh export before pulling peer changes
  (advised by session-beads-lifecycle when the warning is visible in-session).

MAINTENANCE (trimming a grown database)
GOTCHA Deleting rows does not shrink storage. Commit history is the bulk: measured
  on a live repo, 207 beads occupied 311 MB of which the `bd export --all` payload
  was 2.8 MB, `.dolt/noms/` (every historical row version) 199 MB, and
  `.dolt/git-remote-cache/` 96 MB. 4354 Dolt commits produced that -- one per
  create/update/comment/close, never collected.
DEFAULT Judge size by COMMIT COUNT, not bead count. On that same repo `bd prune
  --older-than 90d` matched nothing (every closed bead was recent) while 4354
  commits sat underneath, so a prune-based threshold stays silent through the
  whole problem.
DEFAULT Order of escalation: `bd purge` (closed wisps, no value once closed) →
  `bd prune --older-than <N>` (closed regular beads) → `bd flatten --force` only
  when storage genuinely has to come back, accepting the loss of all history.
DEFAULT `bd flatten --dry-run --json` is the size probe: it reports
  `commit_count` and mutates nothing. `bd status --json` returns an empty summary
  and `bd vc status` gives a hash with no counts, so this is the only
  machine-readable signal.
DEFAULT Enable the reporting hook per repo with `bd config set
  custom.maintenance-check true` (threshold via
  `BEADS_MAINTENANCE_COMMIT_THRESHOLD`, default 2000). It reports and never acts.
NOT `bd prune --pattern '*' --force` as routine cleanup -- it sweeps every closed
  bead regardless of age, which is the handover record for recent work.

GITHUB MIRROR -- see [rule://beads-github-mirror]rule://beads-github-mirror
  for config keys, per-verb cost, and the label-overwrite constraint.

SESSION CLOSE (when beads were touched)
MUST File remaining and discovered work as beads, and close what is finished
  with a factual `--reason` -- the residual-context and gate obligations at
  close are in rule://beads-lifecycle, and held claims are reported
  by session-beads-lifecycle.
MUST Verify landed work by content per GW-3 (git-workflow steering).
DEFAULT Git commit/push follows delivery steering; sync per SYNC rules above.

SETUP -- see [rule://beads-setup]rule://beads-setup
