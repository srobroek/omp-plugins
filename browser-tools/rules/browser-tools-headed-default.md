---
name: browser-tools-headed-default
description: Use for headed, authenticated, extension-dependent, or profile-bound browser work.
---

| situation | choice |
|---|---|
| authenticated site, password manager, or browser extension needed | `headed_session` / `headed_nav` / `headed_read` / `headed_act` |
| human-visible interactive flow, manual MFA, or 1Password unlock | headed tools with `headless: false`; act inside the agent's browser window |
| Chromium performance trace, coverage, or CDP domain | built-in `browser` plus `chrome-devtools` MCP |
| WCAG audit with axe-core | `design` plugin `accessibility-scanner` MCP |
| WebKit engine check | `playwright-cross-engine` MCP |
| headless scrape of a public page | built-in `browser` |

MUST launch from a clone, never the live profile.
MUST name `cookieDomains` for the sites the task needs and use `grantCookies` when scope grows.
MUST pick the engine and channel the task needs rather than assuming the default.
MUST copy needed artifacts out after `op:"artifacts"` and before `op:"close"`; close deletes ephemeral data.
MUST close sessions when the task is done.
NEVER attach to or restart the user's running browser.
