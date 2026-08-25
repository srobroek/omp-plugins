---
name: beads-merge-slot-never-wait
description: bd merge-slot acquire --wait does not block; it records an advisory waiter and returns.
condition: ["\\bbd\\s+(?:-C\\s+\\S+\\s+)?merge-slot\\b[^\\n]*--wait\\b"]
scope: "tool:bash"
interruptMode: always
---
`--wait` is not a wait. It appends the requester to the slot's `metadata.waiters` and
returns: it does not block, does not transfer ownership when the holder releases, and
never removes a stale waiter. Reading that list as a FIFO queue invents ordering the
database does not implement.

Acquire atomically instead, with one stable holder identity:

```
bd merge-slot acquire --holder <stable-id>
```

When another holder owns the slot, that command fails. Stop and report who holds it
rather than looping.

The rest of the slot protocol -- what to recheck after acquiring, releasing with the
same `--holder`, recovering a stale holder -- is in rule://beads-coordination.
