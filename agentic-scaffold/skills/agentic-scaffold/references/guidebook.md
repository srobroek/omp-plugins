# Scaffold guidebook

Load this guide when a repository is being scaffolded or when the lead needs to explain the
pipeline. `$SCAFFOLD` is the installed `skills/agentic-scaffold/scripts/scaffold.py` path and `R`
is the session project root. The lead invokes these commands through the `scaffold` tool; the
shell forms below are the exact CLI commands used by that tool.

## 1. Prove the repository is eligible, then confirm with the human

```sh
python3 "$SCAFFOLD" inspect --root R
python3 "$SCAFFOLD" preflight --root R --profile P
```

Read `inspect` for `stacks`, `suggestedProfile`, `tooling` (what the repo already has), `notes`,
and `findings`. If `inspect` exits non-zero or returns no `stacks` key, show its JSON verbatim and
ask "Stop" or "Explain"; do not build the table from guesses. Read `preflight` for `root`, `hard`, `soft`, `missing_tools`, `tools`, `plugins`,
`layers`, and `version`. `hook_strategy` is recorded for later stages; do not report or ask about
it. The root must be a git work tree, not `$HOME` or `~/.omp`.

This step always ends in an `ask`, whatever preflight returned. A report that ends the turn is
not a stop; the human has to be able to answer without re-prompting. Write the findings first, as
a short table in the assistant message: detected stacks, existing tooling, the profile you will
propose and why, the layers that profile brings, declared plugins, and every `hard` and `soft`
line verbatim. Then ask:

- `hard` is empty: options "Continue to the interview" and "Stop here".
- `hard` names a dirty work tree: options "Review and allow dirty" (you then show
  `git status --short` and re-run preflight with `--allow-dirty`), "Stop; I will clean the tree".
- any other `hard` line: options "Stop; I will fix the named prerequisite" and "Explain what is
  missing"; there is no bypass for a missing tool or an invalid root.

Do not write files before preflight exits `0` and the human has chosen to continue.

## 2. Emit the interview

```sh
python3 "$SCAFFOLD" interview questions --root R --profile P
```

Read `root` and `questions`. Each question has `id`, `prompt`, `required`, `default`, optional
`allowed`, and `source` (`fixed`, `layer:<name>`, or `finding:<kind>`). Present every question with
`required: true` to the human using the `ask` tool, in emitted order. Ask optional questions when
the human wants to choose them. Never fill a required answer from its `default`.

Decision: if the list is empty, continue with the profile emitted by preflight. If any required
question is unanswered, remain at this step and do not call `answers write`.

## 3. Record approved answers

```sh
python3 "$SCAFFOLD" answers write --root R --profile P \
  --set name=NAME --set language=LANG --defaults-for ID,ID
```

Include one `--set key=value` for each answer returned by `ask`. Include an id in
`--defaults-for` only when the human explicitly approved that question's default. Read `root`,
`ok`, `profile`, `layers`, `vars`, `defaults_for`, `interviewed_at`, and `path`.

Decision: exit `0` creates `.omp/scaffold-answers.toml` and `.omp/scaffold-run.json`; exit `3`
means a required id is missing and must be asked before retrying. Exit `5` means an answer creates
a conflict; return to the interview and change the selected profile or layer.

## 4. Show the dry-run plan

```sh
python3 "$SCAFFOLD" apply --root R --dry-run
```

Read `root`, `ok`, and `planSummary`. `planSummary` has `profile`, `layers`, `counts` (rows per
class), `lines` (one `class path (layer)` line per file), `conflicts`, and `preflight`. The full
`stages` array is for debugging a failure, not for the human. This command is preflight plus plan
and writes nothing.

Write the plan as a document before asking, the way plan mode would:

1. `write` `local://scaffold-plan.md` with: the profile and layers, the counts, one table row per
   line of `planSummary.lines` (columns: action, path, layer), the conflicts, and a closing section
   "After approval" that names the pipeline stages the scaffolder will run.
