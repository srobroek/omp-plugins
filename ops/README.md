# ops

Telemetry agents and toolchain cache hygiene.

## Agents

| Name | Role | When |
|------|------|------|
| `maintenance-metrics-reader` | `@tiny` | Repo/worktree health snapshot; no edits |
| `data-metrics-summarizer` | `@tiny` | Compact scoped logs and metrics; figures only |

## Rules

- `ops-toolchain-cache-policy` — shared caches, worktree-local output, eviction knobs
