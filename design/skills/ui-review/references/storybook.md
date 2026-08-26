# Storybook without the MCP server

Storybook supports many frameworks. Its own feature-support matrix names four core
frameworks with dedicated maintainers, React, Vue 3, Angular, and Web Components, plus six
community frameworks, Ember, HTML, Svelte, Preact, Qwik, and SolidJS. `ArgTypes` and
`CSF Stories` are supported in all ten, and the test runner in all but Ember.

## Which routes work on which framework

Measured on Storybook 10.5.10 with `@storybook/addon-mcp` 0.7.0 installed in BOTH projects,
so the difference is the framework and not a missing addon.

| Route | React | Vue 3 |
|---|---|---|
| `/index.json`, the CSF index | 200 | 200 |
| `/iframe.html?id=<storyId>` | 200 | 200 |
| `/manifests/docs.json` | 200 | 200 |
| `/manifests/components.html`, the debugger | 200 | 200, reporting zero components |
| `/manifests/components.json`, the prop table | 200 | 404, `Manifest "components" not found` |

Three packages share the work, which is why the table splits the way it does.
`@storybook/addon-mcp` only turns the feature on, setting `features.componentsManifest`.
`@storybook/react` generates the components payload into `experimental_manifests`.
`@storybook/addon-docs` generates the docs manifest. Verified in each package's own
`dist/preset.js`.

So a Vue project with `@storybook/addon-mcp` installed still has no components manifest: the
flag is on, and no framework package produces that payload. Its docs manifest works, because
`@storybook/addon-docs` is framework-agnostic.

The React initializer installs `@storybook/addon-mcp` automatically; the Vue initializer does
not, so add it before expecting any manifest route at all.

## Why the MCP server usually is not available

Plugin MCP servers connect at session startup and an agent cannot reconnect them:
`/mcp reconnect <name>` and `/mcp reload` are interactive slash commands, so only the user
can run one. The declared `storybook` server points at `http://localhost:6006/mcp`, which
connects only if Storybook was already running when the session began.

When this skill starts Storybook itself, the MCP tools are unavailable for the rest of the
session. Say so in the report and use the HTTP routes above. You MAY tell the user that
`/mcp reconnect storybook` would enable the tools, but never plan it as your own action.

## Start the dev server, and keep it

DEFAULT the dev server. Start it once through `hub`, then reuse it for every later check in
the run:

```
hub op=start name=storybook
  npx --yes storybook dev -p 6006 --ci --no-open --quiet --disable-telemetry
  ready = { "port": 6006, "timeout": 240 }
```

Gate readiness on the PORT, never on a log pattern. Storybook 10.5.10 prints
`storybook v10.5.10` and then a manifest line, and never the word "started", so a
`log` condition waits out the whole timeout while the server is already serving. When both
`log` and `port` are supplied, BOTH must pass, so one stale pattern hides a working server.
Allow 240 seconds: a cold Vite dependency scan takes minutes.

Three reasons this beats rebuilding. It recompiles on change, so a fix costs no rebuild. The
process is project-scoped and outlives the turn, so `hub op=start` once serves every
subsequent probe. And the user can open `http://localhost:6006` and watch the same surface
being driven, which a static directory cannot offer.

MUST report the URL in your output so the user can follow along.

Telemetry is on by default, which is why `--disable-telemetry` is not optional.

Enumerate stories from `http://localhost:6006/index.json`, which carries `id`, `title`,
and `tags` per entry.

## Static build, only when a server has no purpose

Build instead of serving only when running a server is pointless or impossible: a CI job, a
sandbox with no free port, or a single artifact read with no follow-up. Otherwise the server
wins, because every fix after a static build costs a full rebuild.

`npx --yes storybook build -o "<dir>"` emits, under that directory, the routes that framework serves.
Measured on React: `index.json`, `manifests/components.json`, `manifests/docs.json`, and
`manifests/components.html`. A build cannot add a route the dev server withholds for that
framework, so a Vue project still yields no components manifest.

Adding `--test` speeds the build and DROPS the docs artifacts: `index.json` and
`manifests/components.json` remain, while `manifests/docs.json` and
`manifests/components.html` are absent. Use `--test` for running stories as tests, and a
plain build for reading documentation.

