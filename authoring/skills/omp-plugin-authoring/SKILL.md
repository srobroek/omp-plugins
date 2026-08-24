---
name: omp-plugin-authoring
description: Use when creating, packaging, installing, or debugging an OMP plugin (skills, rules, agents, extensions) or a marketplace.
---

# OMP Plugin Authoring

TRIGGER
+ creating or packaging an OMP plugin / marketplace
+ install loaded the wrong surface (skills only, or nothing)
+ `omp plugin doctor` / `rule://` / upgrade-all looks wrong
- writing a TTSR vs tool vs skill decision → `skill://omp-surface-choice`
- writing a tool_call/extension module → `skill://omp-extension-safety`

## Install carrier (silent)

The install path decides what loads. Nothing errors when a surface is skipped.

| Carrier | What loads |
|---|---|
| `omp plugin install x@mkt` | **Skills only.** Rules and agents do not load. |
| `omp plugin link <dir>` without `package.json` `omp` key | **Nothing.** `omp plugin doctor`: "not an omp plugin". |
| `omp plugin link <dir>` with `omp` key (empty `{}` is enough) | Rules, agents, and skills. `omp` is a **marker**, not a payload. |

Marketplace installs also load `package.json` `omp.extensions` (see `omp://marketplace.md`).

## Verify

1. `omp plugin doctor` — every plugin MUST be ✔.
2. Prove a rule is addressable: `omp -p 'read rule://<name>'`.
3. A rule with no `description`, no `alwaysApply`, no accepted `condition`/`astCondition` lands in **no bucket**. Discovered, silently unaddressable, never an error (`omp://rulebook-matching-pipeline.md` §5–§8).

## Rule identity

MUST Filename stem is the identity for `native` / `omp-plugins` providers.
MUST Frontmatter `name` equals that stem.
MUST Capability dedup is **bare-name first-wins** across every source.
MUST Prefix plugin rule filenames (`authoring-foo`, not `foo`).
NOT Re-ship a bundled agent name: `scout`, `librarian`, `reviewer`, `security-reviewer`, `designer`, `task`, `sonic`.

## Frontmatter and indexes

MUST Arrays are single-line flow YAML (`globs: ["**/*.ts"]`). Fallback parser cannot rebuild multiline arrays (`omp://rulebook-matching-pipeline.md` §3).
NOT Ship an always-apply index listing the plugin's rules. OMP already renders every rulebook rule as `- name (globs): description` in `<domain-rules>`. An index doubles it.

## Skills layout

MUST Discover only `<root>/<name>/SKILL.md`. No deeper nesting.
DEFAULT `plugin.json` `skills` arrays remap when the default tree is wrong.
MUST Bodies cite assets as `skill://<name>/<path>`. Never absolute paths.
NOT APM-compiled bodies that bake host paths — they die on any other machine.

## Catalog and release

DEFAULT Catalog at `.omp-plugin/marketplace.json`; `.claude-plugin/` is the Claude fallback (`omp://marketplace.md`).
MUST Every catalog entry that should upgrade declares `version`. No `version` → invisible to upgrade-all.
MUST release-please `extra-files` paths are **package-relative**. A repo-root path silently doubles the prefix.
