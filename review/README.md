# review

Read-only review and challenge agents. Does not re-ship the bundled `reviewer`.

## Agents

| Name | Role | When |
|------|------|------|
| `reviewer-high` | `@slow` | Adversarial review of security-sensitive or broad-impact changes |
| `adversarial-challenger` | `@challenger` | Stress-test a claim, plan, or design from isolated facts |

## Rules

- `review-index` (always-apply) — empty rulebook; agents only
