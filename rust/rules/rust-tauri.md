---
name: rust-tauri
description: When building Tauri v2 desktop apps — bundles, release-please, updater, signing, or WebDriver E2E.
---

# Tauri (v2) App Defaults

Load only when the task involves a Tauri desktop app -- bundles, releases,
auto-update, or signing.

## Release pipeline

- Build + release with `tauri-apps/tauri-action@v0` across the target OS matrix.
- If the project adopts `release-please`, use it to orchestrate versions and
  changelog rather than duplicating release tooling.
- Draft-then-publish: flip to published only after every OS build succeeds.
- Omit `cancel-in-progress` on release workflows.

## Updater

Use `tauri-plugin-updater`. Public key in `tauri.conf.json`; sign with
`TAURI_SIGNING_PRIVATE_KEY`. Serve static `latest.json` on GitHub Release.

## Code signing

- Windows: SignPath Foundation (free, OSS) or Azure Trusted Signing; EV cert last resort.
- macOS: Developer ID Application + `notarytool`, App Store Connect API key.

## E2E testing

Capabilities MUST NOT include `browserName` -- WebKitWebDriver rejects the session.
`Capabilities::new()` is an empty map -- correct; do not add extra fields.

## MCP (agent-interactive debugging)

`P3GLEG/tauri-plugin-mcp`: debug-only `#[cfg(debug_assertions)]`, complement not
replacement for scripted CI E2E. Playwright MCP cannot drive the Tauri webview.
