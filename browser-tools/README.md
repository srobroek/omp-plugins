# browser-tools

Headed, profile-aware WebDriver BiDi automation plus cross-engine coverage and Chrome performance tracing over MCP.

## Install

```bash
omp plugin marketplace add srobroek/omp-plugins
omp plugin install browser-tools@srobroek-omp
```

OMP discovers extensions and MCP servers at session startup. Start a new session after installation, then run:

```bash
omp -p 'headed_session op:"preflight"'
```

Configure persistent defaults under `/settings` → Plugins → `@srobroek/browser-tools`. Every setting can be overridden by `headed_session op:"launch"`; remote SSH parameters exist only on that launch call.

## Headed browser tools

| tool | purpose | approval |
|---|---|---|
| `headed_session` | preflight, launch, status, tabs, scoped cookie grants, artifacts, close | exec |
| `headed_nav` | navigation, waits, viewport, and tab management | write |
| `headed_read` | DOM snapshot, screenshot, evaluate, cookies, console, network metadata, metrics, PDF, HTML | read |
| `headed_act` | click, type, press, scroll, select, upload, dialog, clear, hover, focus | write |

The browser always launches from an empty, dedicated, or throwaway cloned profile. It never opens the live profile. An ephemeral launch copies only cookies named by `cookieDomains`; an empty list copies no cookies. Expand scope later with `headed_session op:"grantCookies" domains:"example.com"`.

```text
headed_session op:"launch" engine:"firefox" browserChannel:"zen" cookieDomains:"example.com"
headed_nav op:"goto" sessionId:"hb-…" url:"https://example.com"
headed_read op:"snapshot" sessionId:"hb-…"
headed_session op:"close" sessionId:"hb-…"
```

Sessions persist across turns until closed or idle for `idleCloseSec`. `op:"close"` deletes the temporary profile, downloads, and artifacts unless `keepArtifactsOnClose` is enabled. Use `op:"artifacts"` and copy needed files out before closing.

## Browser support

The headed tools use the host `puppeteer-core` package. The verified implementation target is `puppeteer-core@25.3.0`.

| target | browsers | protocol | status |
|---|---|---|---|
| Firefox | Firefox, ESR, Developer, Nightly, LibreWolf, Waterfox | WebDriver BiDi | primary target; requires Gecko 129 or newer |
| Zen 1.21.10b | Zen | WebDriver BiDi | detected on macOS, but this build timed out before publishing Puppeteer's WebSocket endpoint; select `firefox` instead |
| Chrome | Chrome, Canary, Chromium, Edge, Brave, Vivaldi | WebDriver BiDi via `protocol: "webDriverBiDi"` | selectable per launch; built-in `browser` remains cheaper for plain Chromium diagnostics |
| WebKit/Safari | Not applicable | Not applicable | Puppeteer cannot drive this family. `playwright-cross-engine` covers it, but ships disabled; see MCP servers below. |

WebDriver BiDi does not expose Puppeteer's accessibility tree, coverage, tracing, `Page.metrics()`, response bodies, drag APIs, offline mode, or network-condition emulation. Use the design plugin's accessibility scanner for WCAG checks and the `chrome-devtools` MCP server for Chromium traces.

## Privacy and lifecycle

- `allowedDomains` and `deniedDomains` are mutually exclusive; setting both refuses launch.
- Non-HTTP(S) navigation is always blocked.
- Downloads, form submission, password entry, file upload, and evaluation have independent feature gates. Download denial is applied at the browser's BiDi download-behavior boundary.
- Cookie values are omitted unless `exposeCookieValues` is enabled. Secret-shaped output is redacted by default.
- Audit records are appended to `<agentDir>/headed-browser-audit/<date>-<session>.jsonl` unless `auditDir` overrides it.
- Remote mode is Firefox-only and experimental. It fails explicitly when the remote binary is absent or Puppeteer cannot connect to the advertised BiDi endpoint.

## MCP servers

| name | capability | default |
|---|---|---|
| `chrome-devtools` | Chromium performance traces, Core Web Vitals insights, and source-mapped console stacks; telemetry is disabled with `--no-usage-statistics` | enabled |
| `playwright-cross-engine` | WebKit engine and device-profile checks | **disabled** |

`playwright-cross-engine` ships disabled because `@playwright/mcp` launches its browser
lazily, at the first tool call rather than at startup. The server therefore connects and
advertises all 24 of its tools with no WebKit build present, and the failure arrives later
as `Browser webkit is not installed` from whichever tool call happened to be first. A
server that mounts cleanly and then fails on use is worse than one that is absent, so the
default matches `storybook` and `excalidraw`.

Enable it per machine, after installing the browser it needs:

```sh
npx -y playwright install webkit   # roughly 100 MB
```

then set `enabled: true` for `playwright-cross-engine` in your own MCP configuration. The
plugin's declaration is the shipped default, not a ceiling.

The built-in `browser` remains the default for public headless Chromium work, ARIA snapshots, computed styles, screenshots, keyboard input, viewport sizing, and request interception. MCP servers connect only at session startup; if one is unavailable, run `/mcp reconnect <name>`.

## Licenses

| package | license |
|---|---|
| `chrome-devtools-mcp` | Apache-2.0 |
| `@playwright/mcp` | Apache-2.0 |
