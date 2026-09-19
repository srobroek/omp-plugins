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

Configure persistent defaults under `/settings` → Plugins → `@srobroek/browser-tools`. Override launch settings with `headed_session op:"launch"`. `driverModulePath` is trusted configuration only; remote SSH parameters are accepted only on that launch call. When host resolution is unavailable, set `driverModulePath` to a normalized absolute path to an operator-trusted `puppeteer-core` entry module. Import-time loading validates that the module exists and exports `launch` and `connect`.

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

The headed tools ship self-contained `puppeteer-core@25.3.0` bundles (about 2.8 MB total). An empty `driverModulePath` uses the embedded driver, so consumer machines need no plugin `node_modules`. Set `driverModulePath` only in trusted operator configuration or `HEADED_BROWSER_DRIVER_MODULE_PATH`, and only to an existing absolute canonical Puppeteer entry module. It loads executable JavaScript with plugin privileges, is not accepted in per-call parameters, and reports load failures separately when set.

The verified implementation target is `puppeteer-core@25.3.0`.
| target | browsers | protocol | status |
|---|---|---|---|
| Firefox | Zen, Firefox, ESR, Developer, Nightly, LibreWolf, Waterfox | WebDriver BiDi | selectable per launch |
| Chromium | Not provided here | Use the built-in `browser` tool | built-in browser covers public Chromium diagnostics |

WebDriver BiDi does not expose Puppeteer's accessibility tree, coverage, tracing, `Page.metrics()`, response bodies, drag APIs, offline mode, or network-condition emulation. Use the design plugin's accessibility scanner for WCAG checks and the built-in `browser` tool for Chromium diagnostics.

## Privacy and lifecycle

- `allowedDomains` and `deniedDomains` are mutually exclusive; setting both refuses launch.
- Non-HTTP(S) navigation is always blocked.
- Downloads, form submission, password entry, file upload, and evaluation have independent feature gates. Download denial is applied at the browser's BiDi download-behavior boundary.
- Cookie values are omitted unless `exposeCookieValues` is enabled. Secret-shaped output is redacted by default.
- Audit records are appended to `<agentDir>/headed-browser-audit/<date>-<session>.jsonl` unless `auditDir` overrides it.
- Remote mode is Firefox-only and experimental. It fails explicitly when the remote binary is absent or Puppeteer cannot connect to the advertised BiDi endpoint.

## Chromium and MCP

This plugin deliberately does not register an MCP server. The built-in `browser` tool covers Chromium work, including ARIA snapshots, computed styles, screenshots, keyboard input, viewport sizing, and request interception. Browser-tools focuses on Firefox-family sessions and their profile/cookie workflows.

## Licenses

| package | license |
|---|---|
