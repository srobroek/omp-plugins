# browser-tools

Cross-engine browser coverage and Chrome performance tracing over MCP.

## Install

```bash
omp plugin marketplace add srobroek/omp-plugins
omp plugin install browser-tools@srobroek-omp
```

OMP discovers plugins and connects MCP servers at startup, so both servers become available
in the NEXT session. `omp plugin list` then reports `browser-tools@srobroek-omp (0.1.0)`.

## MCP servers

| Name | What OMP `browser` does not provide |
|------|-------------------------------------|
| `chrome-devtools` | `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight` turn a trace into Core Web Vitals insights; source-mapped console stacks. `--no-usage-statistics` is required because telemetry is on by default. |
| `playwright-cross-engine` | Firefox, WebKit, and Edge engines plus device profiles. OMP's browser is Chromium only. |

OMP's `browser` already covers these, so neither server is used for them:

- ARIA snapshots
- the accessibility tree
- computed styles
- screenshots
- keyboard input
- viewport sizing
- request interception

MCP servers connect only at session startup. An agent cannot reconnect them. A server unreachable at session start stays unreachable until the user runs `/mcp reconnect <name>`.

## Licenses

| Package | License |
|---------|---------|
| `chrome-devtools-mcp` | Apache-2.0 |
| `@playwright/mcp` | Apache-2.0 |
