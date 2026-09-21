# Internationalization and accessibility

When a deployable emits human-facing text or renders an interface, load this reference.
Do not add UI dependencies to machine-only protocols.

## Surface classification

Reuse the deployable's accepted human-facing surfaces. Classify a Tauri or Electron DOM as
`WEBVIEW`.


When the shell exposes native controls, also select `NATIVE_DESKTOP`. This applies to native menus
and dialogs. It also applies to notifications.

Ask internationalization maturity as one exclusive choice:

| Answer | Contract |
|---|---|
| `ONE_LOCALE_ONLY` | The product keeps text in source and installs no i18n tooling. |
| `I18N_READY` | One locale ships through catalogs and locale-aware formatting. Adding a second locale needs no source rewrite. |
| `MULTIPLE_LOCALES` | Two or more named BCP 47 locales ship with complete catalogs. |

Recommend `I18N_READY` for a new user-facing product. When the user chooses a single-locale product,
use `ONE_LOCALE_ONLY`.

## Internationalization frontier

For `I18N_READY` or `MULTIPLE_LOCALES`, settle these fields:

1. Base locale: one BCP 47 tag. When conventions differ, include the region.
2. Shipped locales: a multi-select set that includes the base locale.
3. Locale source and precedence for each surface.
4. Message library for each runtime surface.
5. Catalog format and translator workflow.
6. Completeness gate. Paraglide includes a packaged recurring exact-key gate. For another library,
   ask for an existing recurring command, its working directory, and the clean-checkout preparation
   command that installs its tool from the committed lockfile. When none exists, record an
   `ACCEPTED_GAP`. Do not claim the gate works.
7. Test locales. Always test the base locale. For `MULTIPLE_LOCALES`, test every shipped locale.
8. Optional test locales. Ask for a pseudo-locale or RTL locale only when the accepted build can
   compile its catalog without including it in the release.

For locale precedence, choose among these sources:

- URL or workspace
- account preference
- device or browser
- `Accept-Language`
- base locale

Persist only sources that the accepted product owns. Test locales do not need to ship.

Do not choose one repository-wide i18n library. Runtime-specific adapters can share locale tags and
message semantics.

## Maintained library defaults

<!-- slopvac-allow: rule=ste-nouns.multiword-noun-too-long reason=api-name -->
| Runtime surface | Default | Choose another default when |
|---|---|---|
| React, Vite SPA, or Tauri WebView | `@inlang/paraglide-js` | The accepted workflow needs ICU, PO, or existing JSON resources. |
| React with ICU-heavy SSR | `react-intl` and `@formatjs/cli` | Server and client precompile the same ICU messages. |
| TypeScript with PO catalogs | Lingui | Translators or the TMS use PO catalogs. |
| TypeScript with shared JSON resources | `i18next` plus the surface adapter | Existing bundles and SSR already use i18next. |
| Python without framework i18n | stdlib `gettext` and Babel | Babel extracts messages and supplies CLDR formatting. |
| Django | Django translation APIs and `LocaleMiddleware` | Never layer another message runtime over Django. |
| Python | `fluent.runtime` | Fluent semantics. |

For Go, choose `golang.org/x/text` and `gotext` for compiled catalogs and CLDR formatting.

For Go with existing catalogs, choose `nicksnyder/go-i18n/v2`. Preserve the catalog format.

For Rust, choose `fluent-bundle` and `fluent-langneg` for UI and CLI messages.

When Rust needs direct data access, choose ICU4X. It does not provide message catalogs.

Framework-native localization overrides this table. Do not install an i18n library for text owned
by another surface.

Before writing the plan, resolve and record compatible stable versions. Run the selected command
from the owning member directory:

