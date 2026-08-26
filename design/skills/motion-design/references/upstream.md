# Upstream routes for motion-design

| Upstream skill | Repo | Install |
|---|---|---|
| `ss-motion` | `bitjaru/styleseed` | `omp plugin install styleseed@srobroek-omp` |

`styleseed` is MIT with a LICENSE file (Copyright 2026 StyleSeed Contributors). Skill
granularity is the whole plugin, so that one entry also installs 20 other `ss-*` skills
plus `styleseed` itself. `skill://design-system-audit` routes to `ss-tokens` and
`ss-score` from the same entry, so the cost is paid once.

## MotionLint needs no install

`npx` fetches it per run:

```
npx playwright install chromium
npx --yes motionlint audit "<url>" --json audit.json --ci
```

MIT. The Chromium install is a one-time prerequisite. `motionlint mcp` exists and is
deliberately not used: it duplicates the CLI above, and an MCP server declared for it
would load into every session for a capability needed occasionally.

## Why no principles skill is routed to

`animation-principles` from `Owl-Listener/designer-skills` is genuinely good and is
deliberately NOT advertised. It sits in that repository's `interaction-design` catalog
entry alongside 21 siblings, and `layout-grid` sits in `ui-design` alongside 18 more, so
obtaining three useful skills costs 41 installed skills competing for retrieval with
the ten here.

`git-subdir` cannot narrow that, and this was proven rather than assumed: pointing it at
a single skill directory, and separately at the `skills/` container, both yielded zero
discovered skills, because discovery resolves `<plugin-root>/skills/<name>/SKILL.md` and
neither shape satisfies it. Only the full `interaction-design` root resolves.

If you want it anyway, it is `omp plugin marketplace add Owl-Listener/designer-skills`
then `omp plugin install interaction-design@designer-skills`. That is your call to make,
not this skill's, which is why there is no fallback route to it above.

## What OMP already covers

`browser` reads computed styles, so a transition duration or easing is measured directly
with `tab.evaluate`. MotionLint earns its place by scoring a whole surface and by
exercising `prefers-reduced-motion` systematically, not by reading one value.
