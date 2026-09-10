# Architecture

## Runtime boundary

`skills/agentic-scaffold/scripts/scaffold.py` is the whole runtime. It imports only the standard library. Declared integrations run as subprocesses: `omp`, `prek`, `mise`, `git`, `git-defender`.

Every command prints one JSON document. The exit code carries the verdict:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | operational error |
| 2 | drift (`doctor`, `plugins sync --check`) |
| 5 | conflict (`plan`, `render`) |

## Variable resolution

The CLI builds one variable map first. Later sources override earlier ones:

1. `layer.toml [vars]` defaults
2. `profiles/<name>.toml [vars]`
3. `.omp/scaffold-answers.toml`
4. `--var` and `--set` on the command line

The same map feeds every template, so a second render produces no diff.

## Layers

A layer is one directory under `templates/`. It holds:

- `layer.toml`: the layer contract
  - `after`: render order
  - `requires_tools`
  - `owns`: whole files
  - `blocks`: managed-block targets
  - `conflicts_with`: exclusive layers
  - `[vars]` and `[plugins]`
- `README.md`: a short description
- template files

Template rules:

- A file ending in `.tmpl` passes through `string.Template`. The renderer removes the suffix.
- A path segment `__name__` becomes the package name.
- A file ending in `.block` becomes one managed block inside a shared target such as `.gitignore` or `justfile`.

The `web-ui` layer has no owned files. It contributes an `AGENTS.md` block and plugin entries.

## Profiles

A profile lists ordered layers, variable overrides, and the five standard commands (`setup`, `test`, `lint`, `fmt`, `check`). Plugin sets live in layers, not in profiles.

## Merge rules

| Target | Rule |
|---|---|
| `.omp/plugins.toml` | union. Existing marketplaces and plugin names stay. |
| `.omp/mcp.json` | deep merge. Existing keys win. |
| `mise.toml` `[tools]` | parse with `tomllib`. Append only missing keys inside the block. |
| `.pre-commit-config.yaml` | insert hook entries inside the existing `repos:` list |
| other block targets | one marker pair per layer, replaced in place |

## State files

| File | Content | Committed |
|---|---|---|
| `.omp/scaffold-answers.toml` | interview answers | yes |
| `.omp/scaffold.json` | profile, layers, plugin version, owned-file hashes | yes |
| `.omp/plugins/` | OMP project registry and symlinks | no |

## Commands

| Command | Reads | Writes |
|---|---|---|
| `inspect` | repository | nothing. Reports stacks, tools, and findings (`hook-manager`, `unowned-file`). |
| `plan`, `render --dry-run` | repository, profile | nothing. Exit 5 on a conflict. |
| `render` | plan | owned files, managed blocks, state files |
| `update` | `.omp/scaffold.json` | managed blocks. Drifted owned files stay untouched. |
| `doctor` | rendered repository | nothing. Exit 2 on drift. |

## Formulas

Two bd formulas pour the same steps as the runbook. Each formula has two human gates. The first gate follows the interview. The second gate precedes the commit.

## Workspace rendering

The `monorepo` profile selects the root `workspace` layer.

- Answers store `name`, `layer`, `kind`, and `dir` for each member.
- The engine renders root layers before member layers.
- Each member layer receives its own variable scope.
- Managed blocks resolve at the repository root.

Python and TypeScript members use `packages/<name>`. Rust members use `crates/<name>`. Go members use `cmd/<name>` or `services/<name>`. Each family gets one manifest. Release configuration gets one package entry per member.

Language layers add namespaced recipes, scoped hooks, and member CI jobs. Root recipes call each member. The renderer does not write member `mise.toml` files. Root tools remain authoritative.

The `moon` layer requires `workspace`. The `worktrunk` layer works with any profile. `layers show` reports both layers. The renderer reads their template directories.
