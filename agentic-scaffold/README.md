# agentic-scaffold

Deterministic repository scaffolding from ordered template layers and Beads formulas. Install it with:

```sh
omp plugin install agentic-scaffold@srobroek-omp
```

The Python standard-library CLI reads `profiles/*.toml` and per-layer `layer.toml` files. It never overwrites user-owned files and changes only managed marker blocks.

## CLI

`$SCAFFOLD` is the script inside the installed plugin (agents use `skill://agentic-scaffold/scripts/scaffold.py`):

```sh
SCAFFOLD=~/.omp/plugins/node_modules/@srobroek/agentic-scaffold/skills/agentic-scaffold/scripts/scaffold.py
python3 "$SCAFFOLD" inspect --root R
python3 "$SCAFFOLD" profiles list
python3 "$SCAFFOLD" layers list
python3 "$SCAFFOLD" layers show lang/python
python3 "$SCAFFOLD" answers write --root R --profile python-app --set name=demo
python3 "$SCAFFOLD" plan --root R --profile python-app
python3 "$SCAFFOLD" render --dry-run --root R --profile python-app
python3 "$SCAFFOLD" render --root R --profile python-app
python3 "$SCAFFOLD" update --root R
python3 "$SCAFFOLD" doctor --root R
python3 "$SCAFFOLD" tools install --root R --yes
python3 "$SCAFFOLD" hooks install --root R
python3 "$SCAFFOLD" plugins sync --root R
```

## Monorepos

Use the `monorepo` profile for a root workspace. Add nested language members before rendering:

```sh
python3 "$SCAFFOLD" answers write --root R --profile monorepo --name demo
python3 "$SCAFFOLD" member add --root R --name api --layer lang/python --kind app
python3 "$SCAFFOLD" member add --root R --name web --layer lang/ts --kind lib
python3 "$SCAFFOLD" render --root R
```

Member files are rooted below `packages/<name>` for Python and TypeScript. Root manifests are generated per language family. Root recipes and hooks scope each member. `member remove` updates the answers and reports the directory. It never deletes files.

Flags and conventions:

- `--layer web-ui` appends the UI plugin layer for one run.
- `--var speckit=true` appends SpecKit.
- Precedence: CLI, then profile, then layer defaults.
- `plan` and `render --dry-run` write nothing.
- Exit codes: 0 success, 1 operational error, 2 drift, 5 conflict.

## State and escalation

| File | Role |
|---|---|
| `.omp/scaffold-answers.toml` | desired project input |
| `.omp/scaffold.json` | owned-file hashes for safe updates |
| `.omp/plugins.toml` | project-scope plugin declaration |

Guarantees:

- The renderer leaves user-scope plugins alone.
- In `.omp/mcp.json`, existing keys win.
- Plugin entries are added, never removed.
- A `[tools]` key that already exists is left alone.
- `--adopt` requires the user's approval for that file.
- `--force-layer` names the layer that wins a conflict.

The phase references live in `skills/agentic-scaffold/references/`:

- `interview.md`
- `layers.md`
- `profiles-and-combinations.md`
- `render-and-update.md`
- `plugins.md`
- `conflicts.md`
- `verify.md`

Humans follow [`docs/runbook.md`](docs/runbook.md). Formulas live in `formulas/`.
