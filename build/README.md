# build

Implementation and external-repository agents.

## Agents

| Name | Role | When |
|------|------|------|
| `external-repo-worker` | `@task` | Clone/edit/verify work in a repo outside the caller project |

Use the built-in `task` agent for implementation in the current repository.
Each assignment names its owned files.
Each assignment names its verification commands.
Each assignment states whether the main agent authorizes commits.
Keep sibling assignments disjoint.

## Skills

| Name | When |
|------|------|
| `delegation-choreography` | Delegate non-trivial work and keep related prose edits scoped |
