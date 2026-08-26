---
name: design-token-discipline
description: Colors and spacing come from tokens; new scales need user approval first.
globs: ["**/*.{css,scss,sass,less,styl,tsx,jsx,ts,js,vue,svelte,astro,html,md,json,swift,kt}"]
---

MUST Use a named color token for every color. A literal hex, rgb, hsl, or named CSS color in a component is a miss.
MUST Use a spacing-scale token for every gap, padding, and margin. An arbitrary `px` / `rem` / `em` in a component is a miss.
MUST Add the token to the registry first when a value is outside the system, then reference it in the notation its file class uses.
MUST Map the two notations rather than mixing them. `{group.token}` is DESIGN.md and DTCG notation: it belongs in DESIGN.md, in `tokens/**/*.json` alias values, and in prose. `var(--group-token)` is the CSS custom-property form and the only one a browser resolves: it belongs in `.css`, `.scss`, `.sass`, `.less`, `.styl`, and in any style block, class string, or `style` attribute inside `.tsx`, `.jsx`, `.ts`, `.js`, `.vue`, `.svelte`, `.astro`, or `.html`. Dots become dashes under a leading `--`, so `{color.fg-muted}` is written `var(--color-fg-muted)`, unless the token build declares a prefix, which its generated CSS shows. A `{group.token}` left in a stylesheet is dead text.
MUST Resolve every reference against a real carrier: `{group.token}` against DESIGN.md or the discovered token file, `var(--group-token)` against the generated CSS that declares it. An unresolved ref is a miss in either notation.
DEFAULT Reuse the nearest existing token when the visual delta is one step on the current scale.
NOT Hardcode `#`, `rgb(`, `hsl(`, or a bare `Npx` in component styles.
NOT Add a one-off override (`!important`, inline style, or local CSS variable) to escape the system.
ASK the user, whenever a human is reachable, before introducing a new color, type, spacing, radius, elevation, or motion scale. A new scale is a system decision. In an unattended run, do NOT stall: take your recommended answer, record on the bead exactly what a reviewer would have been asked, and proceed. `agents/ui-ux-specialist.md` carries the same branch in the same words, so the two never prescribe opposite actions for one situation.

| situation | choice |
|---|---|
| value already exists as `{group.token}` | use that token |
| value is one step off an existing scale | use the nearest token |
| value is genuinely off-scale | add the token, then use it |
| change would add a new scale, human reachable | ASK, then wait |
| change would add a new scale, unattended run | record on the bead what a reviewer would have been asked, then proceed on the recommended default |
