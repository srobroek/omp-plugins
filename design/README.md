# design

UI and UX design for OMP:

- grounding in the design system that already exists
- Component Driven build
- browser-driven verification
- independent critique

## Install

```bash
omp plugin marketplace add srobroek/omp-plugins
omp plugin install design@srobroek-omp
```

From a clone of this repository, link the directory instead:

```bash
omp plugin link <path-to-repo>/design
```

Install the `beads` plugin too: the formulas assume a beads workspace.

Either carrier applies from the NEXT session, because OMP discovers plugins at startup.

## Usage

In that next session, the ten skills load, the five rules are listed, and
`ui-ux-specialist` is spawnable. Confirm the package registered:

```bash
omp plugin list
```

A marketplace install appears there as `design@srobroek-omp (0.1.0)`. `omp plugin doctor`
reports a `✔ plugin:@srobroek/design` line for a linked directory only, and a
`⚠ … not an omp plugin` line means that directory's rules and agents are silently absent.

## Skills

The wrapper skills route to the upstream skills below. When an upstream is absent, the
wrapper stops and prints the install command. Three skills are not wrappers: `ui-review`
is implemented here, and `wireloom` and `ux-copy` are vendored, so all three ship with
this package.

| Skill | Implementation or route | Use when |
|---|---|---|
| `design-system-audit` | routes to `ss-lint` and `ss-review` to audit, `ss-tokens` to generate, plus `ui-ux-pro-max` and `ss-score` | Report the tokens, scales, and primitives that exist |
| `design-md` | routes to `create-design-md`, which needs a repository or URL to extract from | Author and lint repo-root DESIGN.md |
| `ui-review` | local, drives OMP `browser` | Drive a real surface and measure it |
| `accessibility-audit` | the `accessibility-scanner` server measures; `accessibility` covers criteria; the `@axe-core/cli` gate is the fallback | Check WCAG 2.2 AA with measured values |
| `platform-conformance` | routes to eight `*-design-guidelines` and `modern-web-guidance` | Check vendor conventions per platform |
| `motion-design` | the `motionlint` CLI measures; `ss-motion` authors React `motion.X` only | Set durations, easings, reduced-motion branches |
| `ui-microcopy` | routes to vendored `ux-copy` | Write interface copy, errors, empty states |
| `design-prototype` | routes by fidelity to five upstreams and two servers | Produce a wireframe, prototype, mockup, or deck |
| `wireloom` | vendored, MIT | Render a wireframe as inline SVG inside Markdown |
| `ux-copy` | vendored, Apache-2.0 | Apply the microcopy method itself |

## Agents

| Agent | Role | Model |
|---|---|---|
| `ui-ux-specialist` | Design lead. Grills, builds bottom-up, delegates critique | `@designer` |
| `design-critic` | Read-only visual and UX critique | `@designer` |
| `a11y-auditor` | Read-only WCAG 2.2 AA audit | `@designer` |

The lead spawns `design-critic` and `a11y-auditor` in one parallel batch. It also spawns
bundled `scout` for recon and `operator` for mechanical steps.

The lead never writes its own critique. An agent reviewing its own UI repeats the gap that
produced the defect.

## Method

Six phases run in order: GROUND, SPECIFY, BUILD, VERIFY, CRITIQUE, RECONCILE.

Three interrogation gates punctuate them. The lead asks for INTENT after GROUND, asks for
SYSTEM approval when the audit returns ABSENT or PARTIAL, and asks for ACCEPT after
RECONCILE. `design-surface` and `design-system` each declare all three.

When a human is reachable, a gate grills the user. In an unattended run, the gate records
the question on the bead and proceeds.

BUILD follows Component Driven methodology, bottom-up, per
`https://www.componentdriven.org/`:

| Stage | Requirement |
|---|---|
| Build one component at a time | In isolation, with its states defined |
| Combine components | Compose small components, increasing complexity |
| Assemble pages | Use mock data to reach hard-to-produce states |
| Integrate pages | Connect real data and business logic |

