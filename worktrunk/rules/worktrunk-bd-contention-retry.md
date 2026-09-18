---
name: worktrunk-bd-contention-retry
condition: ["a maintenance operation is running on this workspace: retry when it completes", "other bd commands are using this workspace: wait for them to finish and retry", "lock busy: held by another process", "lock already held by another process", "workspace gate busy"]
scope: ["text", "thinking"]
interruptMode: always
---

This is contention, not a failure. The embedded store is single-writer by design
and takes a cooperative gate that ordinary commands share and maintenance takes
exclusively, so a concurrent writer is the expected case, not a defect.

MUST wait briefly and retry the same command, up to three attempts, then report
what still failed. NEVER escalate it, NEVER report the run as blocked on it, and
NEVER work around it: no wrapper, no serialization, no mutex, no retry helper, no
substitute command. Nothing about the store needs changing.

NEVER treat `warning: workspace gate unavailable, continuing ungated` or
`warning: workspace gate acquisition failed, continuing ungated` as contention.
Those commands RAN; retrying repeats work that already happened.

A message not on this list is a different problem: report it verbatim rather than
retrying it, so whatever it actually is gets seen.
