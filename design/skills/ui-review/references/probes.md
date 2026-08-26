# Computed-Style Probes

`tab.evaluate` snippets for the VERIFY step. Every one returns a number or a
resolved color string, so a finding can be written as `measured vs expected`
instead of "looks off".

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
const read = (sel, props) => [...document.querySelectorAll(sel)].map((el) => {
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

A focus indicator exists only when `outlineStyle !== 'none'` with a non-zero
width, or `boxShadow` changed between the unfocused and focused reads.

## Overflow, clipping, and overlap

```js
const overflow = () => ({
  docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  scrollers: [...document.querySelectorAll('*')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1)
    .map((el) => ({ tag: el.tagName, cls: el.className, over: el.scrollWidth - el.clientWidth })),
});

const overlaps = (containerSel) => {
  const kids = [...document.querySelector(containerSel).children].map((el) => [el, el.getBoundingClientRect()]);
  const hits = [];
  for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
    const [a, b] = [kids[i][1], kids[j][1]];
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
      hits.push({ a: kids[i][0].tagName, b: kids[j][0].tagName });
    }
  }
  return hits;
};
```

`docScrollX` greater than 0 at 375 CSS px is a horizontal-scroll finding.

## Target size, including a pseudo-element hit area

`getBoundingClientRect` measures the control, not a `::before` overlay that
enlarges the hit area. A pseudo-element is hit-testable and `elementFromPoint`
returns the element that generated it, so walk outward from the centre until the
point stops resolving to the control or one of its descendants.

```js
const target = (sel) => [...document.querySelectorAll(sel)].map((el) => {
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
