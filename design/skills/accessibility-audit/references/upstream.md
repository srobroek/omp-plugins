# Upstream routes for accessibility-audit

The primary measurement route is not a skill at all: it is the `accessibility-scanner` MCP
server this package declares. The upstream skills below carry the criteria coverage and the
platform guidance that a scanner does not.

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
`.omp-plugin/plugin.json`, so it needs no install, and it is the PRIMARY measurement route.
It runs axe-core in-process, so no ChromeDriver and no separate browser binary sit in the
path, which removes the only failure mode that stopped the CLI below. It connects at
session startup only: a server unreachable when the session began stays unreachable until
the user runs `/mcp reconnect accessibility-scanner`. An agent cannot reconnect it.

The axe CLI is the documented FALLBACK, for a multi-URL CI gate only. It needs no install
either: `npx --yes` resolves it on demand and caches it. Pass `--package`, because the bin is named
`axe` and cannot be expressed as the package spec:

```
npx --yes --package=@axe-core/cli axe "<url>" --stdout --exit
```

It drives a real Chrome through ChromeDriver, and the two must match. Install the matched
pair first, or pass an explicit `--chromedriver-path`:

```
npx --yes browser-driver-manager install chrome
```

Measured without that step, the run exits 2 having tested nothing:

```
session not created: This version of ChromeDriver only supports Chrome version 152.
Current browser version is 151.0.7922.174
```

Which is the second caveat in one line: an environment failure and an accessibility
violation both exit non-zero, so the exit code cannot tell them apart. Read the JSON on
`--stdout` and judge the findings. A gate built on the exit code alone reports a broken
driver as a failing audit.

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
viewport sizing, and request interception. The axe-core routes exist for the WCAG 2.2 rule
engine and the gradient-aware contrast resolution, not for DOM access.
