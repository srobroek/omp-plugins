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

The next two active-profile snippets are alternatives to the native entry above and to each other. Use only the snippet for the carrier that supplies the disabled server. Do not combine them.

### OMP package mirror (`diagram/.mcp.json`)

Use the bare key declared by the package mirror:

```json
{
  "enabledServers": ["excalidraw"]
}
```

### Marketplace entry (`diagram:excalidraw`)

Use `diagram:excalidraw`, the marketplace runtime key named above. The loader documentation says `enabledServers` can force-enable a same-named disabled entry. The same contract accepts `:` in runtime names:

```json
{
  "enabledServers": ["diagram:excalidraw"]
}
```

Use a client that supports MCP Apps. OMP exposes the connected server's tools
for the full session, not only during design work.

OMP reads MCP configuration and connects enabled servers at session startup.
After you add the native entry, start a new session. If the hosted server was
unavailable at startup, run `/mcp reconnect excalidraw`. An agent cannot run that slash
command.

## Data handling

Diagram requests go to the hosted service. Its retention period remains unverified.
Before sending confidential diagrams, get approval to disclose them to that service.

To run the server locally, build it from the [upstream source](https://github.com/excalidraw/excalidraw-mcp).
