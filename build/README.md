# build

Implementation and mechanical-execution agents.

## Agents

| Name | Role | When |
|------|------|------|
| `builder` | `@task` | Bounded implementation in an assigned scope |
| `operator` | `@tiny` | Tiny mechanical commands with explicit targets |
| `external-repo-worker` | `@task` | Clone/edit/verify work in a repo outside the caller project |

