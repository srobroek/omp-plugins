---
name: beads-merge-slot-never-wait
description: bd merge-slot acquire --wait does not block; it records an advisory waiter and returns.
condition: ["(?m)(?<![\"'\\x60])(?:^|(?:&&|\\|\\||[;&|()])\\s*|\\bthen\\s+|\\bdo\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+(?:-C\\s+\\S+|--directory(?:=\\S+|\\s+\\S+)))*\\s+merge-slot\\s+acquire\\b[^\\n;&|()]*--wait\\b"]
scope: "tool:bash"
interruptMode: always
---

`--wait` is not a wait. It appends the requester to the slot's
`metadata.waiters` and returns: it does not block, transfer ownership when the
holder releases, or remove a stale waiter. Reading that list as a FIFO queue
invents ordering the database does not implement.

Acquire atomically with one stable holder identity:

```
bd merge-slot acquire --holder <stable-id>
```

When another holder owns the slot, stop and report who holds it rather than
looping. The rest of the protocol is in `rule://beads-coordination`.
