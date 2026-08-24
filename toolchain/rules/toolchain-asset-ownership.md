---
name: toolchain-asset-ownership
description: When adding or changing agentic assets — where OMP config, plugins, and discovery live.
---

# Agentic asset ownership

- chezmoi owns machine config under `~/.omp/agent/` (`config.yml` via a `modify_`
  script, rules, extensions).
- The `srobroek-omp` marketplace owns installable plugins (skills, agents, rules).
- OMP discovers capabilities from disk. There is no compile step.
- Use `skill://chezmoi-editor` for chezmoi-managed source edits.
