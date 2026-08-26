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
2. Wait for layout to settle. The predicate form is NOT `tab.waitFor`: every `tab.waitFor*`
   helper takes a SELECTOR STRING, so handing one a function throws instead of waiting.
   - Element the breakpoint introduces: `await tab.waitForSelector('nav [aria-expanded]')`.
   - Predicate: `await wait(() => tab.evaluate(() => !document.querySelector('[aria-busy="true"]')))`.
     `wait(fn)` is the run-scope helper that polls a function until it returns truthy.
   NEVER wait out `aria-busy` on a loading story. A loading state deliberately keeps
   `[aria-busy="true"]` set for as long as it renders, so that predicate never settles and
   the pass times out on a component that is behaving correctly. Wait on the skeleton or
   spinner that the loading state renders instead, and treat a persistent `aria-busy` there
   as the expected value rather than a stall.
   The same shape, one helper over: `tab.select` with a value absent from the option list
   does NOT throw. It silently no-ops and leaves the previous value in place, so read the
   value back with `tab.evaluate` after every select. Measured: selecting `USD` against a
   list of EUR/GBP/SEK left the value at EUR, which reads in a report as a broken control
   rather than a bad probe.
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

- Horizontal document scroll is 0: `documentElement.scrollWidth` equals
  `documentElement.clientWidth`. This is the ONE number that decides whole-page overflow
  at this width.
- A box extending past its scroll container's client box LOCATES that number's cause. It
  is not an independent test, and inside a labelled scroller it is expected. Read the
  ladder below before filing one.
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

### The overflow ladder: one number decides

Three of the rules above read like three co-equal tests. They are a ladder, and only
the first one decides.

1. DECIDES. `documentElement.scrollWidth` vs `documentElement.clientWidth`. Equal means
   the page does not scroll horizontally, so there is no whole-page overflow finding at
   this width, whatever any individual box measures.
2. LOCATES. A `getBoundingClientRect` sweep for boxes past the viewport. Run it only once
   step 1 is non-zero, and read the result as which subtree caused that number, never as
   a finding of its own.
3. EXPECTED. Boxes past the viewport inside a labelled, keyboard-reachable scroller
   (`role="region"` with an accessible name and `tabindex="0"`). The 768 table rule below
   REQUIRES that container, so its own overflow is the design working.

Measured at 375: the sweep returned 51 element boxes past the viewport, and every one of
the 51 sat inside a single scroller with `role=region`,
`aria-label="Invoices, page 1 of 2"`, `tabIndex=0`, whose `clientWidth` was 357 against a
`scrollWidth` of 699. The document itself measured 375 against 375. That page was clean,
and a naive reading of step 2 alone would have filed 51 findings against a compliant table.

Report the deciding number at every width, including when it is 0. `51 boxes past the
viewport` without it is not a finding.

### Prove a fix is load-bearing: defeat it, then re-measure

A passing number after a fix does not show that the fix caused the pass. Defeat the fix in
the live DOM, re-read the deciding number, then clear the override and read it a third
time. Measured: setting the fixed element's `position` back to `static` took
`documentElement.scrollWidth` from 375 to 692, and clearing the inline override returned
it to 375.

```js
const root = document.querySelector('#storybook-root') ?? document.body;  // as in probes.md
const el = root.querySelector('.the-fixed-element');
el.style.position = 'static';               // defeat it
document.documentElement.scrollWidth;       // expect the failure back: 692
el.style.position = '';                     // restore, always
document.documentElement.scrollWidth;       // expect the fix again: 375
```

Record all three numbers in the order the snippet reads them: fixed, re-broken, restored.
Two reads that never move are
indistinguishable from a fix that does nothing. Always clear the override, because the
ablation mutates the live DOM every later probe reads.

The mechanism, so the technique transfers: an out-of-flow box contributes nothing to the
document's scrollable width, so forcing it back in flow restores the overflow it was hiding.
Reproduced in Chromium on a 600px-wide `position: fixed` block at a 375 viewport:
`documentElement.scrollWidth` read 375 while fixed, 610 forced to `static`, and 375 again
once the inline override was cleared.

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
  finding. That region's own `scrollWidth` exceeding its `clientWidth` is the design
  working, not a finding: it is step 3 of the overflow ladder.

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
