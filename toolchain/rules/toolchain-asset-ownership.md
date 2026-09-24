---
name: toolchain-asset-ownership
description: When adding or changing agentic assets — where OMP config, plugins, and discovery live.
---

# Agentic asset ownership

Keep these ownership boundaries when changing agentic assets; machine-specific guidance in `AGENTS.md` may add local paths:

- chezmoi owns machine-wide OMP config, rules, and extensions under `~/.omp/agent/`; use `skill://chezmoi-editor` for their source.
- The `srobroek-omp` marketplace owns installable plugins (skills, agents, and rules).
- OMP discovers capabilities from disk; no compile step is required.
