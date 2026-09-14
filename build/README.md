# build

Implementation and mechanical-execution agents.

## Agents

| Name | Role | When |
|------|------|------|
| `operator` | `@tiny` | One mechanical command with explicit targets |
| `external-repo-worker` | `@task` | Clone/edit/verify work in a repo outside the caller project |

Use the built-in `task` agent for implementation in the current repository.
Each assignment names its owned files.
Each assignment names its verification commands.
Each assignment states whether the main agent authorizes commits.
Keep sibling assignments disjoint.

## Rules

| Name | When |
|------|------|
| `build-main-task-delegation` | Route nontrivial main-agent work to cost-efficient parallel workers |

