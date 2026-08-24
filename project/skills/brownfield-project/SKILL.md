---
name: brownfield-project
description: Retrofit an existing repository into APM-managed agentic tooling. Use when onboarding or repairing a brownfield repo that needs agents, skills, or hooks added.
---

# Brownfield Project

Use when an existing repository needs OMP plugins, skills, agents, rules,
steering, or setup repair. Ingest the repo as it is; do not turn it into a new
project scaffold.

## Scope

- Owns: brownfield classification, source-of-truth preservation, and retrofit plan.
- Delegates package/drift review to the optional `audit-steering` skill; perform
  the bounded review inline when it is unavailable.
- Delegates all plugin, agent, skill, hook, MCP, connector, CLI, and reusable
  tool selection to the optional `find-tools` skill; perform the capability
  discovery inline when it is unavailable.
- Delegates concrete plugin add/update/remove operations to the optional
  `agent-management` skill; run the documented OMP plugin commands directly when
  it is unavailable.
- Uses the optional `grilling` skill when repo evidence is not enough to
  understand the project's purpose, requirements, constraints, or desired
  agentic workflow; ask the questions inline when that skill is unavailable.

## Workflow

1. Inspect before changing anything:
   - `git status --short`
   - marketplace / plugin install state (`omp plugin doctor`)
   - `AGENTS.md`
   - discovered rules, skills, and agents on disk
   - root and scoped `AGENTS.md` files
   - package manifests, lockfiles, toolchain files, CI, docs, specs, ADRs
2. Discover the project before selecting tools. Infer purpose from README/docs,
   specs, manifests, source layout, tests, examples, CI, and deploy config.
   Identify users, workflows, critical data, external services, runtime targets,
   release path, and safety/security concerns. Separate current reality from
   aspiration, and record evidence plus confidence.
3. If purpose or requirements remain unclear, use `grilling` when it is
   installed; otherwise ask the questions inline before recommending plugins.
   Ask one question at a time with a recommended answer. Start with the
   highest-impact unknown blocking tool selection. Prefer repo exploration over
   asking when the answer is discoverable from README/docs/specs/CI. Stop once
   project goal, users, workflow, write boundaries, and quality gates are clear;
   go deeper only when the answer changes which tooling or steering gets
   installed.
4. Classify existing agentic assets:
   - source-owned: marketplace-linked plugins and their on-disk sources
   - generated: compiled context or runtime copies
   - legacy/manual: copied agents, copied skills, leftover `CLAUDE.md`, old hooks
   - bootstrap-only: global setup helpers that should not be project-managed
5. Identify existing source-of-truth docs and conventions. Preserve them; route
   into plugin rules or scoped `AGENTS.md` only when that clarifies ownership.
6. Resolve OMP plugin tooling: `omp plugin marketplace add` for marketplace
   repos, `omp plugin link` for local extension packages. Use `omp plugin doctor`
   as the health check. Stop and report if `omp` is missing.
7. Build a capability brief and delegate plugin/tool selection to `find-tools`
   when it is installed; otherwise perform the same bounded discovery inline.
   Include:
   - discovered purpose, requirements, users, workflows, and open questions
   - project type, languages, frameworks, package managers, CI, deploy target
   - current OMP plugin state, registered marketplaces, and installed assets
   - existing agentic assets classified as source-owned, generated, legacy/manual, or bootstrap-only
   - needed capabilities: plugins, agents, skills, rules, MCP servers, connectors, CLIs, steering, workflow tools, and quality gates
   - constraints: local vs hosted, secrets, network, write access, security posture
   Require `find-tools` to start with the primary marketplace baseline
   (unless the capability brief identifies a narrower scope).
8. Run or apply `audit-steering` when it is installed; otherwise inspect for
   stale assets, missing plugins, duplicate skills, generated-file edits, and
   bootstrap leakage directly.
9. Ask before removing legacy/manual assets. Archive only files that contain
   useful project knowledge; remove generated copies only after confirming OMP
   can recreate them.
10. Use `agent-management` when it is installed for approved plugin installs,
    linking, and audit commands; otherwise run those documented OMP commands
    directly.
11. Report changed files, installed assets, archived/removed assets, skipped
    checks, and remaining manual decisions.

## Rules

MUST No broad scaffold unless the user explicitly asks for one.
MUST Do not treat plugin selection as the first step -- understand purpose and requirements first.
MUST Never edit generated runtime copies directly during retrofit.
MUST Ask only for requirements absent from README/docs/specs/CI where the answer changes which tooling or steering gets installed.
DEFAULT Use the configured marketplace as the first-pass source for brownfield migrations, but let `find-tools` own marketplace registration, browsing, and adopt/trial/reject classification.
- Keep discovery bounded -- enough shared understanding for retrofit choices, not a full product specification unless the user asks.
- Preserve existing package managers, CI, build commands, docs, and issue workflow unless the user chooses a migration.
- Treat project-local generated assets as plugin-owned.
- Do not select plugins directly except for baseline repair. Use `find-tools` for reusable tool recommendations.

## Output

Lead with:

1. Discovered project purpose, requirements, confidence, and open questions
2. Existing state and risks
3. Source-of-truth map
4. Legacy/manual assets to keep, archive, or remove
5. Recommended OMP plugin actions or delegated follow-up
6. Verification commands and skipped checks
