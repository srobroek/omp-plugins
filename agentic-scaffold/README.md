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

`--layer web-ui` appends the UI plugin layer for one run. `--var speckit=true` appends SpecKit. Precedence is CLI > profile > layer defaults. `plan` and `render --dry-run` write nothing. Exit codes are 0 success, 1 operational error, 2 drift, and 5 conflict.

## State and escalation

`.omp/scaffold-answers.toml` stores the desired project input. `.omp/scaffold.json` records hashes for safe updates. `.omp/plugins.toml` declares project scope. Global plugin state stays unchanged. Existing `.omp/mcp.json` keeps its keys during deep merge. The renderer unions plugin entries and deduplicates TOML `[tools]` keys. Use `--adopt` only for an explicit user-owned file and `--force-layer` only to name a conflict winner.

The seven phase references under `skills/agentic-scaffold/references/` contain the interview, layers, profiles, rendering, plugins, conflicts, and verification procedures. The end-to-end human process is [`docs/runbook.md`](docs/runbook.md); formulas live in `formulas/`.
