# Adoption Policy

## Decisions

- `Use existing`: already installed or configured (`omp plugin list`, MCP
  config). A plugin that a registered marketplace only lists is `Adopt`.
- `Adopt`: install at project scope with `skill://setup-tools`:
  `omp plugin install <plugin>@<marketplace> --scope project`, or an MCP entry
  in the project's `.omp/mcp.json`. Install user-wide only when the user asks.
- `Trial`: useful but risky or unclear; test temporarily without changing
  project source or user-global config until approved.
- `Reject`: unsafe, stale, unlicensed, duplicate, incompatible, or too weak.
- `Build`: no good existing capability fits.

## Project-only adoption

Use when the tool is useful for one repo, not yet generally proven, or already
installable from a registered marketplace.

1. Inspect `omp plugin list` and project MCP config.
2. Install with `skill://setup-tools`, which installs at project scope into the
   canonical project root.
3. Do not edit first-party plugin source unless the user asks to promote it.

## Marketplace adoption

Use when the tool should become reusable across projects and machines.

1. Prefer an upstream catalog (`.omp-plugin/marketplace.json` or Claude
   fallback `.claude-plugin/marketplace.json`) and
   `omp plugin marketplace add <owner/repo>`. Registration is user-wide and
   adds a catalog, not a plugin; each project still installs at project scope.
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
