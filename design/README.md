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

Both installation methods take effect in the next session. OMP discovers plugins at startup.

## Usage

In that next session, OMP loads eight skills and lists five rules. For interface
work, spawn `ui-ux-specialist`. Confirm the package registered:

```bash
omp plugin list
```

A marketplace install appears there as `design@srobroek-omp`. `omp plugin doctor`
reports a `✔ plugin:@srobroek/design` line for a linked directory only.
A `⚠ … not an omp plugin` line means that directory's rules and agents are silently absent.

## Skills

The copy skill is implemented locally as `ui-microcopy`, which includes the merged UX-copy guidance. It ships with this package.

| Skill | Implementation or route | Use when |
|---|---|---|
| `design-system-audit` | local token-carrier inventory with `file:line` evidence; `styleseed` (`ss-lint`, `ss-review`, `ss-tokens`, `ss-score`) only when the user opts in | Report the tokens, scales, and primitives that exist |
| `design-md` | follows `create-design-md`, vendored, MIT, which needs a repository or URL to extract from | Lint and gate the extracted repo-root DESIGN.md |
| `ui-review` | local, drives OMP `browser` | Drive a real surface and measure it |
| `accessibility-audit` | the `accessibility-scanner` server measures; `accessibility` covers criteria; the `@axe-core/cli` gate is the fallback | Check WCAG 2.2 AA with measured values |
| `motion-design` | the `motionlint` CLI measures; `ss-motion` authors React `motion.X` only | Set durations, easings, reduced-motion branches |
| `ui-microcopy` | local, with merged UX-copy guidance | Write and review interface copy, errors, empty states, and CTAs |
| `design-prototype` | routes by fidelity to five upstreams, the `wire-dsl` server, and built-in tools | Produce a wireframe, prototype, mockup, or deck |
| `wireloom` | vendored, MIT | Render a wireframe as inline SVG inside Markdown |

## Agents

| Agent | Role | Model |
|---|---|---|
| `ui-ux-specialist` | Design lead. Grills, builds bottom-up, delegates critique | `@designer` |
| `design-critic` | Read-only visual and UX critique | `@designer` |
| `a11y-auditor` | Read-only WCAG 2.2 AA audit | `@designer` |
| `ui-implementer` | Builds one UI unit on existing tokens and components, verified at three widths. Escalates wider work to `ui-ux-specialist` | `@designer` |

The lead spawns `design-critic` and `a11y-auditor` in one parallel batch. It also spawns
bundled `scout` for recon and `operator` for mechanical steps.

The lead never writes its own critique.

Use `ui-ux-specialist` when the work spans components, needs a system audit, or needs
independent critique.

## Method

Six phases run in order: GROUND, SPECIFY, BUILD, VERIFY, CRITIQUE, RECONCILE.

The lead requests approval at three gates:

- After GROUND, it asks for INTENT.
- When the audit returns ABSENT or PARTIAL, it asks for SYSTEM approval.
- After RECONCILE, it asks for ACCEPT.

`design-surface` and `design-system` each declare all three gates.

Unresolved intent, new scales, and acceptance need explicit approval. Unattended
runs record unanswered questions and remain blocked on those branches.

`grill-system` and `fix-round` are always present and evaluate runtime evidence.
When no decision or further fix is necessary, they record N/A.

`want_design_md` is a pour-time option. Enable it only for requested documentation.
A requested upstream that fails to install requires approval to omit it.

