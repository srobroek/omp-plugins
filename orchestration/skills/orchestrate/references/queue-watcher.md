# Release queue watcher handoff

Orchestrate's side of the watcher handoff. `release-queue-watch` owns the sensor
itself: start mechanics, record shapes, transition semantics, and `lifecycleKey`
are defined once in its `references/runtime.md`. Read that for the emitter
contract; this file covers only what orchestrate does with a record.

Orchestrate resolves its own nodes first; a record without an orchestrate owner
may route once to `pr-shepherd`.

## Start and ownership boundary

Start the watcher as `release-queue-watch` documents, with `--slots=1`. Consume
records serially; do not read the next line until the current receipt is durable.
One watcher slot limits outstanding readiness notifications. It is not the Beads
merge lock.

| Concern | Owner |
|---|---|
| Signature verification, debounce, PR ranking, REST repair | `release-queue-watch` |
| Orchestrate node lookup and agent assignment | orchestrator |
| Unmatched generic merge-bead lookup | `pr-shepherd` resolver |
| Orchestrate PR/head revalidation | integration shepherd |
| Generic PR/head revalidation | PR shepherd |
| Exclusive integration lock | `bd merge-slot` held by the selected integrator |

An exact active orchestrate node owns its PR. If the run also creates an
`agent:integrator` merge bead, stamp `integration_owner=orchestrate`; the
generic shepherd refuses it. This precedence prevents two merge actors from
racing.

## Record identity

`release-queue-watch`'s `references/runtime.md` defines the `dispatch` and
`pr-lifecycle` shapes, the five transitions, and `lifecycleKey`. Orchestrate adds
only this: a dispatch's identity is `repository#number@headSha`, and readiness
admission is not authorization to merge.

## Deterministic routing

For every line:

1. Snapshot active run nodes:

   ```text
   bd list --label orc-node --parent <epic> --status in_progress --json
   ```

2. Call `resolve-queue-dispatch.py --nodes-file <snapshot>`. Despite its stable
   filename, the resolver validates both dispatch and lifecycle records.
3. An exact orchestrate match owns the record. Resolver exit 2 means no
   orchestrate owner; offer the unchanged line once to pr-shepherd's
   `resolve-queue-event.py` with an active merge-bead snapshot.
4. Exit 3 means ambiguous or invalid orchestrate ownership and must not fall
   through. Control records are ignored. Malformed, stale, or ambiguous records
   produce `orc.note` and no assignment. Never fan one line to both consumers.

## Ready dispatch receipts

The resolver requires exactly one `state:approved` node matching `repo`, `pr`,
and `head_sha`.

1. Apply all `requiredMetadata` in one `bd update`. A new dispatch atomically
   stamps `queue_dispatch` and `queue_dispatch_pending`.
2. Send the persistent shepherd:

   ```text
   APPROVE <node>
   branch: <metadata.branch>
   base: <metadata.base_sha>
   source: release-queue-watch
   repo: <repository>
   pr: <number>
   head: <headSha>
   dispatch: <identity-key>
   ```

3. After SendMessage accepts the handoff, stamp
   `queue_dispatch_sent=<identity-key>`. The shepherd validates the matching
   pending or sent receipt and stamps `queue_dispatch_ack=<identity-key>` before
   authoritative revalidation.
4. `status=replay` reuses pending or sent receipts. Apply an emitted legacy
   normalization first. `status=duplicate` has a matching ack and is not sent.

Pending, sent, and ack are monotonic receipts. A late sent update must not erase
an ack. Every receipt present for the current dispatch must contain its exact
identity key. Do not replace an unacknowledged dispatch with a later record;
the resolver exits 3 on crossed or mismatched receipts. Acknowledgment records
delivery, not merge permission.

## Lifecycle receipts

Lifecycle resolution matches one active orchestrate node by `repo` and `pr`.
A head mismatch is reported as `headChanged`; it is never trusted as the new
anchor until the shepherd confirms GitHub.

- Approved nodes and `failed`, `merged`, or `closed` transitions set
  `wakeShepherd=true`. Persist `queue_lifecycle`,
  `queue_lifecycle_transition`, `queue_lifecycle_head`, and
  `queue_lifecycle_pending` atomically, then send:

  ```text
  APPROVE <node>
  branch: <metadata.branch>
  base: <metadata.base_sha>
  source: release-queue-watch-lifecycle
  repo: <repository>
  pr: <number>
  head: <headSha>
  transition: <transition>
  lifecycle: <lifecycleKey>
  ```

  Stamp `queue_lifecycle_sent` after SendMessage. The shepherd stamps
  `queue_lifecycle_ack` only after it revalidates and records the outcome.
- `opened` or `updated` on an unapproved node is informational. Persist the
  resolver's atomic `queue_lifecycle_ack`; do not wake a merge actor.
- A stale failure is a no-op after revalidation. Confirmed failure routes back
  to the architect. For a confirmed external merge, the approved head must still
  equal GitHub's head; the shepherd passes the actual merge SHA to N7's
  `verify-landed` transaction and closes only after final-base ancestry or
  exact-content proof. Confirmed close-without-merge is reported to the
  orchestrator; it is not silently treated as merged.
- A lifecycle wake-up never acquires the merge slot or merges. A separate valid
  dispatch is required to enter the watcher-backed merge path. Even when the
  node already stores an older dispatch, finish and acknowledge the lifecycle
  handling without entering `land`; resume the dispatch in its own pass.

## Crash recovery and fallback

Before reading new watcher output on start or resume, run:

```text
resolve-queue-dispatch.py --nodes-file <snapshot> --replay-unacknowledged
```

Replay the returned `dispatches` and `lifecycles` after applying any non-empty
`requiredMetadata`. Invalid persisted identity stops that replay; log it rather
than guessing. A current key with a receipt for another key, or a new record
arriving before the current key is acknowledged, is invalid ownership state.
Shepherd startup also resumes acknowledged approved nodes that have not
merged.

REST reconciliation belongs to the watcher. Initial reconciliation may emit
records before `watcher-active`. On `webhook-error`, `reconcile-error`, malformed
output, or watcher exit, surface the error and run one explicit `bd gate check`
plus the existing shepherd/shepherd pass. Restart or stop the watcher; never
start a duplicate CI polling loop and never infer green or merged state from
silence.

Stop the watcher during run cleanup.