## What lands on disk

`storybook dev` serves from memory and writes nothing durable, but it is not side-effect
free. It populates two disposable caches, `node_modules/.cache/storybook/` and
`node_modules/.vite/`. And a crash or a debug run writes a `*.log` into the CALLER's working
directory rather than a temp dir: measured, one run left `debug-storybook.log` in an
unrelated repository, which had to be removed by hand. Run it from the project, and check
for a stray log before reporting done.

`storybook build` defaults to `storybook-static/` when `-o` is omitted, so pass `-o` whenever
the location matters. The `.gitignore` that `storybook init` generates lists exactly
`storybook-static` and `*.log`, which corroborates both outputs.

## What persists

Two layers, and only one of them is durable.

**The source is the durable design record.** Components, stories, and tokens are ordinary
committed files. The `stories` glob in `.storybook/main.ts`, for example
`["../src/**/*.mdx", "../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"]`, IS the registry: any
matching file is discovered on every start. Nothing is ever re-added.

**The local view is disposable.** It is memory plus the caches above, and one command
regenerates it.

## The manifests are the primary agent surface

`http://localhost:6006/manifests/components.json` is the ground truth that
`rule://design-component-truth` requires before a prop is used. Its shape, verified against
Storybook 10.5.10:

```
{ "v": 0,
  "components": {                    <- an OBJECT keyed by component id, not an array
    "example-button": {
      "id", "name", "path", "import", "description", "jsDocTags",
      "reactDocgen": {               <- engine-specific payload; see the dispatch below
        "props": { "backgroundColor": { "required": false,
                                        "tsType": { "name": "string" },
                                        "description": "What background color to use" } },
        "actualName", "definedInFile", "displayName", "exportName", "methods" },
      "stories": [ { "id", "name", "snippet" } ] } },
  "meta": { "docgen": "react-docgen", "durationMs": 64 } }
```

Index `components` by component id, then read the ENGINE-SPECIFIC payload. Do not hardcode
one key: read `meta.docgen` and pick accordingly. The key is not the engine string itself,
for example engine `react-docgen` puts its payload under `reactDocgen`.

`@storybook/react/dist/preset.js` chooses the engine:

```
features.experimentalDocgenServer       -> components: {}, meta.docgen "react-component-meta"
features.experimentalReactComponentMeta -> "react-component-meta"
typescript.reactDocgen set              -> that value verbatim, e.g. "react-docgen-typescript"
otherwise                               -> "react-docgen"
```

On the `react-docgen` path, `reactDocgen.props` is keyed by prop name, each entry carrying
`required`, a `tsType`, and a `description`.

An empty `components` map is NOT proof that a project has no components: under
`experimentalDocgenServer` the generator returns an empty map by design. Treat empty as
inconclusive and read the source instead.

Take the `import` statement verbatim, and take a `snippet` from `stories` as a worked example.

`http://localhost:6006/manifests/docs.json` gives MDX pages as
`{ "v", "docs": { <id>: { "id", "name", "title", "path", "summary", "content" } } }`,
including design-token and typography documentation.

`http://localhost:6006/manifests/components.html` is the human-readable debugger and shows
generation errors and warnings.

The docs manifest is static analysis only. A `Colors.mdx` that maps over a token object at
runtime contributes nothing, so token values must appear literally. That is one more reason
DESIGN.md stays the literal authored record.

## Inspect and test

Render one story in isolation at `http://localhost:6006/iframe.html?id=<storyId>` and apply
the ARIA, computed-style, and viewport probes from `skill://ui-review/references/probes.md`
to it. This is Component Driven verification: a component-level failure is smaller to
locate than the same failure found on an assembled page.

MUST Scope every probe to `#storybook-root`. The story root is not the document root: the
frame also holds Storybook's hidden fallback chrome, marked `sb-preparing-story`,
`sb-preparing-docs`, `sb-nopreview`, and `sb-errordisplay`. Measured on one story at 1440,
`button,input,select,a[href]` returned 28 unscoped against 21 scoped, and
`querySelectorAll('table')` returned 2 on a page with one table.

