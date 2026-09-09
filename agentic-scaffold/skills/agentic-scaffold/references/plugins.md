# Plugins

LOAD when applying project-local OMP plugins.

```sh
python3 skill://agentic-scaffold/scripts/scaffold.py plugins sync --root R
python3 skill://agentic-scaffold/scripts/scaffold.py plugins sync --check --root R
```

Layer `[plugins]` entries are unioned into `.omp/plugins.toml`; existing marketplaces and plugin names are never removed. Existing entries win source and order conflicts. `speckit=true` appends `speckit` from the srobroek marketplace.

`plugins sync` registers missing marketplaces and installs missing plugins with `--scope project`. The user-scope set is never changed. `--check` performs no mutations and exits 1 when desired state is not installed.

The installed registry is `.omp/plugins/installed_plugins.json`; everything below `.omp/plugins/` is runtime state and should stay ignored. Verify with `omp plugin list --json` and confirm project scope.
