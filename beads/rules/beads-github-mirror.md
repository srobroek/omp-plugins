---
name: beads-github-mirror
description: Mirroring beads out to GitHub issues: config keys, per-verb cost, and the label-overwrite constraint.
globs: ["**/.beads/**"]
---

# Beads GitHub Mirror

Rules for repositories where beads mirror out to GitHub issues.

MUST Mirror with `bd github push <ids>`, never by hand-creating the issue --
  the push records the `External:` back-link on the bead, so a hand-made issue
  leaves the two unlinked. `--dry-run` first.
DEFAULT Supply credentials per invocation
  (`GITHUB_TOKEN="$(gh auth token)" GITHUB_REPOSITORY=<owner/repo> bd github
  push ...`) rather than `bd config set github.token`, which persists a PAT to
  disk in the repo's beads config.
MUST Expect mirrored issues to carry bd's OWN label scheme (`priority::medium`,
  `type::task`, `status::in_progress`), derived from bd's structured fields. A
  repo with its own vocabulary (`priority-p2`, `spec:NNN`, component labels)
  will not match, so mirrored issues drop out of every existing triage query
  while looking correctly filed.
NOT Hand-correcting those labels on GitHub -- `bd github push` REPLACES the whole
  label set from bd on every sync, so any manual fix is silently undone the next
  time that bead is pushed (verified 2026-07-20: labels applied via `gh api`
  were wiped by the next push, twice). `bd update` has no `--label` flag, so the
  scheme cannot be corrected from the bd side either.
DEFAULT Treat the mismatch as an upstream gap rather than per-issue toil: it
  needs configurable label mapping in bd itself. Until then, either accept the
  `::` scheme as the mirror's vocabulary and build triage queries that tolerate
  both, or keep mirrored issues out of label-driven workflows.

CONFIG
MUST Set `github.repo` to the BARE repository name. `owner/repo` there produces
  a 404 on every pull, because bd joins it to `github.owner` and requests
  `owner/owner/repo` -- and `bd github status` still reports
  `Status: ✓ Configured` while that happens, so the status check does not catch
  it (verified 2026-07-28).
MUST Set `github.owner`, not `github.org`. Only the former is read, so a
  workspace carrying just `github.org` reports `github.owner is not configured`
  even with a valid token.
DEFAULT `bd github status` is local-only (about half a second) and names the
  missing key, so gate automation on it before spending a network call.

COST
Pull and push differ by an order of magnitude, so pick the verb instead of
reaching for `sync`. Measured on a two-issue repo:

| verb | cost |
| --- | --- |
| `--push-only` | ~1s |
| `pull <ref>` | ~1.2s |
| `--pull-only` (all) | ~7.5s |

Repeat bulk pulls cost the same, because nothing about it is incremental. The
GitHub API is a fraction of that, so the expense is bd's own traversal.
MUST Pull by ref (`bd github pull <ref>`) when refreshing the issue a bead
  tracks. Bulk `--pull-only` is for a deliberate reconciliation, not a routine
  step.
DEFAULT Push at a handoff boundary, where publishing local bead state is the
  point, and where the direction is safe: a push cannot clobber local work.
NOT Any `bd github` verb on a per-tool-call hook. The cheapest is about 1s, an
  order of magnitude over the whole PreToolUse budget.
DEFAULT `task beads:{status,push,pull,pull-all,sync,preview}` wraps these with
  the token supplied per invocation. `beads:pull` refuses a bare call, so the
  slow path has to be named.
