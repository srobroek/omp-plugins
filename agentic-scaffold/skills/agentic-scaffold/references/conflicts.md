# Conflicts and escalation

LOAD when `inspect`, `plan`, `render`, or `doctor` reports an escalation. Exit 5 means a user choice is required; do not guess.

| Case | Detection | Resolution |
|---|---|---|
| Two layers own one path | `plan` | Drop a layer or `--force-layer L` for this run. |
| `conflicts_with` pair | `plan` | Change profile/layers. |
| Existing user file | `plan` class `skip` | Preserve it; propose a diff. `--adopt PATH` moves it to `.scaffold-orig`. |
| Damaged/duplicated markers | `render` | Restore the expected pair printed in the error. |
| Foreign hooks (`husky`, `lefthook`, `core.hooksPath`) | `inspect` finding `hook-manager` | Choose one: `hooks install --force` to let prek install in repository hooks, move `core.hooksPath` to repository scope, or skip hooks. A global `core.hooksPath` refusal returns exit 2 with all three options; it is not a raw stderr error. |
| Existing `.omp/mcp.json` | `render` | Deep-merge `mcpServers`; existing keys win; report additions. |
| Existing `.omp/plugins.toml` | `render` | Union marketplaces/plugins; never remove entries. |
| Existing `mise.toml`, `justfile`, prek config, `.gitignore` | `render` | Update managed block only; TOML `[tools]` keys are deduplicated with `tomllib`. Tools come from selected layer `[tools]` tables. |
| Missing tool | `inspect`/`doctor` | Run `tools install --yes` or report the install command. |
| Unowned `.omp/context.py` or project context | `inspect` | Require explicit `--adopt`; never auto-adopt. |

A foreign block in `AGENTS.md` is not a conflict: append the managed block and preserve the foreign block. A symlink target or damaged/duplicated agentic-scaffold markers is a conflict.

When `core.hooksPath` is configured globally or system-wide and `git-defender` is on `PATH`, choose the chained strategy: `hooks install` runs `git-defender precommit-tool-setup` in the repository, which creates `.git/hooks/pre-commit` for the system hook to chain and leaves pre-push to the git shim running `prek --stage pre-push`; `commit-msg` and `post-commit|post-checkout|post-merge` do not run (use `just context` for context refresh). If `git-defender` is unavailable, retain the `hook-manager` finding and resolve it with `--force`, repository-scoped hooks, or an explicit skip.

Merging rules: TOML is key-level append inside managed blocks; JSON is existing-wins deep merge; YAML `repos:` has one shared header and each layer contributes list entries; plain text is a managed block. Exit 0 is success, 1 is operational error, 2 is drift, and 5 is conflict.
