---
name: project-setup
description: 'Set up, scaffold, bootstrap, spin up, stand up, or initialize a NEW project or repository — for any language or framework (Python, FastAPI, TypeScript, Go, Rust, etc.). Use whenever the user wants to start/create/spin up/stand up/build/make/"get going" a new project, service, API, app, or repo — e.g. "set up a project", "start a new project", "spin up a FastAPI service", "create a new <language/framework> app", "scaffold a repo", "initialize a repo", "make a new project" — or adds a monorepo package, or re-runs setup to fix drift. A generic, config-driven runner that SCAFFOLDS (it does not deploy or release): every capability (git, GitHub, dirs, pre-commit, license, gitignore, CI, README, env, OMP plugins, MCP, SpecKit, language overlays) is a discoverable module.'
---

# Project Setup (scan + modules + beads)

This skill is a **generic scaffolder**. It carries no project-specific configuration.
Every capability is a self-contained **module** you discover, order, and apply.
Read this whole file before running it.

**Module distribution.** Core modules live at `skill://project-setup/modules/<id>/`.
Addon modules live at `skill://project-setup/catalog/modules/<id>/` and are listed
in `skill://project-setup/addons/catalog.json`. Authoring notes:
`skill://project-setup/references/AUTHORING.md`.

There is **no Python runner**. Detect existing repo state with the native tool
`project_setup_scan`. Apply is **skill-driven**: you write files from the selected
module templates after the interview. Track work as **one bead per selected
module** with dependency edges.

## How to run it end-to-end

1. **Scan first.** Call `project_setup_scan` on the target directory. It reports
   `mode` (`init` vs `reproduce`), git, license, CI, `.gitignore`, package
   managers, languages, `.project-setup` answers/enabled modules, and OMP plugin
   hints. Do not invent this inventory.