Because a component-level failure is smaller to locate, verification runs at component
level first, then at page level. Page-first development is the named anti-pattern.

## Rules

| Rule | Use when |
|---|---|
| `design-tool-ladder` | Choosing a tool per phase, and the evidence it produces |
| `design-token-discipline` | Taking colors and spacing from tokens; a new scale needs approval |
| `design-evidence` | Naming the evidence behind a UI claim |
| `design-no-slop` | Avoiding generated-UI tells |
| `design-component-truth` | Verifying a component prop against documentation |

## Token pipeline

Layered DTCG under `tokens/**/*.json` is the canonical machine source. DESIGN.md holds
authored intent and a linted projection of that source.

DESIGN.md is not the compiler input. `npx --yes @google/design.md export "$(git rev-parse
--show-toplevel)/DESIGN.md" --format dtcg` resolves aliases, flattens colors to sRGB, and
drops the component, theme, and density tiers.

```bash
npx --yes @google/design.md lint "$(git rev-parse --show-toplevel)/DESIGN.md"
find tokens -type f -name '*.json' -print0 \
  | xargs -0 npx --yes --package=@design-token-kit/cli dtokens check --scope schema
npx --yes --package=@terrazzo/cli tz build
```

Never let a bare bin name be the spec. Naming the package covers `@google/design.md`,
whose bins are `design.md` and `designmd`. The last two need `--package`: a bare
`dtokens` resolves an unrelated package, and a bare `tz` resolves a package with no bin.
`dtokens` expands no glob, so enumerate the token files and pass each as its own argument.

Terrazzo is the single build authority. A second builder would create a second artifact
authority. Details in `skills/design-system-audit/references/token-pipeline.md`.

## Storybook

Storybook documents ten frameworks: React, Vue 3, Angular, and Web Components as core, plus
Ember, HTML, Svelte, Preact, Qwik, and SolidJS.

The skills run a dev server and keep it, rather than rebuilding. It recompiles on change, it
outlives the turn, and you can open `http://localhost:6006` to watch the same surface the
agent drives. The served URL appears in every report.

The documented route needs no MCP server:

- `index.json` for the story index
- `manifests/components.json` for the prop table and import statement
- `iframe.html?id=<storyId>` to drive one story
- `npx --yes --package=@storybook/test-runner test-storybook` to execute them

Pass `--package` on that last one. An unrelated `test-storybook` package exists on npm.

Route support differs by framework, measured on Storybook 10.5.10 with
`@storybook/addon-mcp` installed in both a React and a Vue project. `index.json`,
`iframe.html`, and `manifests/docs.json` serve on both. `manifests/components.json` serves
on React and returns 404 on Vue, because `@storybook/react` generates that payload and no
Vue framework package does. Where it is absent, take prop truth from the rendered Autodocs
`ArgTypes` block, which all ten frameworks support, or from the component source.

A static build is the exception, for a CI job or a one-shot read. `npx --yes storybook build
-o "<dir>"` emits the routes that framework serves, measured on React as all four. Adding
`--test` drops `manifests/docs.json` and the debugger page. A static build cannot add a
route the dev server does not serve for that framework, so Vue still yields no components
manifest.

MCP servers connect at session startup, and an agent cannot reconnect one. When this
package starts Storybook itself, the MCP tools stay unavailable. Details in
`skills/ui-review/references/storybook.md`.

## Formulas

A poured tier carries no `mol-` prefix. `bd mol bond` resolves the prefix, so only
bondable formulas take it.

