# toolchain

Stack defaults, backend services, infrastructure, operations, `scripts/` vs `tools/`, produce-rules, and where agentic assets live.

Does not tell the agent to prefer `rg`/`fd`/`eza`/`bat` in bash: OMP routes those to native tools.

## Rules

| Name | When |
| --- | --- |
| `toolchain-stack-defaults` | Stack, package manager, task runner, deps. |
| `toolchain-frontend` | Frontend framework / state. |
| `toolchain-infrastructure` | Infra tool choice. |
| `toolchain-languages` | Per-language library picks. |
| `toolchain-quality-observability` | Logs, traces, scanners. |
| `toolchain-tools-scripts` | `scripts/` and `tools/`. |
| `toolchain-asset-ownership` | OMP vs chezmoi vs marketplace. |
| `coexistence-worktree` | Concurrent agents/humans, interference. |
| `shell-language` | Shell portability, quoting, command safety. |

Merged topic rules include `backend-background-jobs`, `terraform-language`, `infrastructure-tfstate-guard`, `ops-toolchain-cache-policy`, and `ops-no-global-cargo-target`.

## Agents

The operational data agents `maintenance-metrics-reader` and `data-metrics-summarizer` live here alongside the toolchain rules.

## Extensions

- `dep-manifest-advisory`: advises the package-manager CLI when an edit lands in a dependency table of `package.json`, `Cargo.toml`, `pyproject.toml`, or `go.mod`
- `prefer-tools-advisory`: advises the modern tool when bash reaches for npm/yarn, pip/poetry, nvm/pyenv, or make in a tree already configured for bun, uv, mise, or just
