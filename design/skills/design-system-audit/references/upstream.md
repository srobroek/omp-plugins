# Upstream routes for design-system-audit

The carrier inventory in the skill is the audit. StyleSeed is an optional second opinion,
taken only when the user asks for it or approves it, and it installs from its author's
marketplace through `rule://design-upstream-preflight`. Nothing here arrives as a
dependency of `@srobroek/design`.

The table routes by TASK, because StyleSeed splits generating a system from auditing one
and says so itself.

| Upstream skill | Task it owns | Repo | Install |
|---|---|---|---|
| `ss-lint` | Fast automated detection of design-system violations in existing code | `bitjaru/styleseed` | `styleseed@styleseed`, via `rule://design-upstream-preflight` |
| `ss-review` | Reviewing UI code for design-system compliance | `bitjaru/styleseed` | same entry |
| `ss-tokens` | Generating an accessible semantic palette from a key color; viewing, adding, and modifying tokens | `bitjaru/styleseed` | same entry |
| `ss-score` | Validating the StyleSeed artifact contract, with file and line evidence | `bitjaru/styleseed` | same entry |

All four ship in the one `styleseed` entry, which installs 23 `ss-*` skills in total. Every
one of them adds its description to every later session, which is why the route is opt-in.

## Why the routes split by task

`ss-tokens` describes itself as generating "an accessible semantic palette from a key
color, or view, add, and modify StyleSeed design tokens", and its own **When NOT to use**
section says:

> For finding token violations in existing code -> use /ss-lint

Routing an audit to `ss-tokens` therefore hands the job to a generator that declines it in
writing. `ss-lint` is "Quick automated lint - detects common design system violations in
seconds" and `ss-review` is "Review UI code for design system compliance". Those two are
StyleSeed's audit. `ss-tokens` is what runs afterwards, once the user has approved a new or
extended system, which is the gate in the skill body.

## Script paths

StyleSeed documents `<installed-ss-tokens>/scripts/generate-palette.mjs` and
`<installed-ss-score>/scripts/styleseed-check.mjs` as if they were runnable. Both are prose
placeholders that never expand. Resolve the install path the preflight reports first;
`skill://ui-review/references/tools.md` holds the working forms.

## Why these four and not others

`ss-a11y` and `ss-copy` are displaced: accessibility belongs to
`skill://accessibility-audit` and copy to `skill://ui-microcopy`. `design-token` from
`Owl-Listener/designer-skills` is displaced by `ss-tokens`, and that repository is not
advertised at all because obtaining three useful skills from it costs 41 installed
skills; `git-subdir` cannot narrow that, which was verified empirically.

`ss-score` earns its place beside `ss-tokens` only because its output is actionable on
its own: file and line locations, detector ids, and fix text. An aggregate score with
no located finding would not qualify.
