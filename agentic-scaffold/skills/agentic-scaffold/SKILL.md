---
name: agentic-scaffold
description: Use when scaffolding or retrofitting a repository with deterministic template layers, project-local OMP plugins, agent instructions, context tooling, and hooks.
---

# Agentic scaffold

TRIGGER
+ scaffold a new repository or agentic repository
+ retrofit project-local instructions, context, hooks, or OMP plugins
+ update a rendered scaffold or synchronize its desired plugin set
- implement application code or choose a framework
- change the global OMP plugin set

## Workflow

| Situation | Route |
|---|---|
| New repository | Read `skill://agentic-scaffold/references/greenfield.md` |
| Existing repository | Read `skill://agentic-scaffold/references/brownfield.md` |
| Re-render or change profile | Read `skill://agentic-scaffold/references/layout.md` and `tooling.md` |
| Desired project plugins | Read `skill://agentic-scaffold/references/plugins.md` |

1. Run `python3 skills/agentic-scaffold/scripts/scaffold.py inspect --root <root>`.
2. Pick an explicit profile; ask only when stack detection is ambiguous.
3. In a beads repository, pour the matching molecule before implementation. Do not initialize beads implicitly.
4. Run `python3 skills/agentic-scaffold/scripts/scaffold.py plan --root <root> --profile <profile> --name <name>` and review every row.
5. Run `... scaffold.py render ...`, then `tools install --yes`, `hooks install`, and `plugins sync` as authorized.
6. Verify with `just check`, `omp plugin list --json` (project scope), and a fresh-session probe: `omp -p --no-session --model smol "Which project-local agentic-scaffold skill is available?"`.

## Rules

MUST Never overwrite user files; only managed marker blocks may be updated.
MUST Keep `.omp/plugins.toml` as the desired-state source and project installs under `.omp/plugins/`.
MUST Never mutate the global plugin set from this skill.
MUST Show the plan and stop on conflicts (exit 5).
MUST Refresh Graphify and Repomix context after commits, checkouts, and merges.
NOT Initialize Git, beads, a product framework, or a provider implicitly.
