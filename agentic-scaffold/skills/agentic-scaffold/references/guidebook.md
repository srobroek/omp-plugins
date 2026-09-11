# Scaffold guidebook

Load this guide when a repository is scaffolded. `$SCAFFOLD` names the installed
`skills/agentic-scaffold/scripts/scaffold.py` path. `R` names the session project root.
The lead invokes each command through the `scaffold` tool.

## 1. Start

```sh
python3 "$SCAFFOLD" start --root R --profile P
```

Read `findings.markdown`, `findings.rows`, `blockers`, `recommended_profile`, and `ask`.
The findings include detected stacks, tooling, layers, missing tools, and preflight lines.
A clean tree with no blockers offers `Continue to the interview` and `Stop`.
A dirty tree is a hard blocker and offers only `Stop`.
Do not write files before the human selects `Continue to the interview`.

## 2. Interview

```sh
python3 "$SCAFFOLD" interview --root R --profile P [--answers-so-far JSON]
```

Read the returned `ask` object. Each page has at most five questions and each question has
at most five options. When a question accepts more values than the page shows, its last option
is `Another value` and its description lists the remaining accepted values; relay them. Pass selected answers in `--answers-so-far` as one JSON object.
Repeat until `complete` is true. Preserve the question ids and multi-value arrays.
The CLI orders layout and shape, members, kind, profile and layers, license, docs, publish,
and layer variables. Dependent questions appear after their answers.

## 3. Plan

```sh
python3 "$SCAFFOLD" plan --root R --answers JSON
```

Pass the complete answer object returned by the interview. The command writes answers through
the existing answers writer and runs the apply dry run. Read `path`, `planSummary`, and `ask`.
The plan at `.omp/scaffold-plan.md` lists layers, files to create or skip, conflicts, tools,
hooks, and commands. The ask options are `Apply` and `Stop`.
Do not run the next verb until the human selects `Apply`.

## 4. Run

```sh
python3 "$SCAFFOLD" run --root R
```

The command applies every stage and runs doctor. The `provision` stage runs Better-T-Stack for
TypeScript applications, Tauri frontends, TypeScript-only monorepos, and Starlight sites. It writes
only into an empty root or a new member directory and refuses any other target; the refusal names
the adopt path (`bts=false`: keep the existing stack, render governance, CI, release, hooks, and
agent files only). `plan` shows the exact generator command before anything runs. Read `status`, `doctor`, `stages`, and
`commitCommand`. A successful run returns `READY_FOR_COMMIT` and per-stage `seconds`.
The agent never runs the commit command.

## 5. Finish

```sh
python3 "$SCAFFOLD" finish --root R
```

Run this command after the human commits. Read `state`, `ok`, `commitCommand`, and `blockers`.
A blocked finish reports every blocker. A finished run removes `.omp/scaffold-run.json`.

## Crashed or abandoned runs

```sh
python3 "$SCAFFOLD" abort --root R
```

Read `hadRun`, `stagesCompleted`, `dirtyOwned`, `dirtyOther`, and `revertCommands`.
The agent does not run revert commands.

## Hard rules

1. Use one `scaffold` command for every deterministic operation.
2. Use the returned `ask` payload. Do not recreate questions or findings.
3. Never assume a required answer or bypass a blocker.
4. Keep writes under `R` and use scaffold-owned paths.
5. Never call `chezmoi apply`, push, amend, or install outside the CLI.
6. Stop on non-zero and report the command JSON verbatim.
7. Exit codes are `0` success, `1` error, `2` drift, `3` needs input, `5` conflict, and `6` boundary.
8. Do not hand-edit generated answers or rendered files.
9. Every stop is an `ask`. A boundary refusal, advisor block, or failed stage offers only `Stop` and an explanation.
