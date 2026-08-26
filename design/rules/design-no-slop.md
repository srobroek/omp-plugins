---
name: design-no-slop
description: Refuse generated-UI visual tells and missing interaction states.
globs: ["**/*.{css,scss,tsx,jsx,vue,svelte}"]
---

MUST Cover loading, empty, and error on every data-backed surface. A missing state is a miss.
MUST Style one primary action per view. A second button using the primary variant is a miss.
MUST Give each heading a distinct job. A heading that restates the paragraph below it is a miss.
MUST Set a typeface explicitly. The default web stack chosen by omission is a miss.

NOT Decorative glassmorphism, glow borders, or blur-on-card chrome.
NOT Cyan-on-dark palettes with purple gradients.
NOT Gradient text on headings or metrics.
NOT Uniform card grids of icon-heading-text.
NOT Nested cards.
NOT Large rounded icons above every heading.
NOT Hero metric layouts (big number, small label, three-up).
NOT Uniform spacing with no rhythm (every gap the same token).
NOT Centering every block on the page.
NOT Modals as the default disclosure when an inline, popover, or page works.
NOT Pure `#000` or `#fff` instead of tinted neutrals.
NOT Bounce or elastic easing.

| situation | choice |
|---|---|
| extra chrome for depth | drop it; use elevation tokens |
| many peers of equal weight | list or table, not a card grid |
| secondary action | ghost or text variant |
| disclosure of details | inline first; modal last |
