# Agentic scaffold architecture

## Runtime

| Component | Contract |
|---|---|
| Python CLI | Standard-library runtime with subprocess integrations. |
| `scaffold` tool | Accepts an enum command and a string array. Adds `--root` from session cwd. |
| Process launch | Calls `python3` with `execFile`. Disables the shell. Uses a ten-minute timeout. |
| Argument guard | Rejects root overrides, NUL, newline, and traversal. |
| JSON proof | Compares JSON `root` with the real session cwd. A mismatch returns exit `6` and discards output. |

## Lead boundary

While `.omp/scaffold-run.json` exists, the extension acts.

It blocks:

- direct writes outside the root
- direct writes to `owned_hashes` paths
- inline `eval`
- global OMP configuration
- global mise changes
- user-scope plugin changes
- unsafe package installs
- pushes and amended commits
- `chezmoi apply`, `chezmoi init`, and `chezmoi update`
- `sudo`
- absolute writes outside the root
- home-relative writes

It allows read-only inspection. It allows project-scope CLI operations. It allows `bd` and `just`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | operational error |
| 2 | drift |
| 3 | required input |
| 5 | conflict |
| 6 | boundary refusal |

Every command emits one JSON object with the resolved `root`.

## Pipeline

| Stage | Responsibility |
|---|---|
| `preflight` | Check the repository and tools. |
| `plan` | Classify writes. Refuse ownership conflicts. |
| `render` | Write owned files under the root. |
| `tools-install` | Pin project tools through mise. |
| `hooks-install` | Install hooks with the selected strategy. |
| `plugins-sync` | Union desired plugins. Install at project scope. |
| `context-refresh` | Refresh selected agentic context. |
| `doctor` | Report drift in rendered state. |

`apply --dry-run` runs `preflight`, `plan`, and the `provision` dry run. It writes no files. A live run
returns `ok`, `stages`, and optional `next`. Each stage row has these fields:

- `name`
- `status`
- `seconds`
- `summary`

`finish` checks doctor, molecule state, and git status. It returns `commitCommand` on success. It
removes the run marker. It never commits.

## State

| Path | Purpose | Commit |
|---|---|---|
| `.omp/scaffold-answers.toml` | Human answers. | yes |
| `.omp/scaffold-run.json` | Active run marker. | no |
| `.omp/scaffold.json` | Profile and owned hashes. | yes |
| `.omp/plugins.toml` | Desired plugin state. | yes |
| `.omp/plugins/` | Project plugin registry. | no |
| `mise.toml` | Project tool pins. | yes |

The CLI writes only inside the root. It preserves content outside managed blocks. It keeps JSON and
TOML keys. It unions plugin entries.

## Delegation

| Role | Responsibility |
|---|---|
| Lead | Call the five verbs in order: `start`, `interview` until `complete`, `plan`, `run`, `finish`. Relay each `ask`. |
| Human | Approve answers, plan, and `commitCommand`. |

The lead reports non-zero JSON verbatim. It never commits.

## Layers and members

A layer declares its contract in `layer.toml`. The contract names:

- tools
- files and blocks
- variables
- conflicts
- plugins

A profile composes layers. A workspace records members. Imports preserve
files. Removal never deletes files.
