---
name: design-tool-ladder
description: Which verification tool to use at each design phase, and what evidence each produces. Read before driving a surface.
---

OMP lists every rule by name and description in the domain-rules block, so this file is
addressable without being resident. It carries no `globs` and no `alwaysApply`: the agent
reads it on demand, because it is the longest rule here and applies to a phase rather than
to a file type.

MUST Pick a tool that appears in a table below. Two tables follow: the OMP tool per phase,
  and the external CLI or server per job. A tool in neither is a miss.
MUST Check at COMPONENT level before page level. A component-level failure is smaller to
  locate than the same failure found on an assembled page, and page-first work is the
  named Component Driven anti-pattern.

| phase | tool | evidence | failure it prevents |
|---|---|---|---|
| GROUND | `read` / `grep` / `ast_grep` | token names, scales, 5-10 existing primitives | inventing a token that already exists |
| SPECIFY | `read` DESIGN.md | resolved `{group.token}` refs, Known Gaps | writing TODO / inventing unknowns |
| BUILD | `lsp` rename; `read` / `ast_grep` | every state implemented | text-rename dropping a callsite |
| VERIFY | `browser` (web) or `computer` (native) | ARIA snapshot, then computed style, then screenshot | claiming a surface without driving it |
| CRITIQUE | `browser` / `computer` read-only | named finding + evidence path | visual opinion with no snapshot |
| RECONCILE | same tool as the failing assertion | re-run of that assertion only | re-running the whole suite after a one-line fix |

These external routes are in scope wherever the owning skill names them. Each does
something `browser` cannot, so none of them is a phase violation. This is the whole
catalog: a tool absent from it is a miss.

| tool | what it is for | when to use it rather than the alternative |
|---|---|---|
| `impeccable detect` | coarse rendered-UI defect scan | corroborating signal only; its findings carry `"line": 0`, so never as located evidence. The lead runs it, since the reviewers have no shell |
| `accessibility-scanner` MCP | primary accessibility measurement: WCAG 2.2 engine, gradient contrast | over the axe CLI, because it runs in-process with no ChromeDriver to skew |
| `@axe-core/cli` | multi-URL accessibility gate with a process exit | only when a non-zero exit is the requirement, which the MCP scanner cannot give |
| `browser-driver-manager` | matched Chrome and ChromeDriver pair | before the axe gate, unless an explicit `--chromedriver-path` is passed |
| `motionlint audit` | primary motion measurement: score and reduced-motion sweep | over reading CSS by hand, because it measures what shipped |
| `playwright install chromium` | the Chromium MotionLint drives | first MotionLint run only |
| `lighthouse` | performance, PWA, and SEO categories on a URL | instead of `lighthouse-mcp`, which duplicates it |
| `storybook dev` | story index, prop manifest, and the one-story route | the default: keep it running rather than rebuilding per check |
| `storybook build` | static emit of the routes that framework serves | only when no server should outlive the turn |
| `storybook doctor` | configuration health report | before blaming a route for a config fault |
| `storybook ai setup` | story instructions derived from this codebase | never unprompted, and never restated as static prose |
| `test-storybook` | executes every story as a test | prefer `vitest` on Vite-powered frameworks, where the Vitest addon supersedes it |
| `storybook` MCP docs tools | component prop truth | only when Storybook ran at session start; otherwise read `manifests/components.json` |
| `@google/design.md lint` | gates the authored DESIGN.md | always with an explicit path, never a bare filename |
| `@google/design.md diff` | gates a DESIGN.md edit | on every edit, because `lint` cannot say whether the edit made it worse |
| `@google/design.md export` | bootstrap DTCG for a repo that has none | never as the compiler input: the export is lossy |
| `dtokens check` | independent DTCG schema gate | before the build, never after: a build on malformed source hides the fault one layer down |
| `tz build` | the single token build authority | never alongside a second builder, which would create a second artifact authority |
| `modern-web-guidance` | current web practice and baseline support | over the plugin of the same name, because the CLI needs no install |
| `wireloom` | a Markdown-native wireframe rendered to inline SVG | as a project dependency, because it ships a library and no bin |
| `wire-dsl` MCP | vector wireframe as SVG, PNG, or PDF | when the output must be vector, which the HTML routes cannot give |
| `python3 -m http.server` | serves a prototype so it can be driven | always for an interactive artifact; a prototype read as source is not judged |
| `@superdesign/cli` | hosted concept exploration | last, and only after the user confirms the account |
| `curl` | fetches a route to prove it serves: `index.json`, a manifest, a prototype URL | for a reachability or status check, never to read a rendered surface, which needs `browser` |
| `excalidraw` MCP | diagram, flow, and architecture canvas | it ships in the separate `diagram` package, so this package alone does not provide it |
| `search.py` (`ui-ux-pro-max`) | product-wide visual direction | resolve its installed path first: `${CLAUDE_PLUGIN_ROOT}` is not substituted in skill prose |
| `generate-palette.mjs` (`ss-tokens`) | generates a palette | resolve its installed path first, same reason |
| `styleseed-check.mjs` (`ss-score`) | StyleSeed artifact contract with `file:line` evidence | resolve its installed path first, same reason |
| `bd mol pour` / `bd mol bond` | pours a scoped tier, or bonds a sub-process molecule | a poured tier carries no `mol-` prefix; `bond` resolves only prefixed stems |
| `omp plugin install` | installs one advertised catalog entry | it applies from the NEXT session, so never install and retry inside one |

MUST Take the exact invocation from `skill://ui-review/references/tools.md`. This table
  answers which tool; that file answers how to call it, and is the authority when two
  copies of a command disagree.
MUST Never let a bare bin name be the `npx` spec. Name the package, as in
  `npx --yes @google/design.md`, or pass `--package`, as in `--package=@terrazzo/cli tz`.
  A bare `npx --yes tz` resolves whatever package is published under that name.

MUST Discover tokens and primitives with `read`, `grep`, or `ast_grep` before writing a value.
MUST Drive a web surface with `browser`. Drive a native desktop surface with `computer`.
MUST Collect in this order once per pass: `tab.ariaSnapshot()`, then `tab.evaluate` for computed styles, then `tab.screenshot({selector,fullPage})`. This is the collection order, not a per-claim citation requirement; `rule://design-evidence` governs what each individual claim cites.
MUST Rename a token or component with `lsp` rename. A text substitution that touches a symbol is a miss.
NOT Treat a screenshot as an explanation. A screenshot answers appearance only and cannot say why something fails.
NOT Use screenshot diffing as primary evidence.
NOT Skip the ARIA snapshot for the pass when the surface has an accessibility tree. A single colour claim may still cite computed style alone.
NOT Treat `impeccable detect` output as located evidence. Measured on a fixture with ~10 seeded defects: exit 2, 4 findings, every one `"line": 0`, one an exact duplicate, all 4 attributed to the HTML file though two defects lived in the CSS, and 3 of 10 caught. Corroborate each entry by driving the surface and cite that location; it never stands in for driving the surface.