BUILD follows [Component Driven](https://www.componentdriven.org/) methodology,
working from components up to pages:

| Stage | Requirement |
|---|---|
| Build one component at a time | In isolation, with its states defined |
| Combine components | Compose small components, increasing complexity |
| Assemble pages | Use mock data to reach hard-to-produce states |
| Integrate pages | Connect real data and business logic |

Verify components first. Then verify pages. Do not use page-first development.

## Rules

| Rule | Use when |
|---|---|
| `design-token-discipline` | Taking colors and spacing from tokens; a new scale needs approval |
| `design-evidence` | Naming the evidence behind a UI claim |
| `design-no-slop` | Avoiding generated-UI tells |
| `design-component-truth` | Verifying a component prop against documentation |
| `design-upstream-preflight` | Installing and probing the upstream a route needs, before it runs |

## Extensions

`impeccable-detector` runs impeccable's per-edit design detector in OMP. impeccable ships
that check as a Claude Code `PostToolUse` command hook, which OMP does not run. After a
`write`, `edit`, or `ast_edit` lands on a file the hook scans, the extension runs
`impeccable hook` through the installed plugin's launcher and prepends the findings to
the result. A clean file, and a finding already reported this session, stay silent.

It finds the install through OMP's plugin registry and does nothing when impeccable is
not installed. A run that fails, or takes longer than the hook's 5 seconds, leaves the
result unchanged.

impeccable's two other hooks are not reproduced. `SessionStart` only exports a session id
into a Claude Code env file, which OMP does not have. The `Stop` deep pass would force an
extra turn at the end of every session that touched a UI file. Without it,
`impeccable context` asks the agent for one `impeccable detect` run once the changed UI is
finished.

impeccable's `impeccable-asset-producer` agent runs
`${CLAUDE_PLUGIN_ROOT}/skills/impeccable/scripts/impeccable`. OMP substitutes that
variable only in MCP server config, so in the agent's shell the path loses its root. When
that agent starts, the extension adds a hidden note to its context with the launcher's
absolute path.

## Token pipeline

The project's existing token source and builder stay canonical. For a new pipeline the
user approves, layered DTCG under `tokens/**/*.json` is the machine source. DESIGN.md holds
authored intent and a linted projection of that source.
Write the DESIGN.md projection only when requested. Otherwise keep the system
contract and verification evidence on the work beads.

DESIGN.md is not the compiler input. `npx --yes @google/design.md export "$(git rev-parse
--show-toplevel)/DESIGN.md" --format dtcg` resolves aliases, flattens colors to sRGB, and
drops the component, theme, and density tiers.

```bash
npx --yes @google/design.md lint "$(git rev-parse --show-toplevel)/DESIGN.md"
find tokens -type f -name '*.json' -print0 \
  | xargs -0 npx --yes --package=@design-token-kit/cli dtokens check --scope schema
npx --yes --package=@terrazzo/cli tz build
```

Specify the package rather than relying on a bare bin name. `@google/design.md`
provides the `design.md` and `designmd` bins. The last two commands need `--package`:
a bare `dtokens` resolves an unrelated package, and a bare `tz` resolves a package with no bin.
`dtokens` expands no glob, so enumerate the token files and pass each as its own argument.

In a new pipeline, Terrazzo is the single build authority; an existing Style Dictionary
pipeline keeps that role. Do not add a second token builder.
See `skills/design-system-audit/references/token-pipeline.md`.

## Storybook

The Storybook MCP server is opt-in on both harnesses, because it points at
`http://localhost:6006/mcp` and most projects run no Storybook.

On an OMP marketplace install, the package manifest declares it disabled, under the
runtime key `design:storybook`. Enable it in the user file for the active profile:
`~/.omp/agent/mcp.json` for the default profile, or
`~/.omp/profiles/<name>/agent/mcp.json` for a named profile. The loader documentation says
`enabledServers` can force-enable a same-named disabled entry, and accepts `:` in runtime
names:

```json
{
  "enabledServers": ["design:storybook"]
}
```

Or add a separate native server named `storybook`, to `.omp/mcp.json` for one project or
to `~/.omp/agent/mcp.json` for your user. Use one of the two, never both. A linked
checkout (`omp plugin link`) reads the package's `.mcp.json` rather than the manifest, and
that file declares no Storybook server, so a linked install takes this route:

```json
{
  "mcpServers": {
    "storybook": {
      "url": "http://localhost:6006/mcp",
      "enabled": true
    }
  }
}
```

On Claude Code, the package's `.mcp.json` declares no Storybook server, because an entry
there would make every session try `localhost:6006`. Add it for a project that runs
Storybook:

```bash
claude mcp add --transport http storybook http://localhost:6006/mcp
```

Storybook documents ten frameworks:

- Core: React, Vue 3, Angular, and Web Components
- Additional: Ember, HTML, Svelte, Preact, Qwik, and SolidJS

The skills keep a dev server running instead of rebuilding. It recompiles on change
and outlives the turn. Open `http://localhost:6006` to watch the same surface the agent drives.
The served URL appears in every report.

The documented route needs no MCP server:

- `index.json` for the story index
- `manifests/components.json` for the prop table and import statement
- `iframe.html?id=<storyId>` to drive one story
- `npx --yes --package=@storybook/test-runner test-storybook` to execute them

Pass `--package` on that last one. An unrelated `test-storybook` package exists on npm.

Route support differs by framework, measured on Storybook 10.5.10 with
`@storybook/addon-mcp` installed in both a React and a Vue project. `index.json`,
`iframe.html`, and `manifests/docs.json` serve on both.

`manifests/components.json` serves on React and returns 404 on Vue.
`@storybook/react` generates that payload; no Vue framework package does.
Where it is absent, take prop truth from the rendered Autodocs `ArgTypes` block or
the component source. All ten frameworks support the `ArgTypes` block.

A static build is the exception, for a CI job or a one-shot read. `npx --yes storybook build
-o "<dir>"` emits the routes that framework serves, measured on React as all four. Adding
`--test` drops `manifests/docs.json` and the debugger page. A static build cannot add a
route the dev server does not serve for that framework, so Vue still yields no components
manifest.

OMP reads MCP configuration and connects enabled servers at session startup.
After you add the native entry, start a new session. If Storybook was unavailable
at startup, start it. Then run `/mcp reconnect storybook`. OMP also needs that
reconnect when this package starts Storybook after session startup. An agent
cannot run the slash command.

## Formulas

A poured tier carries no `mol-` prefix. `bd mol bond` resolves the prefix, so only
bondable formulas take it.

| Formula | Steps | Gates | Use when |
|---|---|---|---|
| `design-touch` | 8 | 1 | Making a scoped change inside an existing system |
| `design-surface` | 15 | 3 | Building a new surface with full staging |
| `design-system` | 22 | 3 | Establishing or rebuilding a design system |
| `mol-design-iterate` | 6 | 2 | Running another round after an intent change |
| `mol-design-component` | 4 | 0 | Building one primitive to full state coverage |
| `mol-design-tokens` | 5 | 1 | Establishing or migrating a token system |
| `mol-design-a11y` | 4 | 0 | Remediating after a MAJOR accessibility verdict |
| `mol-design-responsive` | 4 | 0 | Running a reflow and target-size pass |
| `mol-design-motion` | 4 | 0 | Running a motion and reduced-motion pass |

Pour a tier. Then bond a sub-process molecule onto the root id the pour prints:

```bash
export BEADS_ACTOR=you
root=$(bd mol pour design-touch --var surface=/settings --var scope=src/settings/ \
  | sed -n 's/.*Root issue: //p')
bd mol bond mol-design-iterate "$root" --var surface=/settings --var node="$root" --var round=2
```

`bd` rejects a mutating command when `BEADS_ACTOR` is unset, and `bd mol bond` takes the
formula name and the target id as two positional arguments.

## First-choice assets

Use the first-choice asset for each topic:

| Topic | First choice |
|---|---|
| Design workflow and anti-slop | `impeccable`; its detector is a coarse signal, not located evidence |
| Design system and tokens | `design-system-audit`, the local carrier inventory; `ss-tokens` generates only after the user approves a new system |
| DESIGN.md artifact | `create-design-md` |
| Accessibility, web | `accessibility` |
| Motion | `motion-design`, measured by `motionlint`; `ss-motion` only for React `motion.X` |
| Microcopy | `ui-microcopy` |
| Wireframing | `html-wireframe`, `wireloom` |
| Clickable prototyping | `html-prototype` |
| Browser-driven verification | `ui-review`, on OMP `browser` |

The detector claims 59 executable rules. A fixture probe with about ten seeded defects recorded:

| Observation | Value |
|---|---|
| Exit code | 2 |
| Findings returned | 4, one an exact duplicate |
| Location on each finding | `"line": 0` |
| File attributed | the HTML file, though two defects lived in the CSS |
| Seeded defects caught | 3 of 10 |

Treat each finding as a coarse signal. Corroborate it by driving the surface.
It is never located evidence or a substitute for driving the surface.

No skill routes to this `impeccable` command:

- `clarify` omits three outputs that `ui-microcopy` provides:
  - an onboarding surface
  - tone-tagged alternatives
  - a tone map

A second asset joins a first choice only when its output stands alone.

| Asset | Output |
|---|---|
| `ss-score` | `deterministic.json` with file and line locations, detector ids, fix text |
| `@axe-core/cli` | Multi-URL CI gate with a process exit; the MCP scanner takes one page |
| `chrome-cdp-ex` | CSS cascade origin: winning and overridden rules, mapped to source line |
| `wireloom` | Markdown-native wireframes as self-contained inline SVG |
| `frontend-slides` | Fixed 16:9 decks with PDF export |
| `web-asset-generator` | Favicon sets, app icons, social images |

## Upstream tools

The design skills route to skills that their upstream authors publish. Installing this
package installs none of them. When a design skill, agent, or formula starts, it applies
`rule://design-upstream-preflight`. That preflight installs only the rows its route
reaches, from the author's own marketplace, and probes each prerequisite:

```bash
omp plugin marketplace add pbakaus/impeccable
omp plugin install impeccable@impeccable
```

| Install address | Upstream repo | Brings |
|---|---|---|
| `impeccable@impeccable` | `pbakaus/impeccable` | `impeccable` |
| `styleseed@styleseed` | `bitjaru/styleseed` | `ss-lint`, `ss-review`, `ss-tokens`, `ss-motion`, `ss-score`, and 18 more |
| `web-quality-skills@addy-web-quality-skills` | `addyosmani/web-quality-skills` | `accessibility`, and 5 more |
| `plannotator-effective-html@effective-html` | `plannotator/effective-html` | `html-wireframe`, `html-prototype`, and 4 more |
| `frontend-slides@frontend-slides` | `zarazhangrui/frontend-slides` | `frontend-slides` |
| `web-asset-generator@web-asset-generator-marketplace` | `alonw0/web-asset-generator` | `web-asset-generator` |
| `superdesign@superdesign` | `superdesigndev/superdesign-skill` | `superdesign`, installed only after the user confirms the account |

Every upstream installs from its author, so a new upstream release needs no catalog change here.

OMP discovers skills at session start. A plugin the preflight installs mid-session is not
reachable through `skill://` until the next session, so the preflight reads its SKILL.md
from the `installPath` that `omp plugin list --json` reports.

Skill granularity is the whole plugin, so an install arrives whole: `styleseed` adds all 23
`ss-*` skill descriptions to every later session, and its tree carries a second copy under
`engine/.claude/skills/`. When two discovered skills share a name, OMP keeps the
higher-precedence copy under the bare name, drops a copy whose body and frontmatter are
identical, and lists a differing copy under a namespaced alias with a collision warning.

| Prerequisite | Entry |
|---|---|
| Node and `npx` | `impeccable detect`, `styleseed` scripts |
| Pillow, through `uv run --with pillow` when absent | `web-asset-generator` |
| `python-pptx`, for PPT conversion only | `frontend-slides` |
| Account, and credits for media | `superdesign` |

## Vendored skills

| Skill | Upstream | License |
|---|---|---|
| `ui-microcopy` | `anthropics/knowledge-work-plugins` guidance | Apache-2.0 |
| `wireloom` | `StardockCorp/Wireloom` | MIT |

Each ships a LICENSE and a NOTICE beside its SKILL.md, and each records its own
modifications.

This package vendors the UX-copy guidance inside `ui-microcopy` because installing its
upstream repository also exposes four Figma-oriented review templates that this package
does not use. It vendors `wireloom` because that upstream ships a bare `.md` file, which
no catalog entry makes discoverable.

| Server | Provides what `browser` cannot |
|---|---|
| `accessibility-scanner` | axe-core WCAG 2.2 engine, contrast over gradients, fix links |
| `wire-dsl` | Wire DSL rendered to SVG, PNG, and PDF |
| `storybook` | Opt-in. Once enabled, and if Storybook ran at session start: seven tools over the CSF index |

## CLI packages these skills invoke

`npx` resolves each package on demand and caches it. None becomes a project dependency;
a first run may reach the network. See `skills/ui-review/references/tools.md` for exact
invocations, the `--package` rule, and required output flags.

| npm package | License |
|---|---|
| `impeccable` | Apache-2.0 |
| `storybook` | MIT |
| `@storybook/test-runner` | MIT |
| `@axe-core/cli` | MPL-2.0 |
| `motionlint` | MIT |
| `lighthouse` | Apache-2.0 |
| `@google/design.md` | Apache-2.0 |
| `@design-token-kit/cli` | Apache-2.0 |
| `@terrazzo/cli` | MIT |
| `browser-driver-manager` | Apache-2.0 |
| `playwright` | Apache-2.0 |
| `@superdesign/cli` | MIT |
| `wireloom` | MIT |

## Assets not included

| Asset | Reason |
|---|---|
| `educlopez/ui-craft` | `impeccable` provides a workflow rather than a review pass. Its detector claims 59 rules; UI Craft claims 43. Neither reports locations: UI Craft's score names none, and impeccable's findings carry `"line": 0` |
| `Owl-Listener/designer-skills` | MIT. Three relevant skills sit in two entries carrying 41 skills, and `git-subdir` cannot narrow that |
| `Wire-DSL/wire-dsl` | No discoverable skill; available as an MCP server |
| `StardockCorp/Wireloom` | No discoverable skill; available as a vendored skill |
| `dominikmartn/nothing-design-skill` | No discoverable skill |
| `ss-a11y`, `ss-copy` | A first-choice asset above covers each topic |
| `fixing-accessibility`, `fixing-motion-performance` | A first-choice asset above covers each topic |
| `baseline-ui`, `improve-ui` | `impeccable` covers both |
| `design-token`, `ux-writing` | `ss-tokens` and `ui-microcopy` cover these |
| five `knowledge-work-plugins` design skills | Figma-oriented review templates; this package uses other assets for these topics |
| `fixing-metadata` | Audits metadata that nothing else covers, but emits no located finding. `web-asset-generator` produces the assets |
| `LE-VAI/designesy-org` | MIT. Its output gives a URL only, with no selector or source line |
| `canvas-design` | `xd://generate_image` already covers its raster output |
| `lighthouse-mcp`, `motionlint mcp` | Each duplicates a CLI above |
| `culori` | Duplicates `colorjs.io` |
| `penpot/penpot-mcp`, Figma Dev Mode MCP | Neither tool is in use here |

Two installation probes returned zero skills: a `git-subdir` entry pointing at one skill
directory, and an entry pointing at a bare `skills/` container.

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

This package vendors no GPL, AGPL, LGPL, or CC-BY-NC content.
