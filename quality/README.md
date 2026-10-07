# quality

Adversarial challenge and WATCHDOG advisor-file authoring.

## Skills

| Name | When |
|------|------|
| `watchdog-files` | Create, audit, or retune a project's `WATCHDOG.yml` / `WATCHDOG.md` advisor files |

## Agents

| Name | Role | Model |
|------|------|-------|
| `adversarial-challenger` | Read-only challenger of claims, plans, and decisions | `@challenger` |

Use the built-in `reviewer` for mechanical diff review. Specify the base ref and
changed-file scope. Ask for read-only commands and anchored deterministic
findings, with no heavy test suites or architecture changes.
