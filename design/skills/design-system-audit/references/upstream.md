# Upstream routes for design-system-audit

Every upstream is an entry in the `srobroek-omp` catalog, so a missing skill is one
command away. Marketplace install runs no package manager, so nothing here arrives as
a dependency of `@srobroek/design`; each is an explicit install.

The table routes by TASK, because StyleSeed splits generating a system from auditing one
and says so itself. This skill audits, so `ss-lint` and `ss-review` are its first routes.

| Upstream skill | Task it owns | Repo | Install |
|---|---|---|---|
| `ss-lint` | Fast automated detection of design-system violations in existing code | `bitjaru/styleseed` | `omp plugin install styleseed@srobroek-omp` |
| `ss-review` | Reviewing UI code for design-system compliance | `bitjaru/styleseed` | same entry |
| `ss-tokens` | Generating an accessible semantic palette from a key color; viewing, adding, and modifying tokens | `bitjaru/styleseed` | same entry |
| `ss-score` | Validating the StyleSeed artifact contract, with file and line evidence | `bitjaru/styleseed` | same entry |
| `ui-ux-pro-max` | Product-wide visual direction | `nextlevelbuilder/ui-ux-pro-max-skill` | `omp plugin install ui-ux-pro-max@srobroek-omp` |

All four `ss-*` routes ship in the one `styleseed` entry, so adding `ss-lint` and
`ss-review` changes no install command. The cost is paid once.

## Why the routes split by task

`ss-tokens` describes itself as generating "an accessible semantic palette from a key
color, or view, add, and modify StyleSeed design tokens", and its own **When NOT to use**
section says:

> For finding token violations in existing code -> use /ss-lint

Routing this skill's audit to `ss-tokens` therefore hands the job to a generator that
declines it in writing. `ss-lint` is "Quick automated lint - detects common design system
violations in seconds" and `ss-review` is "Review UI code for design system compliance".
Those two are the audit. `ss-tokens` is what runs afterwards, once the user has approved a
new or extended system, which is the gate in the skill body.

## The `${CLAUDE_PLUGIN_ROOT}` trap

`ui-ux-pro-max` documents its catalog lookup as:

```
${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py
```

That variable is substituted only into MCP `command`, `cwd`, `args`, and `env`. It is
never substituted into skill body text and never into a shell command, so the literal
string reaches the shell and the lookup fails with no such file.

Resolve the installed plugin directory first, then run the script from that real path. It
also needs a POSITIONAL query, so the working form is:

```
python3 "<installed>/scripts/search.py" "<query>" --design-system
```

The script is Python 3 with no external dependencies and needs no network, so confirm
`python3` is present before relying on catalog lookups. The same trap binds the two
StyleSeed script paths, `<installed-ss-tokens>/scripts/generate-palette.mjs` and
`<installed-ss-score>/scripts/styleseed-check.mjs`, which were never variables at all;
`skill://ui-review/references/tools.md` collects all three.

## Why these three and not others

`ss-a11y` and `ss-copy` are displaced: accessibility belongs to
`skill://accessibility-audit` and copy to `skill://ui-microcopy`. `design-token` from
`Owl-Listener/designer-skills` is displaced by `ss-tokens`, and that repository is not
advertised at all because obtaining three useful skills from it costs 41 installed
skills; `git-subdir` cannot narrow that, which was verified empirically.

`ss-score` earns its place beside `ss-tokens` only because its output is actionable on
its own: file and line locations, detector ids, and fix text. An aggregate score with
no located finding would not qualify.
