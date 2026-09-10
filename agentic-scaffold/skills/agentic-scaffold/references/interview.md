# Interview

Load after `preflight` or when starting a greenfield run. The CLI emits the ordered questions;
answers are written to `.omp/scaffold-answers.toml` and the run marker is created by `answers write`.
Do not hand-edit either generated file.

## 1. Emit questions

```sh
python3 "$SCAFFOLD" interview questions --root R --profile P
```

The JSON has `root` and `questions`. Every question has `id`, `prompt`, `required`, `default`,
optional `allowed`, and `source`. Ask every `required` question with the `ask` tool, in order.
Never silently accept a required question's default. Optional defaults may be accepted only when the
human explicitly says to use them.

Exit `0` means questions are available. Exit `1` is an operational error. Exit `6` is a root
boundary refusal.

## 2. Greenfield questions

The fixed set covers name and purpose, kind (`lib | app | service | cli`), language (`python | ts |
rust | go | terraform | none`), license, remote creation and visibility, beads, web UI, and
SpecKit. The CLI may omit a question that is derived from an earlier answer. `kind` selects the
profile suffix; `cli` selects `app`; web UI adds the `web-ui` layer; SpecKit adds the project plugin.
Do not ask framework, provider, or tool-version questions.

## 3. Brownfield questions

Confirm the detected profile, choose optional layers (default proposal: `agentic + hooks + tooling`),
and resolve every emitted `finding:<kind>`. Findings include a foreign hook manager, unowned
`.omp/*` files, dirty state, and ambiguous managed markers. Ask the human which resolution to use;
do not turn a proposal into an answer without explicit approval.

## 4. Write approved answers

```sh
python3 "$SCAFFOLD" answers write --root R --profile P \
  --set name=NAME --set language=python --defaults-for ID,ID
```

Use one `--set key=value` for each answer. Add an id to `--defaults-for` only after explicit human
approval of that id's default. Read `root`, `ok`, `profile`, `layers`, `vars`, `defaults_for`,
`interviewed_at`, and `path`.

Exit `0` records the interview and creates `.omp/scaffold-run.json`. Exit `3` means at least one
required id is unanswered; call `ask` and retry. Exit `5` means the answers select conflicting
layers. Exit `6` means the root boundary refused the write. No later phase starts on exits `3`, `5`,
or `6`.

## 5. Workspace answers

When `layout` is `monorepo`, ask the bounded member set emitted by the CLI. Add approved members
with the `member` command, not by editing TOML:

```sh
python3 "$SCAFFOLD" member add --root R --name NAME --layer lang/python --kind app
```

Read `root`, `added`, `members`, and `path`. Stop when the human says the member list is complete.
