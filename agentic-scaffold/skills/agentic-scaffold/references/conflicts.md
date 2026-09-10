# Conflicts and escalation

Load when `preflight`, `interview`, `apply`, `doctor`, or `finish` reports a problem. Every command
emits JSON with `root`. Exit `5` means a human choice is required; exit `6` means the boundary
refused a path or command. Stop and report both JSON and exit code; never guess.

| Case | Detection | Resolution |
|---|---|---|
| Two layers own one path | `apply` plan stage, exit `5` | Drop a layer or select `--force-layer L` in the approved answers. |
| `conflicts_with` pair | `apply` plan stage, exit `5` | Change profile or selected layers, then rerun interview and answers. |
| Existing user file | plan row `class: skip` | Preserve it; propose a diff. Use explicit `--adopt PATH` only after approval. |
| Damaged or duplicated marker | render stage, exit `5` | Restore the printed marker pair; never guess or hand-edit around it. |
| Foreign hooks (`husky`, `lefthook`, `core.hooksPath`) | preflight `hook_strategy` | Preflight chooses the strategy from what is installed; hooks chain through it. Ask only when the CLI emits a `finding:hook-manager` question, offering repository hooks, migration, or skip. |
| Missing tool | preflight or doctor | Use the pipeline's tools stage and project-local mise pin; never install globally. |
| Unowned `.omp/*` file | preflight finding `unowned-file` | Ask for explicit adoption, then pass `--adopt PATH`. |
| Unmanaged workspace member | interview or plan | Use `member import --dir D --layer lang/X`; member imports preserve files. |
| Root language plus workspace | plan stage, exit `5` | Remove root `lang/*`; add the language through `member add`. |

## Boundary refusals

While `.omp/scaffold-run.json` exists, the boundary extension blocks direct `write`, `edit`, and
`ast_edit` outside `root` or at paths listed in `.omp/scaffold.json` `owned_hashes`. It blocks
`eval`, global config, unsafe plugin changes, global mise changes, package installs, `sudo`, pushes,
amended commits, `chezmoi apply|init|update`, and absolute or home-relative writes outside root.
Retry through the `scaffold` tool's `apply` command. Do not remove the marker to bypass a failure;
`finish` removes it after verification.

## Merge rules

- `.omp/plugins.toml`: union marketplaces and plugin names; existing entries win.
- `.omp/mcp.json`: deep merge; existing keys win.
- `mise.toml` `[tools]`: append only missing keys in the managed block.
- `.pre-commit-config.yaml`: append hook entries in the managed `repos:` block.
- Other block targets: one marker pair per layer, replaced in place.

Exit codes are `0` success, `1` operational error, `2` drift, `3` needs input, `5` conflict, and
`6` boundary. `doctor` returns `2` for missing hooks, tools, plugins, context, or damaged markers;
`finish` returns `2` while any such drift, open molecule child, or uncommitted scaffold-owned path
remains.
