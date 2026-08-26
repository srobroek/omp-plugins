---
name: ui-review
description: Verifies a rendered surface with ARIA snapshots, computed styles, and keyboard walks. Triggers on review this UI or check how this looks.
---

# UI Review

Phase VERIFY. Drive the real surface and measure what a picture can only suggest.

TRIGGER
+ "review this UI", "check how this looks", "does this look right"
+ Any landed change to a rendered surface, before reporting it done
- "is this accessible", a WCAG conformance question -> `accessibility-audit`
- iOS, Android, macOS, or Windows convention questions -> `platform-conformance`
- Token and primitive discovery before building -> `design-system-audit`

## Workflow

1. Verify at COMPONENT level before page level. When the project has a Storybook, LOAD
   `skill://ui-review/references/storybook.md` and drive individual stories first. -> each
   component passes in isolation before any page assembled from it is judged, because a
   component-level failure is smaller to locate than the same failure on a page.
2. Get the surface running and reachable: `hub` op `start` for the dev server, then
   `browser` action `open` on the route. Start it ONCE and reuse it for the whole walk and
   for any later fix, because the process outlives the turn. -> the route responds, the tab
   is live, and the URL appears in the report header so the user can watch the same surface.
3. `tab.ariaSnapshot()` for structure, roles, and accessible names. This is the
   primary evidence. -> every interactive node carries a role and a non-empty
   accessible name, and the heading and landmark order reads correctly.
4. `tab.evaluate` for computed styles; LOAD `skill://ui-review/references/probes.md`.
   -> each claimed color, size, spacing, radius, and font value is a number read
   from `getComputedStyle`, never inferred from an image.
5. Keyboard traversal: `tab.press("Tab")` forward, `Shift+Tab` back, `Escape` on
   every dismissible surface. -> focus order matches visual order, every stop
   paints a visible ring, nothing traps focus, and dismissal restores focus.
6. Widths 1440, 768, 375 via `page.setViewport`; LOAD
   `skill://ui-review/references/viewport-checks.md`. -> per width: no overflow,
   no clipping, no overlap, and every target at least 24x24 CSS px.
7. Console and network across the whole walk. -> zero console errors and zero
   failed requests, or each one reported with its message and URL.
8. `tab.screenshot({ selector, fullPage })` last, only when appearance itself is
   the question. -> the saved path sits beside the assertion it illustrates.

Each state needs a driven interaction, never an assumption: default, hover,
focus-visible, active, disabled, loading, empty, error, selected.

## Rules

MUST Use `browser` for web surfaces and `computer` for native desktop surfaces.
MUST Report every finding with its viewport width and its measured value.
MUST Re-verify only the changed assertion after a fix, not the whole walk.
MUST Report the served URL. The user watches the same surface you drive, and a finding
  without its URL cannot be reproduced by hand.
DEFAULT Run a dev server and keep it, rather than rebuilding. It recompiles on change, it
  outlives the turn, and the user can open it. Build a static bundle only when a server has
  no purpose: a CI job, no free port, or a single read with no follow-up.
NOT Restart a server that `hub` op `ps` shows already running for this project.
DEFAULT Order evidence ARIA snapshot, then computed style, then pixels.
NOT Screenshot diffing as primary evidence: it is flaky and names no cause.
NOT Reporting a state as checked when no interaction drove it.

OUTPUT
L1 VERDICT: PASS|FINDINGS|BLOCKED -- surface plus route, one sentence.
   Findings -- one line each: `<width>px <selector> <measured> vs <expected>`.
   Evidence -- ARIA snapshot excerpt, probe results, screenshot paths.
CAP 120w clean · 220w with findings
