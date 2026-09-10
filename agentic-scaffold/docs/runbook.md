# Agentic scaffold runbook

Use this flow for greenfield or brownfield repositories. Every command prints one JSON document.
The lead calls the `scaffold` tool. The shell examples show the exact CLI form.

Set these variables:

```sh
SCAFFOLD=~/.omp/plugins/node_modules/@srobroek/agentic-scaffold/skills/agentic-scaffold/scripts/scaffold.py
R=/path/to/repo
```

Run inside a git repository. Do not use `$HOME`. Do not use a path inside `~/.omp`.

## 1. Preflight

```sh
python3 "$SCAFFOLD" preflight --root "$R" --profile P
```

Read these keys:

- `root`
- `hard`
- `soft`
- `missing_tools`
- `tools`
- `hook_strategy`
- `version`

Continue on exit `0`. Before any write, resolve every hard finding.

## 2. Interview

```sh
python3 "$SCAFFOLD" interview questions --root "$R" --profile P
```

Read `root` and `questions`.
Present every required question with the `ask` tool. Keep the emitted order.
Need explicit approval for a default.
Ask optional questions at human request.

Greenfield questions cover:

- name and purpose
- kind
- language
- license
- remote and visibility
- beads
- web UI
- SpecKit

Brownfield questions cover profile choice, layer choice, and each emitted finding.

## 3. Write answers

```sh
python3 "$SCAFFOLD" answers write --root "$R" --profile P \
  --set name=NAME --set language=python --defaults-for APPROVED_ID
```

Pass each human answer with `--set`.
List approved defaults in `--defaults-for`.
Read the answer result's `root`.
Read `ok`, `profile`, `layers`, and `vars`.
Read `defaults_for`, `interviewed_at`, and `path`.

Exit `3` means required input. Ask the question and retry.
Exit `5` means a layer conflict. Change the selection and repeat the interview.
This command creates the run marker.

## 4. Review the plan

```sh
python3 "$SCAFFOLD" apply --root "$R" --dry-run
```

Read `root`, `ok`, and `stages`.
Read each stage's `name`.
Read its `status`, `seconds`, and `summary`.
This command writes nothing. Show the JSON plan. Wait for approval.

Resolve exit `2` drift. Resolve exit `5` conflicts. Resolve exit `6` boundary refusals.

## 5. Delegate execution

After human approval, delegate a `task` to `scaffolder`.
It calls the `scaffold` tool with these commands:

```sh
python3 "$SCAFFOLD" preflight --root "$R" --profile P
python3 "$SCAFFOLD" apply --root "$R"
python3 "$SCAFFOLD" doctor --root "$R"
python3 "$SCAFFOLD" finish --root "$R"
```

`apply` runs these stages:

- preflight
- plan
- render
- tools-install
- hooks-install
- plugins-sync
- context-refresh
- doctor

The execution agent runs no shell. It runs no edit. It runs no eval. It runs no invented test.
It stops on a non-zero exit. It reports the JSON verbatim.

## 6. Hand off

Read `finish` key `root`.
Read `ok`, `commitCommand`, and `blockers`.

When `ok` is false, stop. Report every blocker.
When `ok` is true, present `commitCommand`.
The agent never commits. `finish` removes the run marker after verification.

Prove project plugin scope:

```sh
python3 "$SCAFFOLD" plugins sync --root "$R" --check
omp plugin list --json
omp -p --no-session --model smol "Which project-local agentic-scaffold skill is available?"
```

Confirm `scope: "project"` for every declared plugin. Confirm skill visibility in the fresh session.

## Exit codes

| Code | Meaning | Action |
|---|---|---|
| `0` | success | continue |
| `1` | operational error | stop and inspect JSON |
| `2` | drift | repair through the CLI |
| `3` | needs input | ask the missing question |
| `5` | conflict | choose a resolution |
| `6` | boundary | keep paths under `$R` |

## Boundary

The run marker enables the boundary extension. The extension blocks direct writes outside `$R`.
It blocks writes to scaffold-owned paths. It blocks `eval`. It blocks unsafe shell commands.
Retry through `scaffold apply`.
