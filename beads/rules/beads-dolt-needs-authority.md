---
name: beads-dolt-needs-authority
description: Advise on deliberate end-of-work Dolt synchronization.
condition: ["(?m)^\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+-C\\s+\\S+|\\s+--directory(?:=\\S+|\\s+\\S+))*\\s+dolt\\s+(?:pull|push)\\b"]
scope: "tool:bash"
interruptMode: never
---
`bd dolt pull/push` is allowed as a deliberate end-of-work synchronization step after task state is complete. Do not run it incidentally or from lifecycle hooks. If synchronization fails, report the exact failure and stop; never bypass the configured router or force a retry unless separately authorized.
