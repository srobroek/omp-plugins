# coexistence

Worktrunk coexistence: tolerate concurrent editors; escape interference or a
stolen checkout rather than fighting for it.

## Rules

| Name | When |
| --- | --- |
| `coexistence-index` | Always-apply index. |
| `coexistence-worktree` | Shared repo, interference, unexpected branch switch. |
