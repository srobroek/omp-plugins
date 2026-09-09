---
name: agentic-scaffold
description: Use when creating or retrofitting a repository with deterministic layers, project-local OMP plugins, context tooling, instructions, and hooks.
---

# Agentic scaffold

TRIGGER
+ scaffold a repository or agentic-only project
+ retrofit project-local instructions, hooks, context, or OMP plugins
+ update a rendered scaffold or diagnose scaffold drift
- implement product code or choose a framework
- change the global OMP plugin set

## Workflow

| Phase | LOAD | CLI command |
|---|---|---|
| Inspect | `references/interview.md` | `scaffold.py inspect --root R` |
| Layers | `references/layers.md` | `scaffold.py layers list|show L` |
| Profile | `references/profiles-and-combinations.md` | `scaffold.py profiles list` |
| Plan | `references/conflicts.md` | `scaffold.py plan --root R --profile P` |
| Render | `references/render-and-update.md` | `scaffold.py render --root R --profile P` |
| Plugins | `references/plugins.md` | `scaffold.py plugins sync --root R` |
| Verify | `references/verify.md` | `scaffold.py doctor --root R` |

1. Inspect first; in brownfield work, resolve every finding before rendering.
2. Ask only the fixed interview questions that cannot be derived. Record answers with `answers write`.
3. In a beads repository, pour the matching molecule before implementation; never initialize beads implicitly.
4. Show the JSON plan. Stop on exit 5 until the user chooses a documented resolution.
5. Render, then run tools/hooks/plugins commands only when authorized.
6. Run `doctor`; exit 2 means drift and exit 1 means an operational error.

## Rules

MUST Keep `SKILL.md` as routing only; procedure lives in the phase references.
MUST Treat `.omp/scaffold-answers.toml` as committed desired input and `--var` as a one-run override.
MUST Never overwrite user-owned files; use managed markers, `--adopt`, or an explicit layer winner.
MUST Keep `.omp/plugins.toml` as desired state and project installs under `.omp/plugins/`; never mutate user scope.
MUST Preserve existing JSON keys and TOML `[tools]` keys during merges.
MUST Refresh context after commits, checkouts, and merges.
MUST Never initialize Git, beads, a product framework, or a provider implicitly.
