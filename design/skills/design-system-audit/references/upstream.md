# Upstream routes for design-system-audit

Every upstream is an entry in the `srobroek-omp` catalog, so a missing skill is one
command away. Marketplace install runs no package manager, so nothing here arrives as
a dependency of `@srobroek/design`; each is an explicit install.

| Upstream skill | Repo | Install |
|---|---|---|
| `ss-tokens` | `bitjaru/styleseed` | `omp plugin install styleseed@srobroek-omp` |
| `ss-score` | `bitjaru/styleseed` | same entry |
| `ui-ux-pro-max` | `nextlevelbuilder/ui-ux-pro-max-skill` | `omp plugin install ui-ux-pro-max@srobroek-omp` |

Skill granularity is the whole plugin, so `styleseed` also installs 20 other `ss-*`
skills and `styleseed` itself, and `ui-ux-pro-max` also installs `banner-design`,
`brand`, `design-system`, `design`, `slides`, and `ui-styling`. Both are MIT with a
LICENSE file.

## The `${CLAUDE_PLUGIN_ROOT}` trap

`ui-ux-pro-max` documents its catalog lookup as:

```
${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py
```

That variable is substituted only into MCP `command`, `cwd`, `args`, and `env`. It is
never substituted into skill body text and never into a shell command, so the literal
string reaches the shell and the lookup fails with no such file.

Resolve the installed plugin directory first, then run the script from that real path.
The script is Python 3 with no external dependencies and needs no network, so confirm
`python3` is present before relying on catalog lookups.

## Why these three and not others

`ss-a11y` and `ss-copy` are displaced: accessibility belongs to
`skill://accessibility-audit` and copy to `skill://ui-microcopy`. `design-token` from
`Owl-Listener/designer-skills` is displaced by `ss-tokens`, and that repository is not
advertised at all because obtaining three useful skills from it costs 41 installed
skills; `git-subdir` cannot narrow that, which was verified empirically.

`ss-score` earns its place beside `ss-tokens` only because its output is actionable on
its own: file and line locations, detector ids, and fix text. An aggregate score with
no located finding would not qualify.
