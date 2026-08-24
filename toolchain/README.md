# toolchain

Stack defaults, `scripts/` vs `tools/`, produce-rules, and where agentic assets live.

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
| `toolchain-pragmatic` | Produced-artifact register. |
| `toolchain-asset-ownership` | OMP vs chezmoi vs marketplace. |
| `coexistence-worktree` | Concurrent agents/humans, interference, branch stolen. |
| `shell-language` | Shell portability, quoting, command safety. |
