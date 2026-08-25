---
name: toolchain-stack-defaults
description: When choosing or changing a project stack, package manager, task runner, or adding a dependency.
---

# Toolchain Stack Defaults

Keep existing project choices unless the current task is explicitly about setup,
migration, or standardization.

New projects: bun over npm/yarn, uv over pip/poetry, mise over nvm/pyenv, just
over make. Reaching for a legacy tool in a tree already configured for the
modern one is enforced by `prefer-tools-advisory`.

Dependencies: enforced by `dep-manifest-advisory`.

Treat `just`, `mise`, and `moon` as independent setup choices:

- `just` for task aliases and repeatable local workflows.
- `mise` for language and tool version management.
- `moon` for task orchestration in larger monorepos.

Language-specific structural conventions ship with each language plugin;
language failure modes and CI specifics ship in the language plugin's
steering rules when installed.
