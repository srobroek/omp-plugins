---
name: rust-tauri
description: When building Tauri v2 desktop apps — bundles, release-please, updater, signing, or WebDriver E2E.
globs: ["**/*.rs", "**/Cargo.toml"]
---

# Tauri (v2) App Defaults

Load only when the task involves a Tauri desktop app -- bundles, releases,
auto-update, or signing.

## Release pipeline

- Build + release with `tauri-apps/tauri-action@v0` (3-OS matrix: ubuntu/windows/macos).
- Orchestrate versions/changelog with `release-please`. Do NOT use GoReleaser or cargo-dist.
- Draft-then-publish: flip to published only after every OS build succeeds.
- Omit `cancel-in-progress` on release workflows.

## Updater

Use `tauri-plugin-updater`. Public key in `tauri.conf.json`; sign with
`TAURI_SIGNING_PRIVATE_KEY`. Serve static `latest.json` on GitHub Release.

## Code signing

- Windows: SignPath Foundation (free, OSS) or Azure Trusted Signing; EV cert last resort.
- macOS: Developer ID Application + `notarytool`, App Store Connect API key.

## E2E testing -- decision table

| Concern | Choice | Not (reason) |
|---------|--------|--------------|
| E2E client | thirtyfour | fantoccini (injects extra caps the driver rejects) |
| Cross-OS harness | tauri-plugin-webdriver | tauri-driver (Linux+Win only, no macOS) |
| Driver install in CI | taiki-e/install-action | bare cargo binstall (stale .crates2.json leaves binary off PATH) |
| IPC assertions | build-flag bridge + `execute_async` | `window.__TAURI__` (off by default) |

Gotchas:
- Capabilities MUST NOT include `browserName` -- WebKitWebDriver rejects the session.
- `Capabilities::new()` is an empty map -- correct; do not add extra fields.

Runner: **cargo-nextest** in a dedicated `crates/e2e-tests` crate, `[profile.e2e]`,
serialized (`max-threads = 1`). Start driver+frontend OUTSIDE nextest (nextest
setup-scripts have no teardown hook).

## MCP (agent-interactive debugging)

`P3GLEG/tauri-plugin-mcp`: debug-only `#[cfg(debug_assertions)]`, complement not
replacement for scripted CI E2E. Playwright MCP cannot drive the Tauri webview.
