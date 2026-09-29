---
name: srobroek-package-investigate
description: Before adding or changing a dependency, vet the package and prefer the package-manager CLI.
condition: ["(?!)"]
scope: "tool:bash"
interruptMode: never
---

Before adding or changing a dependency, check the package is real and maintained
(registry page, last release, weekly downloads). Prefer the package-manager CLI
over manifest edits, and pin per the repo convention.

ADD: screen it first -- reputable author/org, no typosquat, not abandoned or
deprecated. Use the package registry, the web, or context7 for current facts;
training data can predate a compromise or deprecation. If it is clearly fine,
say so in one line and proceed. If there is a concern, raise it before installing.

CHANGE (update/upgrade/remove): confirm it is intended. Check breaking changes
and changelog notes for the new version, and that nothing still depends on
anything being removed. Prefer the latest compatible version. Do not re-vet a
package already in use unless the major version changes.

Bare `pnpm install`, `npm install`, or `bun install` restores what the lockfile
already pins: no package is chosen, so there is nothing to vet. Those forms do
not fire, with or without flags (`--frozen-lockfile`, `--production=false`). An
install that names a package still does, flags first or not (`npm i -D
typescript`), as do every `add`/`require`/`get` form. Package detection stops at
the first `|`, `&&`, or `;`, and redirections such as `2>&1` or `>log` are not
packages. Read-only lookups (`npm view`, `npm search`, `pip index`, `cargo
search`) never fire: they are the investigation this rule asks for.

This is steering, never a block: the command always runs. The first command
naming a package gets this instruction prepended to its tool result, once per
package per session; a later command gets it again only for packages not yet
named. Vet before running the command; if the notice arrives first, vet then
and revert a package that fails.

Package-manager operations are recognized by the registered `package-investigate`
extension, which tokenizes shell command positions and ignores quoted data and
quoted heredoc bodies. The frontmatter condition is intentionally inert because
rules cannot delegate matching to TypeScript.
