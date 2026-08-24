---
name: delivery-cadence
description: When committing, pushing, or stopping work — continuous atomic commit/push cadence; never leave unpushed local work.
globs: ["**/*"]
---

# Delivery Cadence

Work like a developer who commits continuously, not one who dumps a finished
branch at the end.

- Commit and push after every meaningful, self-contained step, not once at the
  end.
- Leave no unpushed local work at a stopping point. Push committed work to its
  remote branch so nothing lives only in a local or disposable (`/tmp`) worktree
  that may not survive. If a push is blocked, say so explicitly rather than
  silently leaving work local.
- Session-end enforcement (GW-1/GW-2) is defined in `rule://delivery-git-workflow`.
