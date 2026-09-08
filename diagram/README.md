# diagram

Use this plugin to draw diagrams and sketch architecture in an interactive canvas through MCP.

## Install

```bash
omp plugin marketplace add srobroek/omp-plugins
omp plugin install diagram@srobroek-omp
```

OMP discovers plugins and connects MCP servers at startup. After installation, start a new session to use the server.
In that session, `omp plugin list` reports `diagram@srobroek-omp`.

## MCP servers

The `excalidraw` server uses this endpoint: `https://mcp.excalidraw.com/mcp`.
You need a client that supports MCP Apps. Plugin tools are available throughout the session, so you can use this server beyond design work.

MCP servers connect only at session startup. An agent cannot reconnect them. A server unreachable at session start stays unreachable until the user runs `/mcp reconnect <name>`.

## Data handling

Diagram requests go to the hosted service. Its retention period remains unverified.
Before sending confidential diagrams, get approval to disclose them to that service.

To run the server locally, build it from the [upstream source](https://github.com/excalidraw/excalidraw-mcp).
