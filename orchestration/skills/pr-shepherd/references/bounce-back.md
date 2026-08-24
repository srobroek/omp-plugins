# Bounce-back protocol

Bounce a CI failure, conflict, requested change, or merge-queue ejection behind
one routed fix bead. The fix bead is always unassigned. Its routing label is
`agent:coder` or `agent:reviewer`.

## Failure identity

Generate `failure_key` with the executable contract:

```bash
scripts/landing-contract.py failure-key <repo> ci <check-name>
scripts/landing-contract.py failure-key <repo> conflict <sorted-path>...
scripts/landing-contract.py failure-key <repo> review <review-thread-or-summary-id>
scripts/landing-contract.py failure-key <repo> queue <landing-base> <ejected-head-sha>
```

Conflict paths must use the sorted order emitted by `merge-probe.sh`. The key
binds repository, failure kind, and exact detail. The same key deduplicates
sequential passes. A concurrent creation race keeps the oldest open fix bead
and closes the later bead as its duplicate.

## Diagnosis

The fix description contains:

- failing check names and up to 30 relevant log lines, conflict paths, or the
  review summary;
- a reproduction command;
- `Read <origin_bead>'s comments first` when an origin bead exists;
- `failure appears pre-existing on <base>, not introduced by this branch`
  when the same check fails on the landing base;
- no credentials, full logs, or machine-local handover paths.

Metadata contains `repo`, `pr`, `branch`, `failure`, the check or conflict
paths, and known `origin_actor`/`origin_bead` pointers. The contract adds
`failure_key`.

## Park once

Run:

```bash
scripts/landing-contract.py ensure-bounce \
  <merge-bead> <failure-key> <agent:coder|agent:reviewer> \
  <title> <metadata-json> <description>
```

The command reconciles these durable steps:

1. Stamp `bounce_key` and `bounce_phase=preparing` before creation.
2. Search every non-closed coder/reviewer fix bead with the same key.
3. Create an unassigned fix bead only when no match exists; reconcile concurrent
   and pre-existing duplicates to the oldest open bead, closing every extra.
4. Stamp canonical `bounce_fix` and `bounce_phase=fix_ready`.
5. Add the blocking dependency once, then stamp `bounce_phase=parked`.
6. Correlate both beads with stable `bounce_receipt=<failure-key>` markers,
   then stamp `bounce_phase=commented`.
7. Release the merge-bead claim and stamp `bounce_phase=complete`.

A repeated invocation reports `BOUNCE_REUSED` without creating another bead or
dependency. If a write fails or the process dies, rerun the same command: it
reconciles the canonical bead, duplicate set, dependency, marker-bearing
comments, and released claim from the last phase. Closing the fix bead
re-readies every dependent merge bead.

Warm-context routing belongs to an orchestrator. The standalone contract ends
after creating or reusing the unassigned fix bead. Non-blocking observations
remain comments or `related` dependencies.
