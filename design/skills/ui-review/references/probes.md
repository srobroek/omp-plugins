# Computed-Style Probes

`tab.evaluate` snippets for the VERIFY step. Every one returns a number or a
resolved color string, so a finding can be written as `measured vs expected`
instead of "looks off".

## Scope every probe, then decide what is even a target

Three tests, in this order, before any probe below reports a number. They do different
work and must never be collapsed into one.

### 1. Resolve the root once

A Storybook story frame holds TWO DOMs: the story, and Storybook's hidden
fallback chrome. Bare `document.querySelectorAll` reads both and invents findings
that are not on the surface. Resolve the root ONCE, then query through it.

```js
const root = document.querySelector('#storybook-root') ?? document.body;
const all = (sel) => [...root.querySelectorAll(sel)];
const one = (sel) => root.querySelector(sel);
```

In a story frame the story root is `#storybook-root`. On a plain page no such
element exists, the fallback is `document.body`, and the root is the whole page.
Every probe below queries through `all` or `one`, never `document`.

Measured on one real story at 1440:

| Probe | Unscoped | Scoped to `#storybook-root` |
|---|---|---|
| `button, input, select, a[href]` | 28 | 21 |
| controls under 24x24 | 7 | 0 |
| `table` | 2 | 1 |

All seven of those sub-24px findings measured 0x0, and scoping removed them
because they came from the chrome ("Set string" x3, "Decorators documen",
"Webpack", "Vite", "Environment Variab"). Scoping closes that instance; test 2
is what makes the probe correct in general.

The interaction consequence fails differently from the measurement one, so it
needs its own check. An unscoped selector can resolve a 0x0 chrome element FIRST:
`document.querySelector('table tbody tr button')` returned the chrome's
placeholder prop table, and `tab.click` on that selector timed out after 8000ms
while reporting a plausible "matches 15 element(s)". A timeout whose match count
looks right is this trap, not a broken control. Prefix any selector handed to
`tab.click`, `tab.fill`, or `tab.waitForSelector` with `#storybook-root `, or
resolve the handle from `root` and call the method on the handle.

Recognise the chrome in any result by its class markers: `sb-preparing-story`,
`sb-preparing-docs`, `sb-nopreview`, `sb-errordisplay`.

`document.documentElement`, `document.activeElement`, and
`document.elementFromPoint` stay document-level on purpose: custom properties
resolve at `:root`, focus is a document property, and hit testing is
document-wide. A hit that lands outside `root` is itself the finding.

### 2. Drop what generates no boxes. Never judge on area alone

A node that generates no boxes is not a target, but a node with a zero-size border box
may still be hit-testable through a pseudo-element, so area alone never decides. Two
tests, and only the first one discards.

**Not rendered: discard outright.** `getClientRects().length === 0`, or a failed
`checkVisibility`. A `display: none` panel, a `content-visibility` subtree, a closed
dropdown's items, a toast queue that keeps its nodes. These generate no boxes at all and
are targets under no reading. They sit INSIDE the app root, so scoping cannot reach them,
which is why this test and not scoping is what generalises. It is also the test that
removed the seven chrome findings, because those nodes were not rendered either.

```js
const rendered = (el) =>
  el.checkVisibility?.({ checkVisibilityCSS: true }) !== false
  && el.getClientRects().length > 0;
const hits = (sel) => all(sel).filter(rendered);
```

`getClientRects().length > 0` is the portable form and decides the case on its own.
`checkVisibility` covers the same ground more directly and the `browser` tool drives
Chromium, so it is available; `?.` with `!== false` keeps the rect test as the decider
instead of skipping it when the method is absent.

NOT `checkOpacity: true`. An `opacity: 0` element still generates boxes, still receives
pointer events, and is still reachable by keyboard, so it is a real target. Discarding it
would hide the finding rather than measure it. An interactive element whose computed
`opacity` is 0 while it remains focusable is its own defect: report it as an invisible
focusable control, separately from target size.

NOT `contentVisibilityAuto: true` either, for a different reason. It returns false for an
off-screen `content-visibility: auto` subtree whose rendering is merely SKIPPED, not
suppressed. Those controls render as soon as they scroll into view, so filtering them here
means they never reach a target-size or style check at all. Scroll a candidate into view,
then measure it.

`visibility: hidden` is the case that stays filtered: it removes hit-testing outright, which
is why `checkVisibilityCSS` remains on.

**Rendered but zero area: ambiguous, never discarded on area.** The element has a rect
and it measures 0x0. Its border box is not its target: the hit area can come from a
pseudo-element or a positioned overlay, which is exactly what the target-size probe below
measures. An icon button with `::after { position: absolute; inset: -12px }` has a real
24x24 target and a 0x0 box. Discarding it on area turns a genuine pass into a silent false
NEGATIVE, which is worse than the false positive scoping fixes. Resolve it by hit-testing,
not by measuring: take points across the intended hit area and check that
`document.elementFromPoint(x, y)` resolves to the control or one of its descendants. Only
when nothing in that area resolves to it is it a finding.

### 3. Judge geometry on the effective hit area

