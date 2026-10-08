---
name: design-no-slop
description: When critiquing or building a rendered UI, reject generated-UI visual tells and missing interaction states.

---

MUST Cover loading, empty, and error on every data-backed surface. A missing state is a miss.
MUST Style one primary action per view. A second button using the primary variant is a miss.
MUST Give each heading a distinct job. A heading that restates the paragraph below it is a miss.
MUST Set a typeface explicitly. The default web stack chosen by omission is a miss.

DEFAULT Treat every tell below as a finding unless the project's approved tokens, its DESIGN.md, or the brief sanctions that choice. A token set that defines pure `#fff`, or an approved metric layout, is the system, not slop.
DEFAULT Avoid decorative glassmorphism, glow borders, or blur-on-card chrome.
DEFAULT Avoid cyan-on-dark palettes with purple gradients.
DEFAULT Avoid gradient text on headings or metrics.
DEFAULT Avoid uniform card grids of icon-heading-text.
DEFAULT Avoid nested cards.
DEFAULT Avoid large rounded icons above every heading.
DEFAULT Avoid hero metric layouts (big number, small label, three-up).
DEFAULT Avoid uniform spacing with no rhythm (every gap the same token).
DEFAULT Avoid centering every block on the page.
DEFAULT Avoid modals as the default disclosure when an inline, popover, or page works.
DEFAULT Avoid pure `#000` or `#fff` instead of tinted neutrals.
DEFAULT Avoid bounce or elastic easing.

| situation | choice |
|---|---|
| extra chrome for depth | drop it; use elevation tokens |
| many peers of equal weight | list or table, not a card grid |
| secondary action | ghost or text variant |
| disclosure of details | inline first; modal last |
