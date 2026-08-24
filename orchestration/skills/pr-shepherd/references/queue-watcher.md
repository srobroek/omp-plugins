# Event-driven queue handoff

The shepherd's side of the watcher handoff. `release-queue-watch` owns the sensor
itself: start mechanics, record shapes, transition semantics, and `lifecycleKey`
are defined once in its `references/runtime.md`. Read that for the emitter
contract; this file covers only what the shepherd does with a record.

The shepherd is the only *generic* merge consumer. An orchestrate run's own
integration shepherd owns that run's PRs; see orchestrate's `queue-watcher.md`
for the run-scoped side of the same precedence rule. The shepherd still
revalidates GitHub, uses Beads gates, probes conflicts, and acquires the
rig's merge slot (keyed on the Beads issue prefix, not the repository).

## Ownership and routing

Start the watcher as `release-queue-watch` documents, with one notification slot.
Process records serially and do not read the next line until the current receipt
is persisted.

An exact active `orchestrate` node owns its PR, and the orchestrator resolves the
record first; only an unmatched record reaches the shepherd resolver. If a
corresponding merge bead exists, stamp `integration_owner=orchestrate` so a
standalone consumer also refuses it. This precedence prevents a gatekeeper and
shepherd from racing to merge the same PR.

| Watcher record | Shepherd action |
|---|---|
| `dispatch` | Target the matching merge bead and run a fresh probe. Readiness is not merge authority. |
| `pr-lifecycle` | Target the matching merge bead and revalidate the observed transition. |
| `watcher-active` | Control record; no shepherd pass. |
| `webhook-error` / `reconcile-error` / watcher exit | Surface the error, run one explicit fallback pass, then restart or stop. Never infer state from silence. |

## Resolve and receipt protocol

Snapshot active merge beads:

```text
bd list --label agent:integrator --status open,in_progress,blocked --json
```

Pass each watcher line and snapshot to:

```text
scripts/resolve-queue-event.py --beads-file <snapshot>
```

The resolver validates the record and requires exactly one active
`agent:integrator` bead with matching `metadata.repo` and `metadata.pr`.
Dispatches also reject a mismatch with an existing `metadata.head_sha` anchor.
Lifecycle head changes are wake-ups only; GitHub revalidation decides whether
the observed head is current.

Handle the result as follows:

1. `status=resolved` -- apply every `requiredMetadata` field in one `bd update`.
   This creates `shepherd_event` plus `shepherd_event_pending` before handoff.
2. Start the targeted shepherd pass, then stamp
   `shepherd_event_sent=<eventKey>`. The pass claims the exact bead before any
   mutation. A claim refusal leaves the event unacknowledged for replay.
3. Revalidate the PR, follow the normal decision table, and comment the outcome.
   After that durable outcome, stamp `shepherd_event_ack=<eventKey>`. A bead
   closed by the outcome needs no separate ack.
4. `status=replay` -- apply any emitted metadata, refresh the bead, and replay
   only a pending or sent event. `status=duplicate` already has a matching ack.
5. `status=ignored` -- do nothing. `reason=orchestrate-owned` must stay with the
   orchestrator. Invalid, stale, unmatched, or ambiguous records are logged and
   never guessed.

At process start or after a crash, reconstruct unfinished handoffs before
reading new watcher output:

```text
resolve-queue-event.py --beads-file <snapshot> --replay-unacknowledged
```

Pending, sent, and ack are monotonic receipts. A caller must not overwrite a
newer receipt with an older one.

## Targeted pass decisions

Every event is followed by an authoritative `merge-probe.sh pr` call and, when
needed, the conflict probe. `opened`, `updated`, and `dispatch` use the regular
merge/wait/bounce decision table. `failed` is bounced only when the fresh probe
still reports failure. `merged` closes the merge bead only after GitHub reports
the PR merged. `closed` closes the merge bead as cancelled only after GitHub
reports closed without merge. A stale terminal event becomes a commented no-op.

After the target, the same invocation may drain other ready merge beads. It
must not poll pending checks. REST reconciliation belongs to the watcher; a
manual or scheduled `bd gate check` plus one stateless shepherd pass remains the
recovery path when no watcher is running.

The skill and agent are authored once under `.apm/`; APM generates equivalent
Claude Code and Codex plugin artifacts from those sources.