So the order is: scope to the root, drop the not-rendered, then apply the 24x24 rule to
the EFFECTIVE hit area rather than the border box, using the pseudo-element probe below.
Every probe that measures geometry or counts interactive controls queries through `hits`,
never `all`: target size, the style sweep, the overflow scan, and the overlap check. Do
not delete these filters as noise.

## Color parsing: use the canvas, not a regex

Chromium returns `rgb()`, `rgba()`, `color(srgb ...)`, `oklch()`, or
`color-mix()` from `getComputedStyle` depending on how the author wrote the
value. A regex over `rgb(...)` silently misses the modern syntaxes. Round-trip
through a 1x1 canvas instead, which parses everything Chromium can parse.

```js
const toRGB = (css) => {
  const c = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;               // an unparseable value leaves #000 behind
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
};
```

## Effective background behind an element

`background-color` is usually `rgba(0,0,0,0)`, so the visible backdrop lives on
an ancestor. Walk up, compositing any translucent layer onto the next.

```js
const backdrop = (el) => {
  const stack = [];
  for (let n = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.backgroundImage !== 'none') return { undecidable: s.backgroundImage };
    const c = toRGB(s.backgroundColor);
    if (c.a > 0) { stack.push(c); if (c.a === 1) break; }
  }
  stack.push({ r: 255, g: 255, b: 255, a: 1 });   // canvas default
  return stack.reduceRight((under, over) => ({
    r: over.r * over.a + under.r * (1 - over.a),
    g: over.g * over.a + under.g * (1 - over.a),
    b: over.b * over.a + under.b * (1 - over.a),
    a: 1,
  }));
};
```

An `undecidable` result means a gradient or image sits behind the text. Report it
as NEEDS_HUMAN with a `tab.screenshot({ selector })` path; never guess a ratio.

## Contrast ratio

```js
const lum = ({ r, g, b }) => {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (fg, bg) => {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100;
};
```

Report both colors and the ratio. Thresholds: 4.5:1 for body text, 3:1 for large
text and for the boundary of a UI component.

## Type, spacing, radius, and elevation in one pass

```js
const read = (sel, props) => hits(sel).map((el) => {
  const s = getComputedStyle(el);
  return { sel, text: el.textContent.trim().slice(0, 40),
           ...Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])) };
});
read('button, [role="button"]', [
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'padding', 'gap', 'border-radius', 'border-width', 'box-shadow',
]);
```

Compare each value against the DESIGN.md token registry. A value that matches no
token is either a new token to record or drift to fix.

## Resolved custom properties

Source hex in a stylesheet is not what shipped. Read the resolved variable off
the element that consumes it.

```js
const tokens = (el, names) => Object.fromEntries(
  names.map((n) => [n, getComputedStyle(el).getPropertyValue(n).trim()]));
tokens(document.documentElement, ['--color-fg', '--color-bg', '--space-2', '--radius-md']);
tokens(root, ['--color-fg', '--color-bg']);   // a story decorator can override :root
```

## Focus ring

Focus first, then measure. A ring drawn with `box-shadow` reports
`outline-style: none`, so read both.

```js
// tab.press('Tab') or el.focus() first
const el = document.activeElement;
const s = getComputedStyle(el);
({ tag: el.tagName, name: el.ariaLabel ?? el.textContent.trim().slice(0, 40),
   outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
   offset: s.outlineOffset, shadow: s.boxShadow, ring: s.getPropertyValue('--ring') });
```

### Settle the transition, or the second read lies

A read taken at t=0 returns the IDLE value, not the focused one. Measured on a
button with a transitioned ring: the read issued immediately after
`tab.press('Tab')` returned the unfocused `box-shadow`, and the focused value
appeared only about 300ms later. Diffing that t=0 read against the unfocused read
finds them identical and reports "no focus indicator" on a component that has one.
A t=0 read is therefore a false negative, not evidence. The same applies to hover,
active, and selected, which are transitioned just as often.

Settle before the second read. Either await the transition on the property you are
about to measure:

```js
const settled = (el, prop, cap = 1000) => new Promise((res) => {
  const done = (e) => {
    if (e.propertyName !== prop) return;
    el.removeEventListener('transitionend', done); res('transitionend');
  };
  el.addEventListener('transitionend', done);
  setTimeout(() => { el.removeEventListener('transitionend', done); res('cap'); }, cap);
});
```

Or poll the computed value until it stops changing, which needs no knowledge of
which property is transitioned and still returns when no `transitionend` ever
fires:

```js
const stable = (el, prop, ms = 50, runs = 3, timeout = 2000) =>
  new Promise((res) => {
    const deadline = Date.now() + timeout;
    let prev = null, same = 0;
    const tick = () => {
      const v = getComputedStyle(el).getPropertyValue(prop);
      same = v === prev ? same + 1 : 0;
      prev = v;
      if (same >= runs) return res({ value: v, settled: true });
      if (Date.now() > deadline) return res({ value: v, settled: false });
      setTimeout(tick, ms);
    };
    tick();
  });
// const { value, settled } = await stable(document.activeElement, 'box-shadow')
```