| Formula | Steps | Gates | Use when |
|---|---|---|---|
| `design-touch` | 8 | 1 | Making a scoped change inside an existing system |
| `design-surface` | 15 | 3 | Building a new surface with full staging |
| `design-system` | 22 | 3 | Establishing or rebuilding a design system |
| `mol-design-iterate` | 6 | 2 | Running another round after an intent change |
| `mol-design-fix-findings` | 4 | 0 | Working the critique and accessibility findings |
| `mol-design-component` | 4 | 0 | Building one primitive to full state coverage |
| `mol-design-tokens` | 5 | 1 | Establishing or migrating a token system |
| `mol-design-a11y` | 4 | 0 | Remediating after a MAJOR accessibility verdict |
| `mol-design-responsive` | 4 | 0 | Running a reflow and target-size pass |
| `mol-design-motion` | 4 | 0 | Running a motion and reduced-motion pass |

Pour a tier, then bond a sub-process molecule onto the root id the pour prints:

```bash
export BEADS_ACTOR=you
root=$(bd mol pour design-touch --var surface=/settings --var scope=src/settings/ \
  | sed -n 's/.*Root issue: //p')
bd mol bond mol-design-iterate "$root" --var surface=/settings --var node="$root" --var round=2
```

`bd` rejects a mutating command when `BEADS_ACTOR` is unset, and `bd mol bond` takes the
formula name and the target id as two positional arguments.

## Relationship to the bundled designer agent

OMP bundles a `designer` agent, which stays the right choice for a small self-contained UI
edit. This package ships no agent named `designer`, because discovery is first-wins and
merges no frontmatter.

Use `ui-ux-specialist` when the work spans components, needs a system audit, or needs
independent critique.

## One winner per topic

Each topic has one first-choice asset, so routing stays consistent.

| Topic | Winner |
|---|---|
| Design workflow and anti-slop | `impeccable`; its detector is a coarse signal, not located evidence |
| Design system and tokens | `ss-tokens` |
| DESIGN.md artifact | `create-design-md` |
| Accessibility, web | `accessibility` |
| Platform conformance | the eight `ehmo` `*-design-guidelines` |
| Motion | `ss-motion` |
| Microcopy | `ux-copy` |
| Wireframing | `html-wireframe`, `wireloom` |
| Clickable prototyping | `html-prototype` |
| Product-wide visual direction | `ui-ux-pro-max` |
| Current web practice | `modern-web-guidance` |
| Token build | Terrazzo |
| Browser-driven verification | `ui-review`, on OMP `browser` |

The detector claims 59 executable rules. Measured on a fixture carrying about ten
seeded defects:

| Observation | Value |
|---|---|
| Exit code | 2 |
| Findings returned | 4, one an exact duplicate |
| Location on each finding | `"line": 0` |
| File attributed | the HTML file, though two defects lived in the CSS |
| Seeded defects caught | 3 of 10 |

Treat each finding as a coarse signal, and corroborate it by driving the surface. It
is never located evidence, and never a stand-in for driving the surface.

No skill routes to two `impeccable` commands:

- `clarify` omits an onboarding surface, tone-tagged alternatives, a requester checklist,
  and a tone map. `ux-copy` carries all four.
- `document` does not write DESIGN.md. Its site lists six sections and its repository
  prompt lists eight. Its sample frontmatter fails the linter, whose dimension pattern
  rejects `clamp(...)`.

## Narrow specializations

A second asset joins a winner only when its output stands alone.

| Asset | Output |
|---|---|
| `ss-score` | `deterministic.json` with file and line locations, detector ids, fix text |
| `@axe-core/cli` | Multi-URL CI gate with a process exit; the MCP scanner takes one page |
| `chrome-cdp-ex` | CSS cascade origin: winning and overridden rules, mapped to source line |
| `wireloom` | Markdown-native wireframes as self-contained inline SVG |
| `frontend-slides` | Fixed 16:9 decks with PDF export |
| `web-asset-generator` | Favicon sets, app icons, social images |

## Packages in this marketplace

Install one with `omp plugin install "<name>@srobroek-omp"`.

