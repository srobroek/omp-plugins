# Landing contract

`scripts/landing-contract.py` is the executable boundary shared by standalone
shepherds and orchestration adapters. Callers supply durable identity; the
script owns live GitHub checks, queue order, exact-head merge, proof, and
recovery writes.

## Durable identity

| Key | Meaning |
|---|---|
| `repo` | GitHub `owner/name` |
| `pr` | Pull request number |
| `branch` | Author branch |
| `pr_base` | Current GitHub target branch, including a stack parent |
| `landing_base` | Branch on which final landing must be proved |
| `base_sha` | Recorded landing-base commit used for content proof |
| `head_sha` | Exact reviewed and tested PR head |
| `merge_sha` | GitHub merge commit, stamped immediately after merge |

A `gh:run` gate stores its run id and the same `head_sha`. Gate resolution is
advisory; run `scripts/landing-contract.py` with no arguments for the exact
argument shape of every subcommand (`check-run`, `check-pr`, `land`,
`acquire-slot`/`release-slot`, `queue-state`, `recover-*`, `ready-ids`).

## Landing states

`landing_state` on the merge bead is the resume point for every later pass.

| State | Meaning | Next pass |
|---|---|---|
| `merged` | GitHub merged the PR; final-base proof not yet stamped | Prove, then stamp `proved` |
| `waiting_base` | Stacked merge reached `pr_base` only | Prove ancestry or content on `landing_base` |
| `queued` | The GitHub merge queue accepted the PR; no merge commit exists | Prove if merged, bounce if ejected |
| `ejected` | The merge queue dropped the PR without merging | Bounce with the recorded evidence |
| `proved` | Exact proof passed on `landing_base` | Terminal; the merge bead closes |

`check-pr` reads current PR state directly. Approval mode is `github` by
default. An orchestrated adapter may pass `external` only after a durable
independent approval names the exact head. Both modes reject requested changes.

The explicit `local` mode admits a red GitHub check only with an operator id
and a receipt file:

```bash
scripts/landing-contract.py check-pr <repo> <pr> <head-sha> <pr-base> \
  local <operator-id> <receipt-file>
```

The receipt uses schema `pr-shepherd/local-gate-v1` and contains these fields:

| Key | Required value | Meaning |
|---|---|---|
| `schema` | `pr-shepherd/local-gate-v1` | Receipt format identifier |
| `head_sha` | Exact `head-sha` argument | Reviewed PR head |
| `operator_authorized` | `true` | Explicit operator authorization is present |
| `authorization` | `operator-approved` | Authorization marker |
| `authorized_by` | Exact `<operator-id>` argument | Authorized operator identity |
| `local_gate` | `passed` | Local gate result |
| `evidence_ref` | Non-empty string | Recorded local gate evidence reference |
| `run_id` | Positive integer | GitHub Actions run to classify |
| `failure_class` | `github_billing_zero_steps` or `github_startup_zero_steps` | Permitted remote failure class |

Before admitting the PR, the contract requires:

- The referenced GitHub run has the exact reviewed head.
- The run is a completed billing or startup failure with zero executed steps.
- A billing failure has at least one failed job whose `.github` check annotation
  says GitHub did not start the job because of failed payments or the spending limit.
- Other jobs in a billing failure are failed with that annotation or skipped.
- A startup failure uses GitHub's `STARTUP_FAILURE` conclusion.
- Every red PR check links to the receipt run or another run at the exact head
  that independently satisfies the same billing or startup classification.
- Cancelled, timed-out, action-required, successful, or executed-step runs reject.
- Stale identity, missing authorization, malformed receipt, review failure, or
  merge conflict rejects.

`land` accepts the same `local <operator-id> <receipt-file>` suffix. Before
merging, it records the local mode, operator, run, failure class, evidence
reference, reviewed head, and receipt digest on the merge bead.

## Exit contract

| Exit | Meaning | Caller action |
|---:|---|---|
| 0 | Exact proof passed | Continue or close as reported |
| 2 | Unknown, malformed, or unavailable evidence, including an undetectable merge queue | Comment, release claim, report |
| 10 | Pending, stacked merge not yet on final base, or enqueued in the GitHub merge queue | Preserve gate/hold, release claim |
| 11 | Stale SHA or PR-base identity | Keep gate open, release claim |
| 12 | Failed check, conflict, merge-queue ejection, or foreign slot owner | Bounce or report contention |
| 75 | Slot not acquired without violating persisted order | Release claim; retry later |

Exit 75 is Beads merge-slot contention only; a GitHub merge queue never returns it.

## Landing transaction

`land` (see `scripts/landing-contract.py` usage for its exact arguments)
performs the transaction:

1. Creates the rig's merge slot (keyed on the Beads issue prefix, shared by
   every repo and worktree on that prefix) and acquires under stable identity
   `pr-shepherd:<repo>#<pr>@<head_sha>` without bypassing earlier waiters.
