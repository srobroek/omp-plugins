# diagram

Interactive diagramming and architecture-sketching canvas over MCP.

## MCP servers

| Name | What it provides |
|------|------------------|
| `excalidraw` | Its own interactive canvas for diagramming, flow, and architecture sketching. |

Plugin MCP tools are session-global, so this server serves any such work, not design work only. It needs a client that supports MCP Apps.

MCP servers connect only at session startup. An agent cannot reconnect them. A server unreachable at session start stays unreachable until the user runs `/mcp reconnect <name>`.

## Licences

`@mcp-demos/excalidraw-server` declares MIT in its `package.json` but ships no LICENSE file. It is advertised as a pointer and is never vendored.
