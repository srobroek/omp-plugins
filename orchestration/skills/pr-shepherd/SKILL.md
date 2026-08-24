---
name: pr-shepherd
description: Drain the beads merge queue -- check gates, probe PRs, merge or bounce back. Use on /pr-shepherd, shepherd PRs, drain merge queue, or land ready PRs.
---

# PR Shepherd

Stateless cross-session pass over merge work stored in beads. Safe to run from
any session, a /loop, or cron; a killed run leaves only claims the next pass
skips or recovers per steering.

TRIGGER
+ /pr-shepherd, "shepherd the PRs", "drain the merge queue", "land ready PRs"
+ Stop-hook reminder reports ready merge beads or open GitHub gates
- Reviewing PR code quality → pr-reviewer agent
- Authoring or editing a PR → git-workflow steering; this skill discovers only
  ready, non-release PRs carried by a `pr:merge` bead

## Workflow

1. Gate: `bd where` and `command -v gh` both succeed, else report which is
   missing and stop. Export `BEADS_ACTOR="pr-shepherd/<runtime>/<session-id>"`,
   `BD_NO_PAGER=1 BD_NON_INTERACTIVE=1`.
2. Load durable PR nodes with `bd list --label pr:merge --status all --json`.
   Each open node must remain unassigned and carry repo+PR metadata. Ignore
   drafts for merge processing and ignore automated release PRs. Missing anchors
   or DAG mismatches are author-contract failures, not reasons to scan a bounded
   GitHub history. `skill://pr-shepherd/scripts/landing-contract.py check-anchors <merge-bead> <repo>
   <pr>` proves the bead's own `pr`, `repo`, and `branch` anchors describe the PR
   it names; `land` runs it before every merge. The PR body is not evidence: the
   bead is the carrier.
3. Before creation/approval, authors add `bd dep add <work> <merge-bead>` for
   each work bead the PR completes; one merge bead may block many work beads and
   one work bead may depend on many merge beads. `state:approved` freezes these
   edges; never mutate approved/closed work for a late closing edge.
4. `bd gate check` evaluates CI gates. Never attach a gh:pr gate to the merge
   bead: that gate resolves only after the merge this bead must perform.
5. `bd merge-slot create` (idempotent) so the repo's slot exists.
6. Drain loop: `bd ready --label agent:integrator --unassigned --json`; probe
   eligibility before claiming with `skill://pr-shepherd/scripts/merge-probe.sh eligibility`.
   Draft/release → ignore without mutation.
   `metadata.integration_owner` naming another actor (`orchestrate`) → ignore
   without mutation while that run is live; its own shepherd is mid-flight on this
   PR. The query filters by label only, so this check is what keeps the two merge
   actors apart. Take such a bead only once the run is terminal — that recovery is
   yours, an active merge is not.
   Otherwise `bd update <id> --claim`; on "already claimed" skip it.
7. Probe from the bead's metadata anchors `{pr, branch, base_sha, repo}`
   after `git fetch`:
   - `skill://pr-shepherd/scripts/merge-probe.sh pr <N>` → state, mergeable, reviewDecision,
     statusCheckRollup
   - `skill://pr-shepherd/scripts/merge-probe.sh conflicts origin/<base> origin/<branch>` →
     predicted conflict paths (exit 1 = conflicts)
   - `skill://pr-shepherd/scripts/bot-review-probe.py fetch <repo> <N>` piped to
     `classify <head-sha>` → review-bot round for that exact head
     (0 absent|clean · 10 pending · 11 stale · 12 actionable · 2 unknown).
     LOAD `skill://pr-shepherd/references/bot-review.md` before acting on anything but `absent`.
8. Decide (LOAD `skill://pr-shepherd/references/bounce-back.md` before any bounce):

