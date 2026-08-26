# design

UI and UX design for OMP:

- grounding in the design system that already exists
- Component Driven build
- browser-driven verification
- independent critique

Install alongside the `beads` plugin. The formulas assume a beads workspace.

## Skills

The wrapper skills route to the upstream skills below. When an upstream is absent, the
wrapper stops and prints the install command. Three skills are not wrappers: `ui-review`
is implemented here, and `wireloom` and `ux-copy` are vendored, so all three ship with
this package.

| Skill | Implementation or route | Use when |
|---|---|---|
| `design-system-audit` | routes to `ss-tokens`, `ui-ux-pro-max`, `ss-score` | Report the tokens, scales, and primitives that exist |
| `design-md` | routes to `create-design-md` | Author and lint repo-root DESIGN.md |
| `ui-review` | local, drives OMP `browser` | Drive a real surface and measure it |
| `accessibility-audit` | routes to `accessibility`; also the `accessibility-scanner` server and the `@axe-core/cli` gate | Check WCAG 2.2 AA with measured values |
| `platform-conformance` | routes to eight `*-design-guidelines` and `modern-web-guidance` | Check vendor conventions per platform |
| `motion-design` | routes to `ss-motion`; also the `motionlint` CLI | Set durations, easings, reduced-motion branches |
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

DESIGN.md is not the compiler input. `design.md export --format dtcg` resolves aliases,
flattens colors to sRGB, and drops the component, theme, and density tiers.

```bash
npx --yes @google/design.md lint DESIGN.md
npx --yes --package=@design-token-kit/cli dtokens check --scope schema 'tokens/**/*.json'
npx --yes --package=@terrazzo/cli tz build
```

Pass `--package` for the last two. The bare bin name `dtokens` resolves an unrelated npm
package, and the bare name `tz` resolves a package with no bin.

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

```bash
bd mol pour design-surface --var surface=/settings --var scope=src/settings/
bd mol bond mol-design-iterate <node-id> --var surface=/settings --var node=<node-id>
```

## Relationship to the bundled designer agent

OMP bundles a `designer` agent, which remains the cheap path for a small self-contained UI
edit. This package ships no agent named `designer`, because discovery is first-wins and
merges no frontmatter.

Use `ui-ux-specialist` when the work spans components, needs a system audit, or needs
independent critique.

## One winner per topic

Each topic has one first-choice asset, so routing stays consistent.

| Topic | Winner |
|---|---|
| Design workflow and anti-slop | `impeccable`, 59 executable detector rules |
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

Install one with `omp plugin install <name>@srobroek-omp`.

| Entry | Source | Brings |
|---|---|---|
| `impeccable` | `git-subdir`, path `plugin` | `impeccable` |
| `styleseed` | `github` | `ss-tokens`, `ss-motion`, `ss-score`, and 20 more |
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

- `impeccable` keeps its plugin under `plugin/`.
- `frontend-slides` keeps its plugin under `plugins/frontend-slides/`. Discovery does not
  resolve the bare `SKILL.md` at its repository root.

A catalog entry advertises a plugin. It declares no dependency: marketplace install
registers one plugin and runs no package manager. Installing this package pulls in none of
the entries above.

Skill granularity is the whole plugin. Discovery resolves
`<plugin-root>/skills/<name>/SKILL.md`, and neither a lone skill directory nor a bare
`skills/` container satisfies that path. `git-subdir` does not narrow an entry to one
skill, so some good skills stay out.

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

## CLI tools

`npx` fetches each one per run. Where the bin name differs from the package name, pass
`--package`, or npx resolves a different package.

| Invocation | npm package | License |
|---|---|---|
| `npx --yes impeccable detect <target> --json` | `impeccable` 3.6.0 | Apache-2.0 |
| `npx --yes storybook dev`, `build`, `doctor` | `storybook` 10.5.10 | MIT |
| `npx --yes --package=@storybook/test-runner test-storybook` | `@storybook/test-runner` 0.24.4 | MIT |
| `npx --yes --package=@axe-core/cli axe <urls>` | `@axe-core/cli` 4.13.0 | MPL-2.0 |
| `npx --yes motionlint audit <url>` | `motionlint` 0.2.1 | MIT |
| `npx --yes lighthouse <url>` | `lighthouse` 13.4.1 | Apache-2.0 |
| `npx --yes @google/design.md lint` | `@google/design.md` 0.4.0 | Apache-2.0 |
| `npx --yes --package=@design-token-kit/cli dtokens` | `@design-token-kit/cli` 1.8.0 | Apache-2.0 |
| `npx --yes --package=@terrazzo/cli tz build` | `@terrazzo/cli` 2.7.1 | MIT |

## Considered and not included

| Asset | Reason |
|---|---|
| `educlopez/ui-craft` | `impeccable` carries 59 executable rules against 43, and owns a workflow. The UI Craft score names no location |
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

## Licenses

Three tiers govern each upstream:

| Evidence | This package may |
|---|---|
| LICENSE file, permissive text | advertise it, or vendor it with attribution |
| Declaration in `package.json` only | advertise it as a pointer, never vendor it |
| No declaration anywhere | exclude it, because the author reserves all rights |

The `excalidraw` server in the `diagram` package sits in the middle tier. This package
vendors no GPL, AGPL, LGPL, or CC-BY-NC content.

## License

Apache-2.0
