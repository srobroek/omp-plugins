# find-tools

Discover and vet reusable skills, agents, and MCP servers. Start with OMP-native discovery;
an empty `omp plugin discover` result does not prove that a capability is absent.

The read-approved discovery tool never acquires or executes the skills CLI package.
`skills_cli` remains a reported gap, including when explicitly selected; running it
requires separate explicit approval after vetting the package. No `npx` fallback runs.

Subprocesses retain at most 64 KiB combined output and have a 10-second deadline
plus at most one second of collection cleanup. Cancellation stops collection and
kills the POSIX process group (the direct child on Windows). Process-group termination
cannot reach detached descendants outside that group; collection still closes their pipes.

Local MCP inventory reports counts of configured, disabled, stdio, and remote servers.
It omits:

- server names
- commands
- URLs
- arguments
- environment variables
- headers
- parser diagnostics

## Skills

| Name | When |
|------|------|
| `find-tools` | Find a capability or decide adopt / reject / build |
| `setup-tools` | Install a project's plugins, skills, and MCP servers, project-scoped, from tiered approved sources |

## Setup sources

`setup-tools` searches three tiers in order:

1. the `srobroek-omp` catalog
2. a fixed list of approved third-party marketplaces
3. open search, when the user asks or when no earlier tier covers a capability

Open search starts with the read-only `find_tools_scan`. The skills CLI (`skills@1.7.0`)
and the Smithery CLI (`smithery@1.2.0`) run only after explicit approval, because both
execute downloaded package code. Installs default to project scope in the canonical project
root (the main worktree), so they outlive linked worktrees:

| Kind | Lands in |
|---|---|
| Marketplace plugin, `--scope project` | `.omp/plugins/installed_plugins.json` |
| Skill, `skills add -a universal` | `.agents/skills/` |
| MCP server | `.omp/mcp.json` |

`omp plugin marketplace add` registers a catalog user-wide, and an npm plugin package
installs user-wide; the skill asks before either.
