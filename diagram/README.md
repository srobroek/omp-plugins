# diagram

Use this plugin to draw diagrams and sketch architecture in an interactive canvas through MCP.

## Install

```bash
omp plugin marketplace add srobroek/omp-plugins
omp plugin install diagram@srobroek-omp
```

OMP discovers plugins at startup. After installation, start a new session and
confirm that `omp plugin list` reports `diagram@srobroek-omp`.

## MCP server

OMP names the marketplace entry `diagram:excalidraw`. It stays disabled. The
configuration below adds a separate native server named `excalidraw` with the
`https://mcp.excalidraw.com/mcp` endpoint. Add it to `.omp/mcp.json` for one
project or to `~/.omp/agent/mcp.json` for your user:

```json
{
  "mcpServers": {
    "excalidraw": {
      "url": "https://mcp.excalidraw.com/mcp",
      "enabled": true
    }
  }
}
```

Put this override in the active profile's user file. Use `~/.omp/agent/mcp.json` for the default profile or `~/.omp/profiles/<name>/agent/mcp.json` for a named profile:

```json
{
  "enabledServers": ["excalidraw"]
}
```

`excalidraw` is the server key declared by both the package manifest and its
`.mcp.json`; do not use `diagram:excalidraw` as an enable key.

Use a client that supports MCP Apps. OMP exposes the connected server's tools
for the full session, not only during design work.

OMP reads MCP configuration and connects enabled servers at session startup.
If `excalidraw` is missing from the session, first confirm the package is
installed and the override is in the active profile. Start a new session after
changing configuration. If the hosted server was unavailable at startup, run
`/mcp reconnect excalidraw` to retry the connection. An agent cannot run that
slash command.

If reconnect still fails, check the hosted endpoint and network access, then
retry in a new session.

## Data handling

Diagram requests go to the hosted service. Its retention period remains unverified.
Before sending confidential diagrams, get approval to disclose them to that service.

To run the server locally, build it from the [upstream source](https://github.com/excalidraw/excalidraw-mcp).
