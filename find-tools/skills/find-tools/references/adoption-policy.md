# Adoption Policy

## Decisions

- `Use existing`: already available locally (`omp plugin list`, MCP config, or
  a registered marketplace).
- `Adopt`: add a marketplace (`omp plugin marketplace add <owner/repo>`) and
  install the plugin, or add an MCP server to `~/.omp/agent/mcp.json`.
- `Trial`: useful but risky or unclear; test temporarily without changing
  project source or user-global config until approved.
- `Reject`: unsafe, stale, unlicensed, duplicate, incompatible, or too weak.
- `Build`: no good existing capability fits.

## Project-only adoption

Use when the tool is useful for one repo, not yet generally proven, or already
installable from a registered marketplace.

1. Inspect `omp plugin list` and project MCP config.
2. Prefer `omp plugin install <plugin>@<marketplace>` or a project-scoped
   marketplace add.
3. Do not edit first-party plugin source unless the user asks to promote it.

## Marketplace adoption

Use when the tool should become reusable across machines.

1. Prefer an upstream catalog (`.omp-plugin/marketplace.json` or Claude
   fallback `.claude-plugin/marketplace.json`) and
   `omp plugin marketplace add <owner/repo>`.
2. Do not vendor third-party skill trees into `omp-plugins` when a catalog
   exists.
3. Smoke-test install when network and approvals allow.

## Quality bar

Evaluate serious candidates for:

- popularity: installs, downloads, stars, usage
- maintenance: recent commits/releases, maintainer identity, issue response
- code quality: clear source, tests/CI, schemas, typed config, error handling
- security: license, secrets, destructive permissions, telemetry, install path
- fit: overlap with installed plugins, local-vs-hosted tradeoff, simplicity

Reject prompt-only wrappers around tools already exposed cleanly, broad secret
requirements without strong reason, hidden install scripts, missing licenses, or
duplicates of a better-maintained installed plugin.
