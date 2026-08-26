# Upstream routes for platform-conformance

| Upstream skills | Repo | Install |
|---|---|---|
| the eight `*-design-guidelines` | `ehmo/platform-design-skills` | `omp plugin install platform-design-skills@srobroek-omp` |
| `modern-web-guidance` | `GoogleChrome/modern-web-guidance` | `omp plugin install modern-web-guidance@srobroek-omp` |

## The eight platform skills, and a naming trap worth knowing

`ehmo/platform-design-skills` is MIT with a LICENSE file and ships exactly eight skills
covering iOS, iPadOS, macOS, watchOS, visionOS, tvOS, Android, and Web. It installs
nothing else, which makes it an unusually clean entry.

Its directories are named `ios`, `ipados`, `macos`, `watchos`, `visionos`, `tvos`,
`android`, and `web`, while each `SKILL.md` frontmatter declares the longer
`<platform>-design-guidelines` name. Discovery registers the FRONTMATTER name and falls
back to the directory basename only when frontmatter carries none, so the registered
names are the long ones and those are what this skill routes to. Do not "correct" a
route to the short directory name; it would never resolve.

The skills are Markdown content with no runtime prerequisite.

## modern-web-guidance

Apache-2.0 with a LICENSE file. It also installs `chrome-extensions`, which no wrapper
here routes to. Its own workflow runs `npx --yes modern-web-guidance@latest search "<topic>"`
and `retrieve`, so it needs network access for the npm package, with an
`npx --yes --offline` fallback when the package is already cached.

It answers a different question from the eight above. They cover platform convention;
this covers whether a web API or pattern is current and widely supported.

## Why not the alternatives

`vercel-labs/agent-skills` ships a `web-design-guidelines` covering the same topic, but
it has no LICENSE file, and whole-plugin granularity would import eight unrelated Vercel
deployment skills. `ehmo`'s own `web-design-guidelines` wins the topic outright.

`rshankras/claude-code-apple-skills` and `scoobynko/claude-code-design-skills` are both
displaced by the eight above. `WordPress/agent-skills` is GPL-2.0 and excluded on licence.
