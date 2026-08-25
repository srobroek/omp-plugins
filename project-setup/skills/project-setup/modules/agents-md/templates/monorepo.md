# PROJECT_NAME

<!-- PROJECT DESCRIPTION: to be filled by agent -->

## Agent Guidance

<!-- CODEx/AGENTS GUIDANCE: to be filled by agent -->

## AGENTS Layering

- This root `AGENTS.md` applies to the whole repository unless a deeper file overrides it.
- Put repo-wide workflow, architecture, tool, and source-of-truth guidance here.
- Add nested `AGENTS.md` files only for subtrees that need materially different rules.
- Prefer subtree placement over invented path metadata.

## Codex Project Settings

- Project and subfolder Codex overrides live in `.codex/config.toml`.
- MCP servers for this repo or subtree should be declared under `mcp_servers.<name>` in `.codex/config.toml`.
- Keep repo-specific Codex settings here and leave user-global defaults in `~/.codex/config.toml`.

## Architecture

<!-- BEGIN ps:architecture -->
<!-- END ps:architecture -->

## Monorepo Structure

| Path | Contents |
|------|----------|
| `apps/` | User-facing app surfaces |
| `services/` | Long-lived backend deployables |
| `functions/` | Serverless handlers, nested by platform |
| `workers/` | Background jobs and consumers, nested by platform |
| `libs/` | Internal shared code by architectural role |
| `packages/` | Published or independently versioned packages |
| `schemas/` | Shared/public contracts |
| `data/` | Shared data assets where no single owner exists |
| `docs/` | Project-wide documentation |
| `specs/` | Feature specifications |
| `infrastructure/` | Shared platform and IaC |
| `tests/` | Cross-package integration and E2E tests |
| `tools/` | Maintained CLIs, generators, and repo tooling |
| `scripts/` | Thin repo automation |
| `assets/` | Static files |
| `archive/` | Archived/superseded material |

## Packages

<!-- PACKAGES: to be filled as packages are added -->

## Build & Run

<!-- BUILD COMMANDS: to be filled by agent after language setup -->

## Repo

- **Branch strategy**: feature branches off main, squash merge
