# build

Implementation and mechanical-execution agents.

## Agents

| Name | Role | When |
|------|------|------|
| `builder` | `@coder` | Bounded implementation in an assigned scope |
| `builder-high` | `@slow` | Escalated cross-module implementation and hard debugging |
| `operator` | `@coder` | Tiny mechanical commands with explicit targets |
| `external-repo-worker` | `@coder` | Clone/edit/verify work in a repo outside the caller project |

## Rules

- `build-index` (always-apply) — empty rulebook; agents only
