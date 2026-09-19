---
name: beads-dolt-needs-authority
description: Advise on deliberate end-of-work Dolt synchronization; see the cadence rule for required timing.
condition: ["(?m)(?<![\"'\\x60])(?:^|(?:&&|\\|\\||[;&|()])\\s*|\\bthen\\s+|\\bdo\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*bd(?:\\s+(?:-C\\s+\\S+|--directory(?:=\\S+|\\s+\\S+)))*\\s+dolt\\s+(?:pull|push)\\b"]
scope: "tool:bash"
interruptMode: never
---

See [Dolt synchronization cadence]rule://beads-dolt-sync-cadence for the required pull-before-work and push-after-delivery cadence. This rule only warns when a deliberate synchronization command is attempted; do not run it incidentally or from lifecycle hooks. If synchronization fails, report the exact failure and stop; never bypass the configured router or force a retry unless separately authorized.
