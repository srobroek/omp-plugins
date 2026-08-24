---
name: toolchain-stack-defaults
description: When choosing or changing a project stack, package manager, task runner, or adding a dependency.
---

# Toolchain Stack Defaults

Keep existing project choices unless the current task is explicitly about setup,
migration, or standardization.

Prefer pnpm over npm/yarn, uv over pip/poetry, mise over nvm/pyenv, just/task
over make.

Dependencies: add via the package manager CLI (not manifest edits), defaulting
to the latest compatible version.

Treat `just`, `mise`, and `moon` as independent setup choices:

- `just` for task aliases and repeatable local workflows.
- `mise` for language and tool version management.
- `moon` for task orchestration in larger monorepos.

Language-specific structural conventions ship with each language plugin;
language failure modes and CI specifics ship in the language plugin's
steering rules when installed.
