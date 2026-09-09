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

If beads is present, copy the formula into `.beads/formulas/`. Pour it with `bd mol pour mol-scaffold-greenfield --var feature=001-example --var profile=ts-app`. The interview and commit are human gates. Resolve a gate with `bd gate resolve <gate-id>`, then close its preceding step. Do not close a gate bead directly.

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

The brownfield interview confirms the detected profile and chooses optional layers. The default is `agentic + hooks + tooling`. It resolves every finding. For a `hook-manager` finding, choose `hooks install --migrate` or skip hooks. Migration preserves legacy hooks. For an `unowned-file` finding, pass `--adopt PATH` only after explicit approval. Restore the expected `AGENTS.md` marker pair when markers are ambiguous. An existing user file is skipped; propose a diff before adoption.

## Escalation rules

- Exit 5 from `plan` means duplicate ownership or a `conflicts_with` pair. Drop a layer or use `--force-layer L` for the named winner on this run.
- Exit 5 from `render` means damaged or duplicated markers. Restore the printed marker pair; never guess.
- Existing `.omp/mcp.json` is deep-merged with existing keys winning. Existing `.omp/plugins.toml` is a marketplace/plugin union. Existing TOML `[tools]` keys are parsed and not duplicated. Plain text and YAML are marker blocks only.
- Missing tools are reported by `inspect`/`doctor`; run `tools install --yes` or install the command manually.

## Update, drift, and verification

```sh
python3 "$SCAFFOLD" update --root /path/to/repo
python3 "$SCAFFOLD" plugins sync --check --root /path/to/repo
python3 "$SCAFFOLD" doctor --root /path/to/repo
omp plugin list --json
omp -p --no-session --model smol "Which project-local agentic-scaffold skill is available?"
```

`update` reads committed answers and refreshes managed blocks. When an owned-file hash differs from the last render, it reports `drifted` and leaves that file untouched. Text outside markers stays intact. `doctor` exit 0 is clean, exit 2 is drift, and exit 1 is an operational failure. `plugins sync --check` must report an empty drift list. Project scope must appear in OMP JSON. Reload a session after installation. After a live smoke, uninstall project plugins and delete the throwaway directory.
