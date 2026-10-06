# quality

Adversarial challenge, WATCHDOG advisor-file authoring, and advisor note resampling.

## Skills

| Name | When |
|------|------|
| `watchdog-files` | Create, audit, or retune a project's `WATCHDOG.yml` / `WATCHDOG.md` advisor files |
| `advisor-resample` | Weekly, or after an advisor prompt or config change: census of delivered advisor notes and a hand-labeled precision sample with KEEP / RETIRE-CANDIDATE verdicts |

## Agents

| Name | Role | Model |
|------|------|-------|
| `adversarial-challenger` | Read-only challenger of claims, plans, and decisions | `@challenger` |

Use the built-in `reviewer` for mechanical diff review. Specify the base ref and
changed-file scope. Ask for read-only commands and anchored deterministic
findings, with no heavy test suites or architecture changes.
