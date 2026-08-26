# Upstream routes for accessibility-audit

| Upstream skill | Repo | Install |
|---|---|---|
| `accessibility` | `addyosmani/web-quality-skills` | `omp plugin install web-quality-skills@srobroek-omp` |
| the eight `*-design-guidelines` | `ehmo/platform-design-skills` | `omp plugin install platform-design-skills@srobroek-omp` |

`web-quality-skills` is MIT with a LICENSE file (Copyright 2026 Addy Osmani). Because
skill granularity is the whole plugin, it also installs `best-practices`,
`core-web-vitals`, `performance`, `seo`, and `web-quality-audit`. Those are adjacent
tooling rather than design routes, and no wrapper here routes to them.

## Routes that need no skill

The `accessibility-scanner` MCP server ships declared in this package's
`.omp-plugin/plugin.json`, so it needs no install. It connects at session startup only:
a server unreachable when the session began stays unreachable until the user runs
`/mcp reconnect accessibility-scanner`. An agent cannot reconnect it.

The axe CLI needs no install either, because `npx --yes` fetches it per run. Pass
`--package`, because the package `@axe-core/cli` installs a bin named `axe`:

```
npx --yes --package=@axe-core/cli axe <url> [<url>...] --stdout --exit
```

`@axe-core/cli` is 4.13.0, MPL-2.0, with a LICENSE file. This package advertises it as a
pointer and never vendors it.

## Why these and not the others

`ss-a11y` from `bitjaru/styleseed` and `fixing-accessibility` from `ibelick/ui-skills`
are both displaced by `accessibility`, which is the deeper treatment of the same topic.

`pa11y` is single-URL and displaced by the axe CLI. `pa11y-ci` is LGPL-3.0-only and
excluded on licence. `ramzesenok/iOS-Accessibility-Audit-Skill` declares no licence
anywhere and is excluded entirely; absent a declaration, all rights are reserved.

## What OMP already covers

Never reach for an external tool for these, because `browser` already provides them:
ARIA snapshots, the accessibility tree, computed styles, screenshots, keyboard input,
viewport sizing, and request interception. The axe route exists for the WCAG 2.2 rule
engine and the gradient-aware contrast resolution, not for DOM access.
