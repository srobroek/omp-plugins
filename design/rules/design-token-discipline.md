---
name: design-token-discipline
description: Colors and spacing come from tokens; new scales need user approval first.
globs: ["**/*.{css,scss,tsx,jsx,vue,svelte}"]
---

MUST Use a named color token for every color. A literal hex, rgb, hsl, or named CSS color in a component is a miss.
MUST Use a spacing-scale token for every gap, padding, and margin. An arbitrary `px` / `rem` / `em` in a component is a miss.
MUST Add the token to the registry first when a value is outside the system, then reference `{group.token}`.
MUST Resolve every `{group.token}` against DESIGN.md or the discovered token file. An unresolved ref is a miss.
DEFAULT Reuse the nearest existing token when the visual delta is one step on the current scale.
NOT Hardcode `#`, `rgb(`, `hsl(`, or a bare `Npx` in component styles.
NOT Add a one-off override (`!important`, inline style, or local CSS variable) to escape the system.
ASK the user before introducing a new color, type, spacing, radius, elevation, or motion scale. A new scale is a system decision.

| situation | choice |
|---|---|
| value already exists as `{group.token}` | use that token |
| value is one step off an existing scale | use the nearest token |
| value is genuinely off-scale | add the token, then use it |
| change would add a new scale | ASK, then wait |
