# build

Implementation and mechanical-execution agents.

## Agents

| Name | Role | When |
|------|------|------|
| `operator` | `@tiny` | Tiny mechanical commands with explicit targets |
| `external-repo-worker` | `@task` | Clone/edit/verify work in a repo outside the caller project |

Use the built-in `task` agent for implementation in the current repository.
The assignment should name the owned files, verification commands, and whether
commits are authorized. Keep sibling assignments disjoint.

