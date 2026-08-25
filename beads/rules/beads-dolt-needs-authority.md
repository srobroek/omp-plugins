---
name: beads-dolt-needs-authority
description: Block unprompted Dolt sync.
condition: ["\\bbd\\s+dolt\\s+(pull|push)\\b"]
scope: "tool:bash"
interruptMode: always
---
`bd dolt pull/push` needs explicit sync authority (user, repo config, or orchestrator). `git push` does not sync `refs/dolt/data`. If unauthorized, report the command instead of running it.
