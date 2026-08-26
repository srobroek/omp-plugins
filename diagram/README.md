# diagram

Interactive diagramming and architecture-sketching canvas over MCP.

## Install

```bash
omp plugin marketplace add srobroek/omp-plugins
omp plugin install diagram@srobroek-omp
```

OMP discovers plugins and connects MCP servers at startup, so the server becomes available
in the NEXT session. `omp plugin list` then reports `diagram@srobroek-omp (0.1.0)`.

## MCP servers

| Name | What it provides |
|------|------------------|
| `excalidraw` | Its own interactive canvas for diagramming, flow, and architecture sketching. |

Plugin MCP tools are session-global, so this server serves any such work, not design work only. It needs a client that supports MCP Apps.

MCP servers connect only at session startup. An agent cannot reconnect them. A server unreachable at session start stays unreachable until the user runs `/mcp reconnect <name>`.

## Licenses

`@mcp-demos/excalidraw-server` declares MIT in its `package.json` but ships no LICENSE file. It is advertised as a pointer and is never vendored.
