# Viewport Checks

Three widths, in this order: 1440, 768, 375. Narrow last, because narrow is where
layout breaks and you want the failure fresh in the report.

| Viewport | Use `page.setViewport` | Represents |
|---|---|---|
| 1440x900 | `{ width: 1440, height: 900, deviceScaleFactor: 1 }` | Desktop, the width most layouts were designed at |
| 768x1024 | `{ width: 768, height: 1024, deviceScaleFactor: 2 }` | The tablet or split-pane breakpoint, where multi-column collapses |
| 375x667 | `{ width: 375, height: 667, deviceScaleFactor: 3 }` | Small phone, the narrowest supported width |

Omit `isMobile` and `hasTouch` by default; see the trap below. Add them only for a
separate touch-behavior pass.

## Order of operations

1. Set the viewport.
2. Wait for layout to settle: `await tab.waitFor(() => !document.querySelector('[aria-busy="true"]'))`,
   or await the specific element the breakpoint introduces.
3. Re-take `tab.ariaSnapshot()`. A bare resize keeps existing `[ref=eN]` handles
   valid, but a breakpoint that swaps in a different component tree detaches the
   nodes they point to, and the next `tab.ref()` throws
   `Unknown ARIA ref "eN"`. Re-snapshotting also gives you the tree for this
   width, which is what the findings must be compared against.
4. Run the probes. Record the width beside every number.

## The `isMobile` trap

`isMobile: true` is not "the same viewport, but touch". Measured on Chromium at
`{ width: 375, isMobile: true, hasTouch: true }`:

| Page | `innerWidth` | `documentElement.clientWidth` | `(hover: hover)` |
|---|---|---|---|
| No `<meta name="viewport">` | 981 | 980 | false |
| `width=device-width, initial-scale=1` | 901 | 375 | false |
| `isMobile` omitted | 375 | 375 | true |

Two ways that silently ruins a 375 pass:

- A page without a viewport meta tag lays out at 980 CSS px. Every measurement in
  the pass is then taken at the wrong width while the report claims 375.
- `innerWidth` stays wrong even with the meta tag. Read
  `document.documentElement.clientWidth` to confirm the width you are actually
  reviewing, and assert it before recording any number.

Because `(hover: hover)` and `(pointer: fine)` both go false, hover states cannot
be checked in an `isMobile` pass. Set it only to exercise touch-specific behavior,
and check hover in a separate pass with `isMobile` omitted.

## Every width

- Horizontal document scroll is 0. Anything above 0 is a finding.
- No element's box extends past its scroll container's client box.
- No two siblings in a flex or grid container have intersecting boxes.
- Every interactive target is at least 24x24 CSS px, hit area included.
- Text is not truncated unless truncation is intentional and the full value is
  reachable by `title`, a tooltip, or the accessible name.
- Focus order still matches visual order. A responsive reorder via `order` or
  `grid-row` changes the visual order without changing the DOM order, which
  desynchronises the two.
- Sticky and fixed elements do not cover the focused element. Focus something
  behind them and check `getBoundingClientRect` against the sticky element's box.
- The heading and landmark structure in the ARIA snapshot is unchanged. A
  breakpoint that swaps in a different component tree often changes it.

## 1440 only

- Content has a max width. Line length above roughly 90 characters is a finding
  unless the design states otherwise; measure with a canvas text metric or by
  dividing the container width by the computed `ch` size.
- Whitespace is deliberate, not an artifact of a container that never caps.
- Multi-column layouts align to the same baseline grid.

## 768 only

- The layout that collapsed did so at a stated breakpoint, not mid-component.
- Navigation that becomes a menu keeps its accessible name and its expanded state
  (`aria-expanded`) correct through the transition.
- Two-column forms that stack keep label-to-field association intact.
- Tables either scroll in a labelled region (`role="region"` with an accessible
  name and `tabindex="0"`) or restructure. A table that just overflows is a
  finding.

## 375 only

- Reflow: no two-dimensional scrolling. Combine with the 320 CSS px check from
  `accessibility-audit` when conformance is in scope.
- The longest realistic string in every button, label, and badge still fits.
  Empty and error states count.
- Tap targets have at least 8 CSS px of separation, or an enlarged hit area.
- Modals and sheets fit the viewport height, and their content scrolls rather
  than the page behind them.
- Bottom-anchored controls sit above the browser chrome: check with
  `100dvh`-aware measurement, not `100vh`.

## Recording

One line per finding:

```
375px  .card__title   font-size 12px vs token {typography.body} 16px
768px  nav button     hit area 20x20 vs minimum 24x24
1440px .prose         line length 118ch vs maximum 90ch
```

A width that produced no finding still gets a line saying so. Silence reads as
"not checked".
