---
name: srobroek-package-investigate
description: Before adding or changing a dependency, vet the package and prefer the package-manager CLI.
condition: ["(?i)(?:^|[;|&])\\s*(?:(?:(?:pnpm|npm|bun|yarn)\\s+(?:add|i|install)|uv\\s+add|pip3?\\s+install|poetry\\s+add|cargo\\s+add|go\\s+get|composer\\s+require|(?:pnpm|npm|bun|yarn)\\s+(?:search|view)|pip3?\\s+index|cargo\\s+search)\\s+(?:-{1,2}[A-Za-z][^\\s;|&<>()`$]*\\s+)*(?!-)[A-Za-z@./_~][^\\s;|&<>()`$]*(?:\\s+-{1,2}[A-Za-z][^\\s;|&<>()`$]*)*)"]
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
typescript`), as do every `add`/`require`/`get` form. Package-manager search and
view commands also fire because they select a package to investigate. The
matcher recognizes commands at the start of the shell string or after `;`, `|`,
or `&`; excluding `(` avoids prose examples in quoted payloads. As with any
regex over an entire shell string, nested quoting and heredoc syntax cannot be
parsed perfectly; keep package examples in prose from looking command-like.
