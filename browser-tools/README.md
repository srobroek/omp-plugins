# browser-tools

Cross-engine browser coverage and Chrome performance tracing over MCP.

## MCP servers

| Name | What OMP `browser` does not provide |
|------|-------------------------------------|
| `chrome-devtools` | `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight` turn a trace into Core Web Vitals insights; source-mapped console stacks. `--no-usage-statistics` is required because telemetry is on by default. |
| `playwright-cross-engine` | Firefox, WebKit, and Edge engines plus device profiles. OMP's browser is Chromium only. |

OMP's `browser` already covers ARIA snapshots, the accessibility tree, computed styles, screenshots, keyboard input, viewport sizing, and request interception. Neither server is used for those.

MCP servers connect only at session startup. An agent cannot reconnect them. A server unreachable at session start stays unreachable until the user runs `/mcp reconnect <name>`.

## Licences

| Package | Licence |
|---------|---------|
| `chrome-devtools-mcp` | Apache-2.0 |
| `@playwright/mcp` | Apache-2.0 |