2. Re-reads PR state, exact head, `pr_base`, checks, and required approval.
3. Fetches and probes the live `pr_base`, not the final landing branch.
4. Calls `gh pr merge --match-head-commit <head_sha>` with the selected method.
   A head change between the read and merge is an atomic rejection.
5. Re-reads GitHub. A `MERGED` state persists `head_sha`, `merge_sha`,
   `pr_base`, `landing_base`, and `landing_state=merged` before final proof. A
   still-open PR at the same head goes to the merge-queue branch below.
6. Proves the merge commit is on the live `landing_base`, or proves every path
   changed from `base_sha` to `head_sha` has exact Git tree content there.
7. Stamps `landing_state=proved`, comments the proof, releases the slot, and
   closes the merge bead only after release succeeds.

For a stacked PR, GitHub may report `MERGED` when only `pr_base` contains it.
The contract persists `landing_state=waiting_base`, returns 10, and leaves the
bead open. A later pass reuses the merge receipt and closes only when ancestry
or exact content proves that the change reached `landing_base`. Content proof
also handles a later squash that replaces the intermediate merge commit.

## GitHub merge queue

On a queue-enabled base, a successful `gh pr merge` enqueues the PR: no merge
commit exists and the head is not on `landing_base`. The contract detects that
case at step 5, when the merge call succeeded and the PR is still open at the
expected head. Detection reads the GraphQL fields `isMergeQueueEnabled`,
`isInMergeQueue`, and `mergeQueueEntry`, cached per run. REST branch protection
carries no merge-queue field, so it cannot answer the question.

An enqueued PR persists `head_sha`, `queue_entry_head`, and
`landing_state=queued`, comments an `ENQUEUED` receipt, returns 10, releases the
Beads slot, and leaves the bead open. It never stamps `merged` or `proved`,
because a failing merge group can still eject it.

A later `land` pass on a `queued` bead reuses the ancestry-or-content proof and
never calls `gh pr merge` again. It runs outside the Beads merge slot, since
GitHub serializes the landing.

| Later observation | Result |
|---|---|
| PR `MERGED` | Prove on `landing_base`, stamp `proved`, close the bead, exit 0 |
| Still in the queue | Report position and entry state, exit 10 |
| Gone from the queue and not merged | Persist `landing_state=ejected`, comment a `QUEUE_EJECTED` receipt, exit 12 |

The ejection receipt names the PR, `landing_base`, `head_sha`, live PR state,
`entry=absent`, and `prior_state=queued`.

A failed detection probe prints `QUEUE_DETECT_FAILED` on stderr, treats the base
as non-queue, and exits 2 rather than stamping a landing. `queue-state <repo>
<pr>` reports the same facts on demand: `QUEUE_ABSENT`, `QUEUE_PRESENT`, or
`QUEUE_UNKNOWN`.

## Persisted queue and recovery

The contract creates one active deterministic generation for each stable
holder and labels it `gt:slot-waiter`. Metadata binds the slot id, holder,
generation, waiter id, and exact `BEADS_ACTOR`. An explicit `parent-child`
dependency links the waiter to the slot. If creation crashes before linking, a
restart adds and verifies the missing dependency. A wrong parent, duplicate
parent, malformed identity, or unlinked queue record fails closed.

Open and claimed valid records form the queue. Eligibility is the first record
by `created_at`, then id. The leased actor claims the record and rechecks
priority before calling atomic `bd merge-slot acquire`. The native holder token
binds the queue holder, generation, waiter id, and actor lease. A foreign actor
using the same queue holder is rejected before slot entry. The script never
calls `acquire --wait` and never rewrites a shared waiter collection.

Pending, stacked, and other exit-10 outcomes release the native slot while
keeping the same generation open and unassigned for its leased actor. Terminal
merged, enqueued, cancelled, bounced, or dead work closes only that generation.
An enqueued PR is terminal for this slot because GitHub serializes it. A later
attempt for the same terminal holder must pass `requeue`, which creates the
next deterministic generation. A new head naturally has a new stable holder.

The explicit controls are `acquire-slot` and `release-slot` (see usage for
arguments).

Do not delete a quiet receipt. After proving a session dead or a PR cancelled,
cite the evidence and use the matching recovery command: `recover-claim`,
`recover-slot`, or `recover-waiter` (see usage for arguments).

- Each command refuses unsafe changed ownership and records a comment plus audit event.
- With `waiter-holder`, claim recovery releases only the dead generation's native holder token.
- Claim recovery closes the dead generation and lets one successor atomically acquire a fresh generation.
- A delayed competitor cannot release the successor token or replace its waiter and recovery receipt.
- Waiter recovery finds and closes the current open generation and never mutates another queue entry.
- If a process died after GitHub merged, rerunning `land` resumes from the remote merge receipt and repeats final-base proof without another merge attempt.

Recovery itself is restartable. Before changing a claim, holder, or waiter, the
command stores a deterministic `recovery_key` and `recovery_phase=prepared`.
It advances through `mutated`, `commented`, `audited`, and `complete`. Stable
markers in Beads comments and the audit log let a retry finish a partially
written recovery without repeating the mutation, comment, or audit event.
