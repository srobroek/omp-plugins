# Verification

Load after `apply`, or when diagnosing drift. Every command emits one JSON document and includes
`root` resolved from `--root`.

## Pipeline checks

```sh
python3 "$SCAFFOLD" preflight --root R --profile P
python3 "$SCAFFOLD" apply --root R --dry-run
python3 "$SCAFFOLD" apply --root R
python3 "$SCAFFOLD" doctor --root R
python3 "$SCAFFOLD" finish --root R
```

`preflight` is fail-closed. Read `hard`, `soft`, `missing_tools`, and `tools`; all hard findings
must be resolved, and the findings are shown to the human with a choice (guidebook step 1) rather
than reported as an end of turn. `apply --dry-run` is preflight plus plan and writes nothing.
Read `planSummary` for the human and `stages` for debugging; every stage must be `ok` before approval. A live `apply` reports each stage
with `name`, `status`, `seconds`, and `summary`; it stops at the first failure and may include `next`.

`doctor` reads `.omp/scaffold-answers.toml`, `.omp/scaffold.json`, project plugins, hooks, tools,
context, and managed markers. Read `checks`, `drift`, and `errors`. A declared but uninstalled hook
is drift, not success. `finish` reads the doctor result, molecule state, and git status; read
`commitCommand` and `blockers`. It removes `.omp/scaffold-run.json` only on success.

## Exit codes

| Code | Meaning | Decision |
|---|---|---|
| `0` | success | continue to the next command |
| `1` | operational error | stop and report the JSON |
| `2` | drift | repair through the CLI, then rerun |
| `3` | needs input | ask the missing required question |
| `5` | conflict | resolve ownership or layer selection |
| `6` | boundary refusal | keep all writes and commands inside the project; retry via `scaffold` |

Never treat a non-zero code as a warning. The execution agent reports the JSON verbatim and does not
invent a smoke test or workaround.

## Project-scope plugin proof

```sh
python3 "$SCAFFOLD" plugins sync --root R --check
omp plugin list --json
```

Read `desired` and `drift` from the CLI. Confirm each declared plugin in `omp plugin list --json`
has `scope: "project"`; user-scope output is not proof of installation. A non-empty drift list is
exit `2`.

## Fresh-session proof

From the rendered project, start a fresh session after reload and ask:

```sh
omp -p --no-session --model smol "Which project-local agentic-scaffold skill is available?"
```

The answer must identify the project-local skill. Do not infer visibility from the current session's
loaded skill list.

## Workspace proof

For a monorepo, read `members` from `member list`, `answers`, and each family manifest. Every answer
member must have a directory and a manifest entry. Verify root recipes and hook entries scope each
member; `member remove` reports its directory and never deletes user files.
