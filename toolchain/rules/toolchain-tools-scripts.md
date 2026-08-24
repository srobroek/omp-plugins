---
name: toolchain-tools-scripts
description: When adding or editing repo automation, scripts/, tools/, justfiles, mise, or moon.
globs: ["scripts/**", "tools/**", "justfile", "Justfile", "Taskfile.yml", "Makefile", "mise.toml", ".moon/**"]
---

# Tools And Scripts

Use `scripts/` for thin repo automation. Scripts should be direct, inspectable,
and easy for agents to run.

Use `tools/` for maintained CLIs, generators, MCP server implementations, and
reusable developer tooling.

Task-runner defaults (`just`, `mise`, `moon`): see `rule://toolchain-stack-defaults`.

Keep generated outputs and caches out of source unless the project explicitly
tracks them.
