---
name: beads-contention-retry
description: Treat embedded-store contention messages as contention, not failure, and retry the same command. Also governs how a failed remote sync is retried.
condition: ["a maintenance operation is running on this workspace: retry when it completes", "other bd commands are using this workspace: wait for them to finish and retry", "lock busy: held by another process", "lock already held by another process", "workspace gate busy"]
scope: ["text", "thinking"]
interruptMode: always
---

This is contention, not a failure. The embedded store is single-writer by design
and takes a cooperative gate that ordinary commands share and maintenance takes
exclusively, so a concurrent writer is the expected case, not a defect.

MUST wait briefly and retry the same command, up to three attempts, then report
what still failed. NEVER escalate it, NEVER report the run as blocked on it, and
NEVER work around it. Agents MUST NOT build their own serialization, wrapper,
mutex, or retry helper; the shipped embedded-write lock already serializes writes.
Nothing about the store needs changing.

NEVER treat `warning: workspace gate unavailable, continuing ungated` or
`warning: workspace gate acquisition failed, continuing ungated` as contention.
Those commands RAN; retrying repeats work that already happened.

A message not on this list is a different problem: report it verbatim rather than
retrying it, so whatever it actually is gets seen.

## Remote sync

`bd dolt pull` and `bd dolt push` are persistence, never a mutex. Never use a sync
to serialise writers; contention is handled above.

MUST bound each `bd dolt pull` or `bd dolt push` attempt to 180 seconds (or a
shorter caller deadline), then retry the same command up to three attempts with
a brief wait. A killed or timed-out attempt is reported verbatim as the failed
attempt; do not assume the remote state until a subsequent retry completes.
A sync that fails three times is reported, not worked around: NEVER fall back to
a manual `dolt` invocation, NEVER start a server, and NEVER continue as though
the remote were current.
After the retry sequence, MUST re-run `bd dolt pull` before trusting a read that
decides work assignment, because a partially applied sync leaves reads stale.

## Remote-sync diagnosis and probe

The observed multi-minute stalls are in the Dolt remote/conjoin path, not the
embedded writer lock: the lock deliberately excludes `bd dolt push` from its
serialized operation set, so waiting for that lock cannot make a push complete.
The local-file-remote probe below reproduced the important failure boundary and
established the recovery invariant without depending on a hosted service:

- A scratch embedded ledger was configured with `file:///private/tmp/omp-g3dl-remote-w2`.
- With a pending issue, a `bd dolt push` child was terminated with `SIGTERM`; the
  exact observed result was `exit=-15`, with empty stdout and stderr.
- Retrying the same `bd dolt push` completed with `Push complete.`
- A fresh Dolt clone of that remote, followed by `dolt pull origin main`, showed
  both `probe-bgl | consistency probe` and `probe-r74 | retry consistency probe`.

Therefore a killed or timed-out push leaves the remote state unknown until the
same command succeeds on retry; after success, a fresh clone is the consistency
check. This is a probe result, not a claim that every hosted-remote stall has
the same transport-level cause.

The conditions above match observed contention text only. No `bd dolt` failure
text is matched here, because none has been observed in this project; the sync
policy is therefore prose the agent applies after reading the command's own
output, not a pattern this rule claims to detect.
