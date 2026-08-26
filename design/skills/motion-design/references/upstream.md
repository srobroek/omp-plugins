# Upstream routes for motion-design

The primary route is a CLI rather than a skill, so the table orders by ROUTE. MotionLint
leads because it measures a shipped surface. `ss-motion` authors values, and only for
React `motion.X`.

| Order | Route | Kind | Install |
|---|---|---|---|
| 1 | MotionLint `audit` | CLI, no install | none, see below |
| 2 | `ss-motion` | Upstream skill | `omp plugin install styleseed@srobroek-omp` |

`ss-motion` is titled "Motion Seed Applier", and its own **When NOT to use** says:

> For non-React motion (CSS-only transitions, GSAP) - this skill targets motion.X JSX only.

That is the whole reason it is second rather than first. Most motion in most projects is
CSS transitions, and on those `ss-motion` contributes nothing; MotionLint plus the rules in
this skill's body do the work. It is also an applier rather than a reviewer, so it cannot
return a verdict on a surface even where it does apply.

`styleseed` is MIT with a LICENSE file (Copyright 2026 StyleSeed Contributors). Skill
granularity is the whole plugin, so that one entry installs all 23 `ss-*` skills, and it
ships each of them twice, under `skills/` and again under `engine/.claude/skills/`, so
collisions resolve first-wins with no diagnostic. `skill://design-system-audit` routes to
`ss-lint`, `ss-review`, `ss-tokens`, and `ss-score` from the same entry, so the cost of
that entry is paid once across both skills.

## MotionLint is the primary route, and needs no install

`npx` resolves it on demand and caches it:

```
npx --yes playwright install chromium
npx --yes motionlint audit "<url>" --json audit.json --ci
```

MIT. The Chromium install is a one-time prerequisite. `motionlint mcp` exists and is
deliberately not used: it duplicates the CLI above, and an MCP server declared for it
would load into every session for a capability needed occasionally.

## It writes into the caller's working directory

`audit` also emits `.motionlint/audit/index.html` beside the JSON, resolved against the
CALLER's working directory rather than a temp dir, and no `.gitignore` covers it in this
repository or in a fresh project. Two ways to keep a tree clean: run the command with `cwd`
set to a scratch directory, or add `.motionlint/` to `.gitignore` before the first run. The
HTML file is the human view of the findings the JSON already carries, so discarding it
loses nothing.

`--ci` is not a findings gate. Measured, it exited 0 on a surface whose own report carried
the accessibility warning `No prefers-reduced-motion path`, so the exit code cannot stand in
for reading `audit.json`.

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