| Choice | Initial package command |
|---|---|
| Paraglide | `bun add @inlang/paraglide-js` |
| FormatJS React | `bun add react-intl && bun add --dev @formatjs/cli` |
| Lingui React | `bun add @lingui/core @lingui/react && bun add --dev @lingui/cli @lingui/macro` |
| i18next React | `bun add i18next react-i18next` |
| Python gettext and Babel | `uv add Babel` |
| Python Fluent | `uv add fluent.runtime` |
| Go x/text | `go get golang.org/x/text` |
| Go go-i18n | `go get github.com/nicksnyder/go-i18n/v2` |
| Rust Fluent | `cargo add fluent-bundle fluent-langneg` |
| Rust ICU4X | `cargo add icu` |

The TypeScript stack uses Oxlint's built-in `jsx-a11y` plugin. For an existing config, add
`jsx-a11y` to its plugins. Otherwise copy the project-setup config. Do not install the ESLint plugin.

When the user accepts Storybook, also add `@storybook/addon-a11y`.

When the user accepts Playwright, resolve exact stable versions for `@playwright/test` and
`@axe-core/playwright`. Render them into the isolated `.a11y/package.json` asset.

When the user selects Paraglide, ask for the exact message-format module URL as `USER INPUT REQUIRED`.
Give no source recommendation. An unanswered source is a blocking supply-chain gap.

## Message and locale invariants

The catalog invariants below apply only to `I18N_READY` and `MULTIPLE_LOCALES`.

- MUST Use stable message IDs. Never use source-language sentences as identifiers.
- MUST Use the selected library's plural and select syntax.
- MUST NOT Concatenate translated fragments or select plurals in application code.
- MUST Format locale-sensitive values through locale data.
- MUST Keep machine error codes stable and map them to localized messages.
- MUST Give assistive text catalog keys.
- MUST Resolve the same locale across server and client rendering.

Locale-sensitive values include:

- dates and times
- numbers and currencies
- lists
- relative time

## Accessibility frontier

A web or WebView surface opens these inputs:

1. Runner: Playwright for recurring repository and CI checks.
2. Base URL: one absolute local URL per surface.
3. Web-server command and working directory: one accepted pair per surface.
4. Dependency preparation: derive each member's frozen-lockfile install from the accepted stack.
5. Fixture preparation: when a route needs fixture data or authentication, ask for the exact command
   and repository-relative working directory. Otherwise derive an empty fixture step.
6. Addressable states: one or more routes that independently load the state to scan after preparation.
7. Keyboard path: interactions and focus transitions for manual verification.
8. Assistive technology: supported platforms and one named screen reader for release checks.
9. Storybook: reuse the answer from the testing topic. Never ask it twice.
10. Bun version: reuse the accepted TypeScript value. Without one, resolve the current stable version
    and ask the user to accept it.
11. Static gate: use Oxlint's `jsx-a11y` plugin for JSX. For another web technology, identify an
    existing static command and prove the accepted pre-merge gate invokes it. When none exists, ask
    the user to accept an `ACCEPTED_GAP`. Never claim that a static gate runs.

For Playwright, use:

- `.a11y/playwright.config.ts` as the dedicated config
- `.a11y/tests` as the test directory
- `*.pw.ts` as the file pattern
- `.a11y/package.json` as the isolated dependency owner

Put every accepted surface in the config and route data. Do not merge with or overwrite an existing
Playwright config. When no stable route exists, record rendered scanning as a gap and select no
Playwright asset. Static lint, keyboard checks, and screen-reader checks remain required.

For each native desktop surface, settle:

1. supported operating systems
2. platform accessibility API and inspection tool
3. keyboard path and focus transitions
4. which screen reader each operating system supports
5. custom control semantics

For each CLI or TUI surface, settle:

1. supported terminals and operating systems
2. complete keyboard path
3. resize and non-color output cases
4. output behavior with animation disabled
5. which terminal screen reader each operating system supports
6. manual smoke command
7. expected reading order

## Accessibility baseline

Use WCAG 2.2 AA for every web or WebView surface. Do not ask whether to adopt it. Automated checks
cover only part of WCAG and cannot establish conformance.

