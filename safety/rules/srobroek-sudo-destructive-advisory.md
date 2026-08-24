---
name: srobroek-sudo-destructive-advisory
description: Warns after a destructive verb has run under sudo, where elevated privileges ignore workspace boundaries.
condition: ["(?i)sudo\\s+(rm|dd|mkfs|shred|truncate|chmod\\s+-R|chown\\s+-R)\\b"]
scope: "tool:bash"
interruptMode: never
---

A destructive verb just ran under `sudo`. Elevated commands do not respect workspace boundaries, so
confirm two things before continuing:

1. The target path was literal, not an unexpanded variable.
2. The target was inside the intended tree.

The catastrophic literal shapes (`sudo rm -rf /` and similar) are denied outright by the
`bash.patterns` deny list. This rule covers the remainder, where the command was legitimate but the
blast radius is larger than the workspace.

Remote-fetch-piped-to-shell is handled separately by `srobroek-remote-exec-guard`, which aborts
before execution rather than warning afterwards.
