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

MUST retry a failed `bd dolt pull` or `bd dolt push` up to three attempts with a
brief wait, then report the verbatim failure. A sync that fails three times is
reported, not worked around: NEVER fall back to a manual `dolt` invocation, NEVER
start a server, and NEVER continue as though the remote were current.

MUST re-run `bd dolt pull` before trusting a read that decides work assignment
after any retry sequence, because a partially applied sync leaves reads stale.

The conditions above match observed contention text only. No `bd dolt` failure
text is matched here, because none has been observed in this project; the sync
policy is therefore prose the agent applies after reading the command's own
output, not a pattern this rule claims to detect.