That breaks measurement and interaction differently. Unscoped, the target-size probe
reported 7 controls under 24x24, every one of them 0x0 and from the chrome; scoped, it
reported none. Unscoped, `querySelector('table tbody tr button')` resolved the chrome's
placeholder prop table first, so a click timed out after 8000ms against a 0x0 element while
reporting a plausible `matches 15 element(s)`.

Execute every story:

```
npx --yes --package=@storybook/test-runner test-storybook \
  --url http://localhost:6006 --json --outputFile sb.json --failOnConsole
```

Pass `--package`. The bin `test-storybook` belongs to `@storybook/test-runner`, and a
separate unrelated `test-storybook` package exists on npm, so the bare form fetches the
wrong code rather than failing safely.

It picks up accessibility checks when `@storybook/addon-a11y` is installed. On Vite-powered
frameworks it is superseded by the Vitest addon, so prefer `vitest` there.

`npx --yes storybook doctor` reports configuration health.

## Composition, for Component Driven stages two and three

`refs` in `.storybook/main.ts` composes any Storybook reachable by URL, local or published,
across frameworks, so a design-system Storybook can be referenced while larger components
are assembled:

```ts
refs: { 'design-system': { title: '...', url: 'https://...', expanded: false, sourceUrl: '...' } }
```

Local multi-framework composition uses separate ports, and `refs` may be a function of
`(config, { configType })` to vary by environment.

Two caveats that matter in practice: addons in composed Storybooks do not work as they
normally do, and `storybook extract` is not available in 8.0 or higher.

## MCP tools, when they are connected

Seven tools in three toolsets, all enabled by default, configured through
`@storybook/addon-mcp` `options.toolsets`:

| Toolset | Tools |
|---|---|
| `docs` | `list-all-documentation`, `get-documentation`, `get-documentation-for-story` |
| `dev` | `get-storybook-story-instructions`, `get-changed-stories`, `preview-stories` |
| `test` | `run-story-tests` |

These are React-only and in preview, and the manifest schema is explicitly not a public
API. Where they are absent, the HTTP routes above are equivalent for reading, and reading
the component source and its type declaration is the fallback authority.

## Setting Storybook up where none exists

Never install it unprompted. When the user wants it, run `npx --yes storybook ai setup`. It
analyses the actual codebase and emits project-specific instructions: read providers,
global CSS, portals, and data-fetching patterns; configure decorators, global styles, and
framework providers in `preview.tsx`; ensure portal roots exist in the preview DOM;
intercept network requests via MSW plus storage, timers, and navigation at preview level
rather than per story; write stories for up to ten components from simple to complex,
tagged `ai-generated` for review; add play functions for the most important flows; expand
coverage across touched components; run Vitest against every new story plus the type
checker; and install useful addons including MCP.

Do not restate those steps as a static procedure. Their value is that the tool derives them
from the real codebase, which prose cannot.

## Authoring rules that make stories useful to an agent

- One concept per story. A story demonstrating five sizes and variants at once is the named
  anti-pattern.
- Describe why, not what.
- Put a JSDoc description and `@summary` above the component export and above each story,
  because the agent receives the summary or a truncated description.
- Document every prop with JSDoc.
- Prefer `reactDocgen: 'react-docgen-typescript'` for accuracy; fall back to `react-docgen`
  for speed.
- Curate with the implicit `manifest` tag. Exclude a story or a whole file with
  `tags: ['!manifest']`.
- Wrap a CONTROLLED component in a state holder, never args alone. A component taking a
  value plus an `onChange` renders every field from args and then rejects every keystroke,
  because nothing writes the value back. That reads as a broken control rather than as a
  story defect, and it is the failure a page-level state story hits first. Give the story a
  decorator or wrapper holding real state, and verify by typing into a field and reading the
  value back.

## Documentation retrieval

`https://storybook.js.org/llms.txt` is the index and states the access contract;
`llms-full.txt` is the whole corpus. Append `.md` to any docs URL for clean markdown, with
`?renderer=react|vue|angular|svelte|web-components|solid|preact|html|ember|qwik`,
`?language=ts|js`, and `?codeOnly=true`. Always pass the project's real renderer, because
the default is React. Version with `/docs/9/...md` or `llms-full.txt?version=9`.

Prefer these over the `context7` MCP: they are primary and add no dependency.
