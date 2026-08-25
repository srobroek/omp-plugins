# project-setup

Answer-driven project scaffolding for Oh My Pi. The agent interviews, `project_setup_scan` reports existing repo state, then the agent applies selected modules and tracks each as a beads issue with dependency edges.

## Install

```
omp plugin marketplace add <this-repo>
omp plugin link project-setup
omp plugin doctor
```

## Ported / rewritten / dropped

| Source (APM / Claude) | Status | Notes |
|---|---|---|
| `skills/project-setup/SKILL.md` | rewritten | Interview + module tables intact; `uv run runner/cli.py` replaced by scan tool + skill-driven apply; APM/Claude plugin install → `omp plugin marketplace add` / `link` / `doctor`; checklist tracking → `bd create` per module with `--deps` |
| Bundled modules (`modules/`) | ported | Six core modules copied verbatim |
| Addon catalog (`addons/catalog.json`) + `catalog/modules/` | ported | Templates/module.toml/module.py kept as apply references |
| `examples/` | ported | Under `skills/project-setup/references/` |
| Python runner (`runner/*.py`) | rewritten (scan only) | Deterministic detect half is native TS `project_setup_scan`. Apply/gates/fetch/plan/executor stay skill-driven — not mechanical templating |
| `project_setup_apply` | dropped | Apply is multi-module Python with gates, secret-shape refusal, git fetch, and agent-steered steps; a TS apply tool would be a second runner |
| `mcp-package-version` | dropped | Retired |
| context7 MCP usage | kept | Skill still names context7 for library docs |
| APM install / Claude `/plugin` / Codex marketplace detect | rewritten | Detect OMP marketplace + linked plugins; Claude/Codex registry files are informational only |
| `uv` hard prerequisite | dropped | Runner no longer launched via `uv` |
| Release-please / catalog-publish CI | dropped | Estate orchestrator owns packaging |
| Per-module pytest suite | dropped | Not shipped; TS scan tests replace detect coverage |

## Skills

| Name | When |
|------|------|
| `project-setup` | Start, scaffold, or re-run setup for a new or drifted repository |

## Tools

- `project_setup_scan` — read-only detect of git, license, CI, gitignore, package manager, existing modules, setup mode
