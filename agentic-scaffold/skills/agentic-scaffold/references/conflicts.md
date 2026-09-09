# Conflicts and escalation

LOAD when `inspect`, `plan`, `render`, or `doctor` reports an escalation. Exit 5 means a user choice is required; do not guess.

| Case | Detection | Resolution |
|---|---|---|
| Two layers own one path | `plan` | Drop a layer or `--force-layer L` for this run. |
| `conflicts_with` pair | `plan` | Change profile/layers. |
| Existing user file | `plan` class `skip` | Preserve it; propose a diff. `--adopt PATH` moves it to `.scaffold-orig`. |
| Damaged/duplicated markers | `render` | Restore the expected pair printed in the error. |
| Foreign hooks (`husky`, `lefthook`, `core.hooksPath`) | `inspect` finding `hook-manager` | Migrate with `hooks install --migrate`, or skip hooks. |
| Existing `.omp/mcp.json` | `render` | Deep-merge `mcpServers`; existing keys win; report additions. |
| Existing `.omp/plugins.toml` | `render` | Union marketplaces/plugins; never remove entries. |
| Existing `mise.toml`, `justfile`, prek config, `.gitignore` | `render` | Update managed block only; TOML `[tools]` keys are deduplicated with `tomllib`. |
| Missing tool | `inspect`/`doctor` | Run `tools install --yes` or report the install command. |
| Unowned `.omp/context.py` or project context | `inspect` | Require explicit `--adopt`; never auto-adopt. |

Merging rules: TOML is key-level append inside managed blocks; JSON is existing-wins deep merge; YAML `repos:` remains a text managed block; plain text is a managed block. Exit 0 is success, 1 is operational error, 2 is drift, and 5 is conflict.
