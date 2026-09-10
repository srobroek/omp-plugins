# Project plugins

Load when the selected layers declare OMP plugins. The desired state is `.omp/plugins.toml`; the
runtime registry below `.omp/plugins/` is not hand-edited.

## Sync

```sh
python3 "$SCAFFOLD" plugins sync --root R
python3 "$SCAFFOLD" plugins sync --check --root R
```

Read `root`, `desired`, `installed`, and `drift`. `plugins sync` unions marketplaces and plugin
names into `.omp/plugins.toml`, registers missing marketplaces, and installs missing entries with
`--scope project`. Existing source and order win. It never removes declared entries and never
changes the user-scope plugin set.

`--check` performs no mutation and exits `2` when desired state is not installed. Exit `0` means
there is no plugin drift; exit `1` is an operational error; exit `6` is a boundary refusal. Resolve
all drift through `scaffold apply` before `doctor` or `finish`.

## Proof

```sh
omp plugin list --json
```

Confirm every declared plugin has `scope: "project"` and an installed path below the project
`.omp/plugins/`. User-scope output is not proof. A fresh session after reload must see the selected
project-local skills and agents.

## Rules

- Plugin marketplaces and plugin names are unioned; existing entries are never removed.
- `speckit=true` appends the project-scope `speckit` plugin from the configured marketplace.
- Global plugin install, uninstall, marketplace add/remove, and global configuration are blocked
  while `.omp/scaffold-run.json` exists; use the CLI pipeline.
- Keep the runtime registry ignored and commit only `.omp/plugins.toml`.
