---
name: rust-tauri-mcp-bridge
description: When building, testing, or driving a running Tauri v2 app through a Tauri MCP bridge — dev-only safety gating, the withGlobalTauri overlay, host/port override, and WSL-to-Windows connectivity.
globs: ["**/tauri.conf.json", "**/src-tauri/**"]
---

# Tauri MCP bridge

Use a Tauri MCP server to build, test, debug, and drive a running Tauri v2 desktop or
mobile app. It connects to the app over a WebSocket bridge; the app must be running,
with the bridge listening on port 9223.

## Safety: dev builds only

The MCP surface has two halves, and shipping either in a release build hands remote
control of the app to anything that can reach it:

- The `tauri-plugin-mcp-bridge` crate opens a local control WebSocket inside the app.
  Gate it behind `#[cfg(debug_assertions)]` or a dedicated dev feature flag.
- `withGlobalTauri` exposes the full Tauri API on `window.__TAURI__` (the bridge needs
  it to drive the webview). Enable it only through a dev config overlay, never in the
  base `tauri.conf.json`.

## Dev-only `withGlobalTauri` overlay

`withGlobalTauri` injects `window.__TAURI__` into the webview, exposing `invoke`,
`event`, and the rest without importing `@tauri-apps/api`. Frontends that reach the
backend through generated bindings (e.g. tauri-specta) never use the global at
runtime, so production does not need it. Tauri v2 does not auto-merge debug/release
config, but supports an explicit overlay via `--config`:

1. Leave the base `tauri.conf.json` with `withGlobalTauri` off (the default).
2. Add a dev overlay, e.g. `src-tauri/tauri.dev.conf.json`:
   `{ "app": { "withGlobalTauri": true } }`
3. Run dev with the overlay: `tauri dev --config src-tauri/tauri.dev.conf.json`.
   A plain `tauri build` omits the overlay, so release builds stay clean.

## Host / port override

The default target is `localhost:9223`. Redirect when the app is not on the same
loopback as the MCP server: pass a `host` parameter to the `driver_session` tool, or
set `MCP_BRIDGE_HOST`, `TAURI_DEV_HOST`, `MCP_BRIDGE_PORT`. The bridge binds
`0.0.0.0` by default, so non-localhost clients (network mobile devices, a WSL-hosted
agent reaching a Windows app) can connect.

## WSL2 agent driving a Windows app

In WSL2's default NAT networking, WSL `localhost` is not the Windows host, so the
default target is unreachable. Preferred fix on Windows 11 22H2+ with WSL >= 2.0:
mirrored networking, in `%UserProfile%\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
```

Then `wsl --shutdown` and restart; `localhost` now reaches the Windows app.

NAT fallback: point the client at the Windows host IP — from WSL it is the default
gateway (`ip route show default | awk '{print $3}'`) — via `MCP_BRIDGE_HOST` or the
`driver_session` `host` parameter. Windows Defender Firewall must allow inbound TCP
9223 on the WSL / vEthernet network, or the connection is silently dropped.

Troubleshooting order: app actually running; `tauri-plugin-mcp-bridge` present in
this dev build; gateway IP correct; firewall inbound rule for 9223; `MCP_BRIDGE_HOST`
exported (NAT) or mirrored networking enabled.