| Entry | Source | Brings |
|---|---|---|
| `impeccable` | `git-subdir`, path `plugin` | `impeccable` |
| `styleseed` | `github` | `ss-lint`, `ss-review`, `ss-tokens`, `ss-motion`, `ss-score`, and 18 more |
| `ui-skills` | `github` | `create-design-md`, and 6 more |
| `platform-design-skills` | `github` | the eight `*-design-guidelines` |
| `web-quality-skills` | `github` | `accessibility`, and 5 more |
| `ui-ux-pro-max` | `github` | `ui-ux-pro-max`, and 6 more |
| `modern-web-guidance` | `github` | `modern-web-guidance`, `chrome-extensions` |
| `effective-html` | `github` | `html-wireframe`, `html-prototype`, and 4 more |
| `frontend-slides` | `git-subdir`, path `plugins/frontend-slides` | `frontend-slides` |
| `web-asset-generator` | `github` | `web-asset-generator` |
| `superdesign` | `github` | `superdesign` |

Two entries need `git-subdir`, because a subdirectory holds the plugin root:

- `impeccable` keeps its plugin under `plugin/`. Inside that root its one skill sits at
  `./skills/impeccable/`, which the plugin's own manifest declares as `"skills": "./skills/"`.
  No `.agent` or `.agents` directory exists in the installed plugin. Its two version numbers
  disagree: the npm CLI reports 3.6.0 while the plugin manifest reads 4.1.2.
- `frontend-slides` keeps its plugin under `plugins/frontend-slides/`. Discovery does not
  resolve the bare `SKILL.md` at its repository root.

A catalog entry advertises a plugin. It declares no dependency: marketplace install
registers one plugin and runs no package manager. Installing this package pulls in none of
the entries above.

Skill granularity is the whole plugin. Discovery resolves
`<plugin-root>/skills/<name>/SKILL.md`, and neither a lone skill directory nor a bare
`skills/` container satisfies that path. `git-subdir` narrows an entry to a subdirectory
holding a plugin root, never to one skill, so an entry arrives whole.

Measured: installing all eleven entries puts 133 `SKILL.md` files on disk under 104
distinct names, to reach the ten these wrappers route to. The 29-file gap is duplication.
`styleseed` ships all 23 `ss-*` skills twice, under `skills/` and again under
`engine/.claude/skills/`, and `ui-ux-pro-max` ships its set twice as well. Name collisions
resolve first-wins with no diagnostic of any kind, so `ss-learn` loses that race: it
installs, and is then unavailable.

| Prerequisite | Entry |
|---|---|
| Python 3 | `ui-ux-pro-max` |
| Python 3, pip, Pillow | `web-asset-generator` |
| Network for `npx` | `modern-web-guidance` |
| Account, and credits for media | `superdesign` |

## Vendored skills

| Skill | Upstream | License |
|---|---|---|
| `ux-copy` | `anthropics/knowledge-work-plugins` | Apache-2.0 |
| `wireloom` | `StardockCorp/Wireloom` | MIT |

Each ships a LICENSE and a NOTICE beside its SKILL.md, and each records its own
modifications.

This package vendors `ux-copy` because installing its repository also exposes four
displaced Figma-oriented review templates. It vendors `wireloom` because that upstream
ships a bare `.md` file, which no catalog entry makes discoverable.

## MCP servers

This package declares three servers. OMP loads plugin MCP tools into one flat
session-global registry, so the `browser-tools` and `diagram` packages hold the
general-purpose servers.

| Server | Provides what `browser` cannot |
|---|---|
| `accessibility-scanner` | axe-core WCAG 2.2 engine, contrast over gradients, fix links |
| `wire-dsl` | Wire DSL rendered to SVG, PNG, and PDF |
| `storybook` | Seven tools over the CSF index, when Storybook ran at session start |

## CLI packages these skills invoke

`npx` resolves each package on demand and caches it, so none becomes a project dependency
and a first run may reach the network. Every version and license below was read from the
npm registry. The exact invocations, the `--package` rule, and the output flags each tool
needs live in `skills/ui-review/references/tools.md`.

