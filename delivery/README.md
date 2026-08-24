# delivery

Commit/push cadence, git workflow (branch, ship, merge proof, beads merge-queue linkage), and the read-only `pr-reviewer` agent.

## Agents

| Name | When |
| --- | --- |
| `pr-reviewer` | Review a pull request; returns `VERDICT:` only. |

## Rules

| Name | When |
| --- | --- |
| `delivery-cadence` | Continuous atomic commit and push. |
| `delivery-git-workflow` | Branching, PRs, landing proof, GW-1/GW-2. |
