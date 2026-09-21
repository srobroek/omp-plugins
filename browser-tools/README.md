# browser-tools

Headed, profile-aware WebDriver BiDi automation plus cross-engine coverage and Chrome performance tracing over MCP.

## Install

```bash
omp plugin marketplace add srobroek/omp-plugins
omp plugin install browser-tools@srobroek-omp
```

OMP discovers extensions and MCP servers at session startup. Start a new session after installation. Then run:

```bash
omp -p 'headed_session op:"preflight"'
```

Configure persistent defaults under `/settings` → Plugins → `@srobroek/browser-tools`. Override launch settings with `headed_session op:"launch"`. `driverModulePath` is trusted configuration only; remote SSH parameters are accepted only on that launch call. When host resolution is unavailable, set `driverModulePath` to a normalized absolute path to an operator-trusted `puppeteer-core` entry module. Import-time loading validates that the module exists and exports `launch` and `connect`.

## Headed browser tools

| tool | purpose | approval |
|---|---|---|
| `headed_session` | preflight, launch, status, tabs, scoped cookie grants, artifacts, close | exec |
| `headed_nav` | page and tab navigation | write |
| `headed_read` | DOM snapshot, screenshot, evaluate, cookies, console, network metadata, metrics, PDF, HTML | read |
| `headed_act` | click, type, press, scroll, select, upload, dialog, clear, hover, focus | write |
| `headed_plan` | 1-20 ordered navigation, read, and action steps on the selected tab | write |

The browser always launches from an empty, dedicated, or throwaway cloned profile. It never opens the live profile. An ephemeral launch copies only cookies named by `cookieDomains`; an empty list copies no cookies. Expand scope later with `headed_session op:"grantCookies" domains:"example.com"`.

```text
headed_session op:"launch" engine:"firefox" browserChannel:"zen" cookieDomains:"example.com"
headed_nav op:"goto" sessionId:"hb-…" url:"https://example.com"
headed_read op:"snapshot" sessionId:"hb-…"
headed_session op:"close" sessionId:"hb-…"
```

Use `headed_plan` when one selected tab needs a fixed sequence of navigation, reads, and actions. The tool validates every step before browser work, stops at the first failure or cancellation, and returns ordered per-step results. Plans reject tab management and page evaluation; use the standalone tools for those operations. A completed navigation invalidates refs from the preceding document.

Sessions persist across turns until closed or idle for `idleCloseSec`. `op:"close"` deletes the temporary profile, downloads, and artifacts unless `keepArtifactsOnClose` is enabled. Before closing, use `op:"artifacts"`. Copy needed files out of the session.

`cursorMode` controls headed action visualization:

- `auto` animates headed sessions and disables the cursor in headless sessions.
- `instant` moves without travel animation.
- `animated` shows travel and a target pulse.
- `off` disables the overlay.

Hidden pages and reduced-motion preferences use instant movement.

## Browser support

The headed tools ship self-contained `puppeteer-core@25.3.0` bundles (about 2.8 MB total). An empty `driverModulePath` uses the embedded driver, so consumer machines need no plugin `node_modules`. Set `driverModulePath` only in trusted operator configuration or `HEADED_BROWSER_DRIVER_MODULE_PATH`, and only to an existing absolute canonical Puppeteer entry module. It loads executable JavaScript with plugin privileges, is not accepted in per-call parameters, and reports load failures separately when set.

The verified implementation target is `puppeteer-core@25.3.0`.
| target | browsers | protocol | status |
|---|---|---|---|
| Firefox | Zen, Firefox, ESR, Developer, Nightly, LibreWolf, Waterfox | WebDriver BiDi | selectable per launch |
| Chromium | Not provided here | Use the built-in `browser` tool | built-in browser covers public Chromium diagnostics |

WebDriver BiDi does not expose Puppeteer's CDP-only diagnostics, response bodies, or drag APIs. Use the design plugin's accessibility scanner for WCAG checks. Use the built-in `browser` tool for Chromium diagnostics.

## Privacy and lifecycle

- `allowedDomains` and `deniedDomains` are mutually exclusive; setting both refuses launch.
- Non-HTTP(S) navigation is always blocked.
- Sensitive actions have independent feature gates. Download denial is applied at the browser's BiDi download-behavior boundary.
- Cookie values are omitted unless `exposeCookieValues` is enabled. Secret-shaped output is redacted by default.
- Audit records are appended to `<agentDir>/headed-browser-audit/<date>-<session>.jsonl` unless `auditDir` overrides it.
- Remote mode is Firefox-only and experimental. It fails explicitly when the remote binary is absent or Puppeteer cannot connect to the advertised BiDi endpoint.

## Chromium and MCP

This plugin registers no MCP server. The built-in `browser` tool provides Chromium diagnostics. Browser-tools provides Firefox-family sessions and their profile and cookie workflows.

## Licenses

| package | license |
|---|---|