2. Put the same table in the assistant message, with the artifact path.
3. Call `ask` with two short options, "Approve plan" and "Change answers", and no JSON in either
   description.

When the session is already in OMP plan mode, submit `scaffold` to `xd://propose` instead of
calling `ask`; the human's resolve is the approval. A skill cannot enter plan mode; do not claim to.
The scaffolder receives the artifact path with its task so it executes the plan the human read. On exit `2`, resolve drift; on exit `5`, resolve ownership; on exit `6`, resolve the
boundary. Do not delegate execution until the human approves.

## 5. Execute the approved pipeline

Delegate a `task` to `scaffolder` with the approved profile and the `local://scaffold-plan.md`
path. It must call the `scaffold` tool for:

```sh
python3 "$SCAFFOLD" preflight --root R --profile P
python3 "$SCAFFOLD" apply --root R
python3 "$SCAFFOLD" doctor --root R
python3 "$SCAFFOLD" finish --root R
```

The tool injects `--root` from the session cwd. Read each returned JSON document. `apply` reports
`ok`, `stages`, and optional `next`; it stops at the first failed stage and is safe to retry.
Stages are preflight, plan, render, tools-install, hooks-install, plugins-sync, context-refresh,
and doctor. The execution agent stops and reports JSON verbatim on any non-zero exit.

Decision: continue only when `preflight` and every `apply` stage are successful. A doctor exit `2`
is drift, exit `1` is an operational failure, exit `3` needs input, exit `5` is a conflict, and exit
`6` is a boundary refusal. Resolve the stated issue through the CLI, then rerun the pipeline; never
hand-edit generated files or install around a failure.

## 6. Verify the final gate

```sh
python3 "$SCAFFOLD" doctor --root R
python3 "$SCAFFOLD" finish --root R
```

Read doctor `root`, `checks`, `drift`, and `errors`. Read finish `root`, `ok`, `commitCommand`, and
`blockers`. `finish` succeeds only when doctor is clean, all molecule children and gates are closed,
and scaffold-owned paths are ready to commit. Success removes `.omp/scaffold-run.json`.

Decision by `state`:

- `ready-for-commit`: the only blocker is the uncommitted scaffold output. Present `commitCommand`
  to the human; after the human commits, run `finish` once more.
- `blocked`: stop and report every blocker verbatim.
- `finished`: the run marker is gone; report the commit that closed the run.

### Crashed or abandoned run

While `.omp/scaffold-run.json` exists, the hard boundary stays active, even after a timeout or a
killed process. Close such a run with:

```sh
python3 "$SCAFFOLD" abort --root R
```

Read `hadRun`, `stagesCompleted`, `dirtyOwned`, `dirtyOther`, and `revertCommands`. Present
`dirtyOwned` with its per-path `revertCommands` to the human; `dirtyOther` is the human's own work
and gets no command. The agent runs neither a revert nor a commit. `abort` deletes only the run
marker.

The agent never runs the commit command itself.

## 7. Hard rules

1. Every deterministic operation is one `scaffold` command; do not write a custom script.
2. The mandatory interview uses `ask` for every required question; defaults are never silently assumed.
3. The lead shows `apply --dry-run` and waits for approval before delegating `apply`.
4. During a run marker, direct `write`, `edit`, `ast_edit`, `eval`, unsafe bash, global config, and
   user-scope plugin changes are blocked. Use `scaffold apply` instead.
5. Never call `chezmoi apply`, push, amend a commit, or install tools outside the CLI pipeline.
6. Do not modify files outside `R`, scaffold-owned paths, templates, profiles, or formulas by hand.
7. Exit codes are `0` success, `1` error, `2` drift, `3` needs input, `5` conflict, and `6` boundary.
8. Stop on non-zero and report the command's JSON verbatim; do not invent tests or workarounds.
9. The confirmation gates are `ask`s, never reports that end the turn: after inspect and
   preflight, after the interview, and at the plan. The human gets the findings, your
   recommendation, and options. A boundary refusal, an advisor block, or a failed stage is
   reported with its JSON verbatim and offers only "stop" and "explain": no bypass option.
