---
name: srobroek-sudo-destructive-advisory
description: Warns after a destructive verb has run under sudo, where elevated privileges ignore workspace boundaries.
condition: ["(?i)(?:^|\"command\"\\s*:\\s*\"|\\\\n|\\n|[;&|(]\\s*|\\bthen\\s+|\\bdo\\s+)(?<![\"'\\x60])sudo\\s+(?:rm|dd|mkfs|shred|truncate|chmod\\s+-R|chown\\s+-R)\\b"]
scope: "tool:bash"
interruptMode: never
---

A destructive verb just ran under `sudo`. Elevated commands do not respect workspace boundaries; confirm that the target was literal and inside the intended tree before continuing.