2. **Phase 1 — interview.** Collect every answer yourself (module selection +
   every module's `[[inputs]]`). The scan tool never prompts. One question at a
   time (RULES below).
3. **Beads DAG.** After the user confirms the enablement set, create **one bead
   per selected module** (plus one parent epic if useful):

   ```
   bd create --title "setup: <module-id>" --type task --deps <parent-or-prereq>
   ```

   Wire `requires`/`after` from each module's `module.toml` `[order]` as `--deps`
   edges. Close a bead only after that module's files are on disk.
4. **Phase 2 — apply.** For each module in topological order (respect `--deps`):
   read `skill://project-setup/modules/<id>/module.toml` (or catalog path) and
   apply templates under that module's `templates/` using the frozen answers.
   Record answers in `.project-setup/answers.toml` and sources in
   `.project-setup/sources.toml` so a later scan reports `mode: reproduce`.
5. **Do not** spawn `uv run …/runner/cli.py`. That runner is retired in this
   plugin. Do not add a second apply tool unless templating is purely mechanical
   for a single file you already have in hand.

## OMP surface (not APM / Claude Code)

- Install this plugin: `omp plugin marketplace add <repo>` then
  `omp plugin link project-setup`. Verify with `omp plugin doctor`.
- Capability carriers are **OMP plugins** (skills, rules, extensions), not APM
  packages and not Claude `/plugin` marketplace entries.
- MCP: keep **context7** for library docs. Never mention or install
  `mcp-package-version` (retired).
- Detect marketplaces from scan + `~/.omp/` / project `.omp-plugin/` — do not
  assume APM `~/.apm/marketplaces.json` is authoritative.

## Modes

- **Init** (`project_setup_scan.mode === "init"`): no `.project-setup/sources.toml`.
  Interview, write sources + answers, apply modules.
- **Reproduce** (`sources.toml` present): load committed answers; do **not**
  re-propose modules; apply only drift. Confirm overwrites.

## Tiers

Each module step in `module.toml` has a `kind`:

- **`python` / template write**: deterministic. Same answers + same module
  version → same files. Follow the module's templates; never freehand a LICENSE
  or gitignore the module already ships.
- **`agent`**: follow `steering/` in that module; record the decision in answers.
- **`gate`**: confirm with the user (or honor `allow` / `skip` lists in answers).
  Hard gates default skip unless the matching allow flag is present.

## The bundled module set

Always-on core (`skill://project-setup/modules/`):

- core-identity, dirs-scaffold, gitignore-generate, license-write, agents-md, git-init.

Addon (opt in, `skill://project-setup/catalog/modules/`):

- apm-install, ci-github-actions, codex-config, env-example, github-repo,
  justfile-write, lang-go, lang-python, lang-rust, lang-ts, mcp-config,
  org-policy, package-add, precommit-setup, quality-hooks, readme-draft,
  speckit-bridge, stack-adr, worktreeinclude-write.

Treat `apm-install` as **OMP plugin install** when selected: `omp plugin
marketplace add` / `omp plugin link`, not `apm install`. Treat `codex-config`
as optional legacy; prefer OMP config.

## Scope: this skill SCAFFOLDS — it does NOT build the product

**In scope:** directory structure, `.gitignore`, `LICENSE`, `AGENTS.md`,
pre-commit config, `justfile`, CI workflow YAML, `.env.example`, `STACK.md`,
a pinned dependency manifest + toolchain, a README *draft*, frozen answers,
beads for the selected modules.

**Out of scope:** application source, business logic, ORM models, handlers,
schemas, hand-written migrations, product test suites.

When modules have run, **STOP** and print a handoff: what was scaffolded and
the user's next steps. Do not start writing the app.

## How to ask the user

**RULE 1 — ONE question at a time.**

**RULE 2 — A menu/choice prompt is fine.** Recommend a default and label it.

**RULE 3 — ALWAYS include an "another option" / "other" escape.**

**RULE 4 — NUMBERED TABLES, grouped:** Mandatory / Recommended / Optional /
Not applicable. Continuous numbering across selectable groups.

```
Mandatory (always run)
| name | what it does |
| core-identity, dirs-scaffold, gitignore-generate, license-write, agents-md, git-init | base scaffold |

Recommended for a FastAPI service
| # | module | why |
| 1 | lang-python      | Python overlay: pins 3.13, uv + pyproject.toml |
| 2 | precommit-setup  | ruff lint/format enforced on commit |
| 3 | justfile-write   | run/test/lint task shortcuts |

Optional (available)
| #  | module | what it does |
| 4  | quality-hooks    | extra agent quality hooks |
| 5  | github-repo      | create + push a GitHub repo |
| 6  | mcp-config       | configure MCP servers (keep context7) |
| 7  | speckit-bridge   | SpecKit spec-driven workflow |
| 8  | env-example      | .env.example from the stack |
| 9  | stack-adr        | STACK.md decision record |
| 10 | ci-github-actions| CI workflow sized to the stack |

Not applicable here
| module | reason |
| lang-ts / lang-go / lang-rust | project is Python |

→ Enable the recommended set (1–3)? Or reply with numbers to add/remove, or "other".
```

**RULE 5 — ALWAYS read a choice's options from that module's `module.toml`
`[[inputs]]` before presenting it.** Never from memory. License choices are the
13 files under `skill://project-setup/modules/license-write/templates/licenses/`.

**RULE 5b — large catalogues:** state the real total, show a curated subset,
never claim the subset is the full list.

**RULE 6 — prefix every question with the module id.**

## Module selection (FR-005)

1. Grill intent (language, CI, GitHub, SpecKit, OMP plugins).
2. Use `project_setup_scan` plus offline OMP/plugin files. Present detected
   marketplaces; never push a specific org. If none, offer public SpecKit via
   `uvx` and MCP via `npx` (`mcp-config`), or skip package installs.
3. Offer catalog addons from `skill://project-setup/addons/catalog.json` in the
   same numbered tables, marked `(catalog: <name>)`. Selected addons need a
   pinned `ref` in `.project-setup/sources.toml`.
4. Default installable packages to `latest`; offer pin override. Keep context7.
   Strip any `mcp-package-version` mention.
5. Confirm the enablement set, then create beads + apply.

**Reproduce:** committed enablement is authoritative — do not re-propose.

## Secrets

NEVER accept a secret as an input (`ghp_`, `sk-`, `AKIA`/`ASIA`, `glpat-`,
`xox[baprs]-`, PEM keys). Tell the user to rotate if they pasted one.

## Safe execution

If a module apply fails, STOP. Report the module and ask. Do not hand-edit
around a failure or invent a substitute implementation.

## What "done" means

- Scan was run; mode understood.
- Every selected module has a bead; deps match `module.toml` `[order]`.
- Enabled modules applied (or confirmed-skipped); failures surfaced.
- `.project-setup/sources.toml` and `.project-setup/answers.toml` written.
- You STOP and hand off.

## Extra inputs worth supplying

| module | input key | what it does |
|---|---|---|
| `agents-md` | `description` | Fills AGENTS.md PROJECT DESCRIPTION |
| `justfile-write` | `language` | Idiomatic recipes (`python`, `go`, `rust`, `ts`) |
| `git-init` | `initial_commit` | Initial scaffold commit (opt-in) |