The deadline is load-bearing: without it a continuously animated property never reaches
`same >= runs` and the pass hangs. A `settled: false` result is itself reportable, because a
property still moving after two seconds is an animation that never rests rather than a
transition to wait on. Read `transitionDuration` and `transitionProperty` beside the ring
values, so the report states the settle time it waited for instead of an unexplained sleep.

A focus indicator exists only when `outlineStyle !== 'none'` with a non-zero
width, or `boxShadow` differs between the unfocused read and the SETTLED focused
read. Two identical reads are a finding only when the second one settled.

## Overflow, clipping, and overlap

```js
const overflow = () => ({
  docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  scrollers: hits('*')
    .filter((el) => el.scrollWidth > el.clientWidth + 1)
    .map((el) => ({ tag: el.tagName, cls: el.className, over: el.scrollWidth - el.clientWidth })),
});

const overlaps = (containerSel) => {
  const box = (el) => el.getBoundingClientRect();
  const kids = [...one(containerSel).children]
    .filter((el) => rendered(el) && box(el).width > 0 && box(el).height > 0)
    .map((el) => [el, box(el)]);
  const pairs = [];
  for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
    const [a, b] = [kids[i][1], kids[j][1]];
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
      pairs.push({ a: kids[i][0].tagName, b: kids[j][0].tagName });
    }
  }
  return pairs;
};
```

`docScrollX` greater than 0 at 375 CSS px is a horizontal-scroll finding, and it is
the deciding number for whole-page overflow; the ladder under it is in
`skill://ui-review/references/viewport-checks.md`. Both scans go through `hits`, so a
node that generates no boxes cannot reach either. The overlap check adds its own area
guard on top, because a zero-area child reports an intersection with every sibling whose
box spans its position while overlapping nothing anyone can see. Measured in Chromium on a
100x40 block with a `position: absolute` 0x0 sibling inside its box: 1 pair without the
guard, 0 with it. That guard belongs to the overlap test alone: never carry it over to
target size, where a zero-area box can still be a real target.

## Target size, including a pseudo-element hit area

`getBoundingClientRect` measures the control, not a `::before` overlay that
enlarges the hit area. A pseudo-element is hit-testable and `elementFromPoint`
returns the element that generated it, so walk outward from the centre until the
point stops resolving to the control or one of its descendants.

```js
const target = (sel) => hits(sel).map((el) => {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const reach = (dx, dy) => {
    let n = 0;
    while (n < 32) {
      const hit = document.elementFromPoint(cx + dx * (n + 1), cy + dy * (n + 1));
      if (!hit || !(hit === el || el.contains(hit))) break;
      n++;
    }
    return n;
  };
  return { tag: el.tagName, w: Math.round(r.width), h: Math.round(r.height),
           hitW: Math.max(Math.round(r.width), reach(-1, 0) + reach(1, 0) + 1),
           hitH: Math.max(Math.round(r.height), reach(0, -1) + reach(0, 1) + 1) };
});
```

Minimum is 24x24 CSS px. Report the larger of the box and the probed hit area.

`hits(sel)`, never `all(sel)`, and judge against `hitW`/`hitH`, never against `w`/`h`.
Unscoped and unfiltered, this exact probe reported 7 controls under 24x24 on a story that
has none, and all seven measured 0x0. Scoping dropped them because they were chrome, and
the not-rendered test drops them too because they generated no boxes. A RENDERED 0x0 box
is the opposite case and stays in: `reach` hit-tests outward from its collapsed centre.
Measured in Chromium on a `width:0;height:0` button with `::after { position: absolute;
inset: -12px }`: `w` 0, `h` 0, `hitW` 24, `hitH` 24. That is a pass, and discarding it on
area would have hidden it. The same button placed 10 CSS px from the viewport edge measured
`hitW` 22, because the leftward walk hit `x < 0` and truncated; that is the off-viewport
trap below, not a target-size finding.

Three traps this arithmetic already handles, and one it does not:

- Never test `hit.contains(el)`. `body` contains the control, so the walk escapes
  the element and keeps counting until it strikes an unrelated neighbour. A lone
  20x20 button then measures 26 tall.
- Extents are summed as `left + right + 1`, not doubled. The centre is not
  equidistant from both edges on an even-width box.
- `scrollIntoView` first. Off-viewport points return `null`, which truncates the
  walk and under-reports the target.
- The walk is integer-pixel, so a fractional box can read 1px high. A result of
  24 or 25 needs the `w`/`h` box values checked before you call it a pass.

## Console and network

Register before navigating; handlers attached after load see nothing.

```js
const errors = [], failed = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url()}`));
page.on('response', (r) => r.status() >= 400 && failed.push(`${r.status()} ${r.url()}`));
await tab.goto(url);
```

Both request handlers are needed and they catch different things. An HTTP error
arrives on `response` with a status; a DNS failure, a blocked request, a CORS
rejection, or a missing `file://` asset never gets a status and arrives only on
`requestfailed`. Registering just one silently misses half the failures.

`console` also carries browser-generated errors, not only `console.error` calls:
a failed subresource shows up as `Failed to load resource: net::ERR_*`. Deduplicate
against `failed` before reporting a count.