| probe result | action |
|---|---|
| draft | ignore: no claim, gate, bounce, merge, or bead closure |
| automated release PR | ignore by branch/label product anchors; title is not an anchor |
| already merged | verify terminal-branch landing, close merge bead, then reconcile ready closing work |
| closed without merge | set merge bead `state:failed`, status blocked, comment; dependent work remains blocked |
| bot review pending | comment once, release the claim, continue; the next pass re-probes. Never poll it in-session |
| bot review stale | the bot reviewed an older head; treat as pending, never as clean |
| bot review actionable | bounce → agent:coder with the summary URL and the bot's comment paths (`skill://pr-shepherd/references/bot-review.md`) |
| clean + checks green + approved + bot review absent/clean | LOAD `skill://pr-shepherd/references/landing-contract.md`, then `skill://pr-shepherd/scripts/landing-contract.py land …`, which owns the whole transaction: merge slot under a stable holder, exact-head merge, landing proof, release, bead closure |
| enqueued in a GitHub merge queue (exit 10, `landing_state=queued`) | leave the bead open, release the claim; the next pass proves or bounces it. Never treat an enqueue as a landing |
| ejected from a GitHub merge queue (exit 12, `landing_state=ejected`) | bounce → agent:coder with the `QUEUE_EJECTED` receipt; the merge group failed |
| merge conflicts | bounce → agent:coder with the conflict file list |
| CI red | dedupe-check, then bounce → agent:coder with failing check names + `gh run view --log-failed` excerpt |
| changes requested | bounce → agent:coder with the review summary |
| explicit local gate | require an operator-approved receipt for this exact head, then run `skill://pr-shepherd/scripts/landing-contract.py land … local <operator-id> <receipt-file>`; only a completed zero-step failure with GitHub's billing annotation or `STARTUP_FAILURE` conclusion is admissible |
| not approved | comment once per observed state, release the claim, continue |
| checks pending | attach a gh:run gate only when a concrete run id exists; otherwise comment, release, continue |

9. After every claimed probe, `bd comments add <id>` the outcome: what was checked,
   what was found, disposition (merged / bounced / waiting-on-gate / skipped).
   The merge bead is the audit trail of every shepherd pass.
10. After closing a merge bead, query closing work through Beads dependencies,
    not manual PR counts. A work bead may close only when `bd ready` reports it,
    it has the exact `state:approved` label, children/gates are resolved, and
    every closing PR was verified on the repository default branch.
11. Repeat step 6 until nothing is claimable, then report; `bd dolt push` per
    beads steering when beads changed.

Running under `release-queue-watch` instead of a stateless poll? LOAD
`skill://pr-shepherd/references/queue-watcher.md` before handling any watcher record.

## Rules

MUST Hold the merge slot across acquire → merge → release; release on every
  exit path, including a failed `gh pr merge`; use one stable holder and pass
  it to both acquire and release. Beads 1.1 waiters are advisory, not FIFO.
MUST Ignore draft and automated release PRs before claim or merge-slot
  acquisition. Release detection uses branch prefix or autorelease label,
  never title text.
MUST Close a work bead only on its native dependency edge plus native
  readiness, the exact `state:approved` label, and verified terminal landing.
  PR prose authorizes nothing.
NOT A gh:pr gate on a merge bead; use dependency edges for landing fan-in and
  a concrete gh:run gate only for CI.
MUST Release the claim (`bd update <id> --assignee "" --status open`) whenever
  the bead is not closed this pass -- a parked claim starves other sessions.
MUST Never fix code, rebase, or resolve conflicts -- file a fix bead and bounce
  (`skill://pr-shepherd/references/bounce-back.md`); gates own the wait, not your session.
MUST Probe the review bot before every merge and treat `pending`, `stale`, or
  `unknown` as not-yet-mergeable. Silence is not approval: a completed bot check
  with no review at the exact head is a wait, never a pass.
NOT Judging bot findings yourself, quoting them into the fix bead, or merging
  because they look like nits -- the coder that owns the code decides which are
  correct and appropriate. You route, you never review.
MUST Comment the pass outcome on the merge bead even when no action was taken.
DEFAULT Merge method: repo convention (branch protection, CONTRIBUTING);
  squash when unstated.
NOT Claiming a bead assigned to another actor -- claim refusal IS the
  coordination; dead-claim recovery rules live in the pr-shepherd steering.
NOT Waiting in-session for CI or re-polling a pending PR -- release and let the
  next pass (or `bd gate check`) pick it up.

OUTPUT
L1 SHEPHERD PASS: merged M / bounced B / waiting W / skipped S -- then one line
   per bead: id, PR#, disposition, fix-bead id if filed.
CAP 150w clean · 300w with bounces
