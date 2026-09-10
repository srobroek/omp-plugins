# Runbook

The runbook covers greenfield and brownfield repositories. Every CLI command emits JSON. `$SCAFFOLD` names the installed CLI script. Agents use `skill://agentic-scaffold/scripts/scaffold.py`; OMP resolves that path to the same file.

```sh
SCAFFOLD=~/.omp/plugins/node_modules/@srobroek/agentic-scaffold/skills/agentic-scaffold/scripts/scaffold.py
```

## Greenfield

Create `/tmp/example`. Run the fixed interview in `references/interview.md`. Ask about name and purpose, kind, language, license, remote and visibility, beads, web UI, and SpecKit. Derive the profile from kind and language. Do not ask framework questions.

```sh
mkdir -p /tmp/example
 git -C /tmp/example init
python3 "$SCAFFOLD" inspect --root /tmp/example
python3 "$SCAFFOLD" profiles list
python3 "$SCAFFOLD" layers list
python3 "$SCAFFOLD" answers write --root /tmp/example --profile ts-app --set name=example --set language=ts
python3 "$SCAFFOLD" plan --root /tmp/example --profile ts-app --layer web-ui
python3 "$SCAFFOLD" render --dry-run --root /tmp/example --profile ts-app --layer web-ui
python3 "$SCAFFOLD" render --root /tmp/example --profile ts-app --layer web-ui
python3 "$SCAFFOLD" tools install --root /tmp/example --yes
python3 "$SCAFFOLD" hooks install --root /tmp/example
python3 "$SCAFFOLD" plugins sync --root /tmp/example
python3 "$SCAFFOLD" doctor --root /tmp/example
just --directory /tmp/example check
```

With beads present, copy the formula into `.beads/formulas/` and pour it:

```sh
bd mol pour mol-scaffold-greenfield --var feature=001-example --var profile=ts-app
```

The molecule has two human gates: the interview and the commit. To pass a gate, run `bd gate resolve <gate-id>` and then close the preceding step. Never close a gate bead directly.

## Monorepo

Use the workspace profile when one repository contains multiple language members.

```sh
python3 "$SCAFFOLD" answers write --root /tmp/workspace --profile monorepo --name workspace
python3 "$SCAFFOLD" member add --root /tmp/workspace --name api --layer lang/python --kind app
python3 "$SCAFFOLD" member add --root /tmp/workspace --name web --layer lang/ts --kind lib
python3 "$SCAFFOLD" render --root /tmp/workspace
python3 "$SCAFFOLD" member list --root /tmp/workspace
```

The renderer writes a root manifest for each language family. It writes member files below the recorded directory. Root just recipes and hook entries carry member scoping. Add `--layer moon` for Moon or `--layer worktrunk` for Worktrunk.

For an existing workspace, inspect first. Import each detected member with `member import`. Import records the directory and does not rewrite existing member files. `member remove` updates answers and reports the directory. It never deletes files.

Smoke checks are `uv sync` at the root for Python, `bun install` at the root for TypeScript, `just test`, `prek validate-config`, and `doctor`.

## Brownfield

```sh
python3 "$SCAFFOLD" inspect --root /path/to/repo
python3 "$SCAFFOLD" profiles list
python3 "$SCAFFOLD" answers write --root /path/to/repo --profile agentic-repo
python3 "$SCAFFOLD" plan --root /path/to/repo --profile agentic-repo
python3 "$SCAFFOLD" render --root /path/to/repo --profile agentic-repo
python3 "$SCAFFOLD" hooks install --root /path/to/repo
python3 "$SCAFFOLD" plugins sync --root /path/to/repo
python3 "$SCAFFOLD" doctor --root /path/to/repo
```

The brownfield interview has three parts:

1. Confirm the detected profile.
2. Choose optional layers. The default is `agentic + hooks + tooling`.
3. Resolve every `inspect` finding.

| Finding | What to do |
|---|---|
| `hook-manager` (global `core.hooksPath`) | With `git-defender` on PATH, `hooks install` chains through it. Otherwise choose one: `hooks install --force`, move `core.hooksPath` to repository scope, or skip the hooks layer. |
| foreign block in `AGENTS.md` | Nothing. The plan shows `update-block`; the renderer keeps the foreign block. Only damaged agentic markers or a symlink conflict. |
| `unowned-file` | Get explicit approval, then pass `--adopt PATH`. |
| existing user file | The renderer skips it. Propose a diff before adoption. |

## Escalation rules

- Exit 5 from `plan` means duplicate ownership or a `conflicts_with` pair. Drop a layer or use `--force-layer L` for the named winner on this run.
- Exit 5 from `render` means damaged or duplicated markers. Restore the printed marker pair; never guess.
- Merge rules per file live in [`architecture.md`](architecture.md).
- When `inspect` or `doctor` reports a missing tool, run `tools install --yes` or install the command by hand.

## Update, drift, and verification

```sh
python3 "$SCAFFOLD" update --root /path/to/repo
python3 "$SCAFFOLD" plugins sync --check --root /path/to/repo
python3 "$SCAFFOLD" doctor --root /path/to/repo
omp plugin list --json
omp -p --no-session --model smol "Which project-local agentic-scaffold skill is available?"
```

`update` reads the committed answers and refreshes the managed blocks. Text outside markers stays intact. When an owned file differs from its recorded hash, `update` reports it as `drifted` and leaves it alone.

| Check | Expected |
|---|---|
| `doctor` | exit 0. Exit 2 is drift, exit 1 is an operational failure. |
| `plugins sync --check` | empty drift list |
| `omp plugin list --json` | the profile's plugins with `scope: "project"` |
| fresh session | the project skills appear after a reload |

After a live smoke in a throwaway repository:

1. Uninstall its project plugins.
2. Delete the directory.
