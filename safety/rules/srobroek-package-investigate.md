---
name: srobroek-package-investigate
description: Before adding or changing a dependency, vet the package and prefer the package-manager CLI.
condition: ["(?i)\\b(pnpm\\s+(add|install)|npm\\s+(i|install|add)|yarn\\s+add|bun\\s+add|uv\\s+add|pip3?\\s+install|poetry\\s+add|cargo\\s+add|go\\s+get|composer\\s+require)\\b"]
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