| npm package | Version | License |
|---|---|---|
| `impeccable` | 3.6.0 | Apache-2.0 |
| `storybook` | 10.5.10 | MIT |
| `@storybook/test-runner` | 0.24.4 | MIT |
| `@axe-core/cli` | 4.13.0 | MPL-2.0 |
| `motionlint` | 0.2.1 | MIT |
| `lighthouse` | 13.4.1 | Apache-2.0 |
| `@google/design.md` | 0.4.0 | Apache-2.0 |
| `@design-token-kit/cli` | 1.8.0 | Apache-2.0 |
| `@terrazzo/cli` | 2.7.1 | MIT |
| `modern-web-guidance` | 0.0.185 | Apache-2.0 |
| `browser-driver-manager` | 2.0.1 | MIT |
| `playwright` | 1.62.1 | Apache-2.0 |
| `@superdesign/cli` | 0.13.0 | MIT |
| `wireloom` | 0.7.0 | MIT |

## Considered and not included

| Asset | Reason |
|---|---|
| `educlopez/ui-craft` | `impeccable` owns a workflow rather than a review pass. Its detector claims 59 rules against 43, but neither names a location: the UI Craft score names none, and impeccable's findings carry `"line": 0` |
| `Owl-Listener/designer-skills` | MIT and good. Three wanted skills sit in two entries carrying 41 skills, and `git-subdir` cannot narrow that |
| `Wire-DSL/wire-dsl` | Contributes no discoverable skill. Survives as an MCP server |
| `StardockCorp/Wireloom` | Contributes no discoverable skill. Survives as a vendored skill |
| `dominikmartn/nothing-design-skill` | Contributes no discoverable skill |
| `ss-a11y`, `ss-copy` | A winner above covers each topic |
| `fixing-accessibility`, `fixing-motion-performance` | A winner above covers each topic |
| `baseline-ui`, `improve-ui` | `impeccable` covers both |
| `design-token`, `ux-writing` | `ss-tokens` and `ux-copy` cover these |
| five `knowledge-work-plugins` design skills | Figma-oriented review templates, all displaced |
| `fixing-metadata` | Audits metadata that nothing else covers, but emits no located finding. `web-asset-generator` produces the assets |
| `LE-VAI/designesy-org` | Real and MIT. Its output gives a URL only, with no selector or source line |
| `canvas-design` | `xd://generate_image` already covers its raster output |
| `pa11y` | Takes one URL. The axe CLI covers it |
| `lighthouse-mcp`, `motionlint mcp` | Each duplicates a CLI above |
| `culori` | Duplicates `colorjs.io` |
| `penpot/penpot-mcp`, Figma Dev Mode MCP | Neither tool is in use here |

Two probes settled the "no discoverable skill" verdicts. Installing a `git-subdir` entry
pointed at one skill directory yielded zero skills. Installing one pointed at a bare
`skills/` container also yielded zero.

Excluded on license:

| Asset | License |
|---|---|
| `vercel-labs/agent-skills` `web-design-guidelines` | No LICENSE file |
| `contains-studio/agents`, `OneRedOak/claude-code-workflows` | No declaration anywhere |
| `ramzesenok/iOS-Accessibility-Audit-Skill`, `@h4shed/skill-ascii-mockup` | No declaration anywhere |
| `WordPress/agent-skills` | GPL-2.0 |
| `pa11y-ci` | LGPL-3.0-only |
| `tsx/shireframe` | GPL-2.0-or-later |
| `wickedev/wyreframe` | GPL-3.0 |
| `superdesigndev/superdesign`, the application | AGPL |

## License

Apache-2.0 governs this package.

Three tiers govern each upstream it advertises:

| Evidence | This package may |
|---|---|
| LICENSE file, permissive text | advertise it, or vendor it with attribution |
| Declaration in `package.json` only | advertise it as a pointer, never vendor it |
| No declaration anywhere | exclude it, because the author reserves all rights |

The `excalidraw` server in the `diagram` package sits in the middle tier. This package
vendors no GPL, AGPL, LGPL, or CC-BY-NC content.
