# ops

Telemetry agents and toolchain cache hygiene.

## Agents

| Name | Role | When |
|------|------|------|
| `maintenance-metrics-reader` | `@tiny` | Repo/worktree health snapshot; no edits |
| `data-metrics-summarizer` | `@tiny` | Compact scoped logs and metrics; figures only |

## Rules

- `ops-toolchain-cache-policy` — shared caches, worktree-local output, eviction knobs
- `ops-no-global-cargo-target` — a global Cargo target dir breaks per-repository isolation (TTSR)
- `ops-download-store-not-evictable` — download stores are not reclaimable build caches (TTSR)
