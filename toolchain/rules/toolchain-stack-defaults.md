---
name: toolchain-stack-defaults
description: When choosing or changing a project stack, package manager, task runner, or adding a dependency.
---

# Toolchain Stack Defaults

Keep existing project choices unless the current task is explicitly about setup,
migration, or standardization.

New projects: bun over npm/yarn, uv over pip/poetry, mise over nvm/pyenv, just
over make. Reaching for a legacy tool in a tree already configured for the
modern one gets an advisory from `prefer-tools-advisory`.

Dependencies: add, remove, and upgrade them through the package manager's CLI
(`bun add`, `uv add`, `cargo add`, `go get`), not by hand-editing the manifest.
A hand edit to a dependency table gets an advisory from `dep-manifest-advisory`.

Treat `just`, `mise`, and `moon` as independent setup choices:

- `just` for task aliases and repeatable local workflows.
- `mise` for language and tool version management.
- `moon` for task orchestration in larger monorepos.

Language-specific conventions ship with the `go`, `python`, `rust`, and
`typescript` plugins when installed: each has a quality skill, and the Rust and
TypeScript plugins add steering rules.
