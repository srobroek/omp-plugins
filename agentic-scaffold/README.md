# agentic-scaffold

Use this plugin to scaffold or retrofit a repository. The pipeline asks a human for project choices.
The CLI writes under the project root. The CLI pins each required tool in `mise.toml`.

Install the plugin:

```sh
omp plugin install agentic-scaffold@srobroek-omp
```

## Pipeline

The lead calls the `scaffold` tool. The tool injects the session root. It rejects root overrides and
path traversal. The execution agent has `read`, `glob`, `grep`, and `scaffold`.

```text
scaffold preflight --profile P
scaffold interview questions --profile P
ask every required question
scaffold answers write --profile P --set key=value --defaults-for approved-id
scaffold apply --dry-run
human approves the plan
scaffolder task: preflight → apply → doctor → finish
present finish.commitCommand
human commits
```

The shell form is:

```sh
SCAFFOLD=~/.omp/plugins/node_modules/@srobroek/agentic-scaffold/skills/agentic-scaffold/scripts/scaffold.py
python3 "$SCAFFOLD" preflight --root R --profile P
python3 "$SCAFFOLD" interview questions --root R --profile P
python3 "$SCAFFOLD" answers write --root R --profile P --set name=NAME
python3 "$SCAFFOLD" apply --root R --dry-run
python3 "$SCAFFOLD" apply --root R
python3 "$SCAFFOLD" doctor --root R
python3 "$SCAFFOLD" finish --root R
```

`apply --dry-run` runs preflight and plan. It writes nothing. A live `apply` runs the full
pipeline. It stops at the first failure. `finish` returns a commit command. It never commits.

## Results

Every result includes the resolved `root`. `apply` returns `ok`, `stages`, and optional `next`.
Each stage has `name`, `status`, `seconds`, and `summary`. `finish` returns `ok`, `commitCommand`,
and `blockers`.

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | operational error |
| 2 | drift |
| 3 | required input is missing |
| 5 | conflict |
| 6 | root or boundary refusal |

## Boundary

`.omp/scaffold-run.json` enables the boundary. The boundary blocks direct writes outside the root.
It blocks writes to scaffold-owned paths. It blocks `eval` and unsafe shell commands. Retry through
`scaffold apply`.

## References

- [`SKILL.md`](skills/agentic-scaffold/SKILL.md): routing and rules.
- [`guidebook.md`](skills/agentic-scaffold/references/guidebook.md): commands and decisions.
- [`interview.md`](skills/agentic-scaffold/references/interview.md): required questions.
- [`conflicts.md`](skills/agentic-scaffold/references/conflicts.md): escalation.
- [`plugins.md`](skills/agentic-scaffold/references/plugins.md): project plugin proof.
- [`verify.md`](skills/agentic-scaffold/references/verify.md): doctor and finish.
- [`runbook.md`](docs/runbook.md): human flow.
- [`ci-standard.md`](docs/ci-standard.md): the CI, quality-gate, and release standard the `ci/github` and `release` layers render, with the repositories it was derived from.
- [`architecture.md`](docs/architecture.md): runtime details.
