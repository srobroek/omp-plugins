---
name: journey-init
description: "Use when setting up a user-journeys directory for a repo that has none: investigates, interviews, and scaffolds the format spec."
---

# journey-init

Provision a journeys directory per the user-journeys format. Three phases, in
order: investigate, interview, scaffold. Never skip the interview -- detected
facts are proposals, the user decides.

Templates and the helper script live in this skill's directory:
`skill://journey-init/templates/FORMAT.md`, `skill://journey-init/templates/README.template.md`,
`skill://journey-init/templates/journey.template.md`, `skill://journey-init/templates/run.template.md`,
`skill://journey-init/scripts/journeys.py`.

## Phase 1 -- Investigate the repo

Gather evidence before asking anything. Cheap checks first; delegate to a
search subagent only if the repo is large and unfamiliar.

1. **Existing journeys:** any directory already containing `FORMAT.md` +
   `*/journey.md`? If found and healthy, stop -- offer `journey-write` or
   re-configuration of README.md instead of re-init.
2. **Product shape** (drives interface-profile proposals):
   - web: `package.json` with vite/next/astro/remix; a dev-server script.
   - desktop: `tauri.conf.json`, electron deps, native app manifests.
   - CLI/TUI: bin-only manifests, clap/argparse/cobra/bubbletea deps.
   - API/service: OpenAPI files, route frameworks, Dockerfiles exposing ports.
   A repo can be several of these -- propose one profile per shape.
3. **Available drivers:** Playwright/WDIO configs, MCP servers in
   `.mcp.json`/`.claude/settings.json` (browser or app-driving servers),
   e2e harnesses, `just`/`make`/npm scripts for dev/launch/reset. Note
   concrete launch and reset commands -- these seed profile `notes`.
4. **Tracker reality:** is this a GitHub repo with `gh` authenticated
   (`gh auth status`)? GitLab? No forge? This seeds the reporter proposal.
5. **Intent-evidence sources:** CHANGELOG, specs/ADRs/PRD dirs, release
   notes, PR conventions -- where merged intent is recorded in this repo.
6. **Docs layout:** where documentation lives (`docs/`, `doc/`, wiki-less?)
   to propose the journeys location. Default `docs/journeys/`.
7. **Journey-like docs worth migrating:** manual test scripts, E2E journey
   catalogs, validation trackers, user-flow docs. List candidates; do not
   migrate anything in this skill.

## Phase 2 -- Interview the user

Ask with AskUserQuestion, presenting detected facts as defaults. Cover, in
one or two rounds:

1. **Location** of the journeys directory (default from investigation).
2. **Reporter:** github-issues / local / none -- recommend what phase-1
   found usable; mention extra labels if the repo uses a label taxonomy.
3. **Interface profiles:** confirm each proposed profile (kind, launch/reset
   commands, driver preference, doc pointers), ask for what investigation
   could not see (staging URLs, credentials handling, environments that must
   never be touched), and whether a profile is `exclusive` (single-instance
   apps: one validator at a time).
4. **Fix loop default:** report-only / dispatch-coder / fix-direct, and max
   iterations (default dispatch-coder, 3).
5. **Retention:** how many validation runs to keep per journey
   (`runs_keep`, default 20) -- and say plainly that pruning happens only at
   consolidation checkpoints, never automatically.
6. **Migration:** if phase 1 found journey-like docs, migrate now (via
   journey-write, one pilot first), later, or never.

Ask only what investigation could not establish or the user must decide; do
not re-ask what the repo already answers. If no interactive question
channel exists (headless run, subagent context), treat owner-provided
preferences from the invocation as the interview answers; anything they do
not cover is an open question in your report -- never guess it.

## Phase 3 -- Scaffold

1. Create the journeys directory. Copy `skill://journey-init/templates/FORMAT.md` verbatim AND
   `skill://journey-init/scripts/journeys.py` into it -- the
   helper travels with the repo so every future skill and validator invokes
   `<journeys-dir>/journeys.py`, never a path inside an installed skill.
2. Write `README.md` from `skill://journey-init/templates/README.template.md` with frontmatter
   and all sections filled from phases 1 to 2 -- real launch commands, real doc
   pointers, real intent-evidence locations. Delete placeholder text.
3. Generate the index:
   `python3 <journeys-dir>/journeys.py index <journeys-dir>`.
4. If reporter is `local`, create `TRACKER.md` with a `# Journey findings`
   heading and nothing else.
5. Report what was created and, if migration was chosen, hand off to
   `journey-write` with the migration candidates listed.

## Rules

- Detected facts are proposals; the user's answers win.
- Never write into the journeys directory of another repo layout convention
  (monorepos: ask which app the journeys belong to; one journeys dir per
  product, not per package).
- The scaffold must be immediately lintable:
  `python3 <journeys-dir>/journeys.py lint <journeys-dir>` exits 0 on a fresh
  scaffold (no journeys yet).