Automation does not cover every rule because many criteria depend on human perception and
interaction, not data that software can evaluate reliably and consistently. For every route, use a
keyboard to check operation and focus. Screen readers reveal incorrect names and announcements. A
visual review measures contrast and reflow at each accepted zoom level. Use platform APIs for native
trees and actions. One control cannot establish conformance, so keep every accepted control in the
release gate.

| Surface | Required implementation and verification |
|---|---|
| Web or WebView | Prefer semantic HTML. If native semantics cannot express a control, add ARIA. Use the web checklist below. |
| React JSX | Enable Oxlint's built-in `jsx-a11y` plugin as a static gate. It supplements rendered checks. |
| Storybook | Add `@storybook/addon-a11y`. Fail CI on accepted serious or critical violations. |

For each accepted route, run the generated Playwright axe scan.

For desktop apps, inspect the accessibility tree and its actions. Custom controls expose the
accepted platform fields.

For a CLI or TUI, use the checklist below. Do not claim web conformance.

For a backend, add no library. Keep errors localized and codes stable.

Test these browser states:

- populated and empty
- error and loading
- modal
- validation

Use AppKit `NSAccessibility`, Windows UI Automation, or Linux AT-SPI for native desktop checks.

The web checklist covers:

- keyboard use and focus
- reflow and contrast
- accessible names and errors

Custom native controls expose:

- role and name
- value and state
- actions

The CLI checklist covers:

- keyboard use and reading order
- meaning without color
- output without animation
- resize behavior
- a screen-reader smoke test

## Accessibility process

1. Define the supported platform and assistive-technology matrix.
2. Before custom widgets, use native elements and platform controls.
3. Test behavior through roles and accessible names.
4. Run the accepted static command, or report its `ACCEPTED_GAP`.
5. Run axe against representative rendered states. Record selectors and criteria.
6. Walk every keyboard path, including focus return.
7. Before release, test one supported screen reader.
8. After navigation, focus, or custom-control changes, repeat the screen-reader checks.
9. Record untested criteria and their blocker. Never treat a clean scan as a WCAG pass.


## Static assets

For Paraglide:

1. Copy `assets/i18n/ts/paraglide/project.inlang/settings.json.template`.
2. Substitute only its declared tokens.
3. Copy `assets/i18n/ts/paraglide/scripts/check-i18n-locale-drift.mjs` byte for byte.
4. Add its drift invocation to `@@I18N_CHECK_COMMANDS@@`.

The drift script accepts one optional argument: the directory that contains `project.inlang/`. It
supports `{locale}` and `{languageTag}` path tokens, multiple catalog patterns, nested messages, and
complex-message arrays.

When any library has an accepted catalog command, render
`assets/i18n/.just.d/i18n.just.template` and include every command. On GitLab, also copy
`assets/i18n/.gitlab/ci/i18n.yml`.

For an accepted Playwright route scan:

1. Copy `assets/a11y/ts/playwright/package.json.template` to `.a11y/package.json`.
2. Copy the config template to `.a11y/playwright.config.ts`.
3. Copy the test template to `.a11y/tests/a11y.pw.ts`.
4. Render `assets/a11y/ts/playwright/.just.d/a11y.just.template`.
5. Render dependency and fixture preparation commands for every scanned product member.
6. Render one web-server object and one surface object per accepted web or WebView surface.
7. Run `bun install --cwd .a11y`.
8. Commit the generated lockfile.

The isolated package works with member-only monorepos and non-TypeScript applications. Every route
must load its accepted state without an interaction. The template does not replace keyboard or
screen-reader checks.

## PlateVault precedent

PlateVault provides this precedent:

- Paraglide with base locale `en-GB` and shipped locale `pt-BR`
- a merge gate for missing or orphaned catalog keys
- JSX lint and Testing Library
- Playwright and Storybook accessibility tooling

Project setup adds the rendered-route gate absent from PlateVault.
