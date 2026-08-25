# delivery

Commit/push cadence, git workflow (branch, ship, merge proof, beads merge-queue linkage), a branch-first commit gate, and the read-only `pr-reviewer` agent.

## Agents

| Name | When |
| --- | --- |
| `pr-reviewer` | Review a pull request; returns `VERDICT:` only. |

## Rules

| Name | When |
| --- | --- |
| `delivery-cadence` | Continuous atomic commit and push. |
| `delivery-git-workflow` | Branching, PRs, GW-3 landing proof, beads merge-queue linkage, GW-1/GW-2. |
| `delivery-draft-pr-advisory` | `gh pr create` without `--draft` (TTSR). |

## Extensions

- `main-branch-gate` — blocks a `git`/`dgit` commit whose target repository has
  main or master checked out, reading `git branch --show-current` there rather
  than reading the commit message. Fails open when git cannot name a branch;
  `--dry-run` and `DELIVERY_ALLOW_MAIN_COMMIT=1` are allowed. It replaces
  `delivery-no-work-on-main`, which blocked `git commit -m 'fix main bug'` and
  missed every commit whose message did not mention the branch.
- `unpushed-work-advisory` — at a session stop, reports the agent's own
  uncommitted files and unpushed commits.
