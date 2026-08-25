# PROJECT_NAME

<!-- PROJECT DESCRIPTION: to be filled by agent -->

## Agent Guidance

<!-- CODEX/AGENTS GUIDANCE: to be filled by agent -->

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

## Path Mapping

| Path | Contents |
|------|----------|
| `docs/` | Documentation — `architecture/`, `decisions/` (ADRs), `api/`, `research/`, `runbooks/`, `product/`, `engineering/`, `operations/` |
| `specs/` | Feature specifications (speckit) |
| `infrastructure/` | Infrastructure config — `environments/` and `terraform/{modules,stacks,environments}/` |
| `tests/` | Integration and E2E tests |
| `scripts/` | Build tooling, automation |
| `assets/` | Static files |
| `archive/` | Retired / archived material |

## Build & Run

<!-- BUILD COMMANDS: to be filled by agent after language setup -->

## Repo

- **GitHub**: ORG/PROJECT_NAME
- **Branch strategy**: feature branches off main, squash merge
