---
name: omp-plugin-authoring
description: Use when creating, packaging, installing, or debugging an OMP plugin (skills, rules, agents, extensions) or a marketplace.
---

# OMP Plugin Authoring

TRIGGER
+ creating or packaging an OMP plugin / marketplace
+ install loaded no surface, or `omp plugin doctor` says "not an omp plugin"
+ `omp plugin doctor` / `rule://` / upgrade-all looks wrong
- writing a TTSR vs tool vs skill decision → `skill://omp-surface-choice`
- writing a tool_call/extension module → `skill://omp-extension-safety`

## Install carrier

Two lanes discover surfaces. npm installs and `omp plugin link` share the first lane: OMP recognizes the package by its manifest, loads the manifest entry points, then scans the package tree. Marketplace installs use the second lane, discovered from the installed-plugin registry and its `installPath`. OMP filters marketplace roots out of the first lane, so a marketplace plugin exposes tree surfaces without a manifest.

| Surface | Loaded from | Manifest key |
|---|---|---|
| skills, rules | `skills/`, `rules/` | none, tree convention |
| commands | `commands/` as the fallback | optional `omp.commands` path, which overrides it |
| task agents | `agents/*.md` | none, tree convention |
| tools, hooks, extensions, features, settings | paths named in the manifest | `package.json` `omp` |

MUST Give an npm or linked package a non-null `package.json` `omp` (legacy `pi`) object. Without it OMP skips the package, `omp plugin link` loads **nothing**, and `omp plugin doctor` reports "not an omp plugin".
DEFAULT A marketplace install needs no manifest key to expose `skills/`, `rules/` or `agents/*.md`. Its registry entry carries the root.
NOT Treating `omp` as a bare marker. It carries tools, hooks, extensions, commands, features and settings. No `skills`, `rules` or `agents` key exists, so those surfaces stay in the tree.

A marketplace install copies its source to `cache/plugins/MKT___NAME___VERSION`, then symlinks that directory into the scope's `node_modules`. `omp plugin list` therefore prints one install twice, once under **npm Plugins** and once under **Marketplace Plugins**. One physical copy backs both rows, and they carry the same version.

Catalog entries declare no extensions. Those load from the installed package's own `package.json` `omp.extensions`. Runtime discovery ignores catalog `agents`, `commands`, `hooks` and `mcpServers`, and rejects `source: npm` outright: "npm plugin sources are not yet supported".

## Verify

1. `omp plugin doctor`: every plugin MUST be ✔.
2. Prove a rule is addressable: `omp -p 'read rule://<name>'`.
3. A rule with no `description`, no `alwaysApply`, no accepted `condition`/`astCondition` lands in **no bucket**. Discovered, silently unaddressable, never an error (`omp://rulebook-matching-pipeline.md` §5-§8).

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
NOT Bodies that bake host paths; they die on any other machine.

## Catalog and release

DEFAULT Catalog at `.omp-plugin/marketplace.json`; `.claude-plugin/` is the Claude fallback (`omp://marketplace.md`).
MUST Every catalog entry that should upgrade declares `version`. No `version` → invisible to upgrade-all.
MUST Publish the catalog from a supported source: a local path, a GitHub shorthand, a git URL, or a direct catalog URL. `marketplace.autoUpdate` (`off` / `notify` / `auto`) and upgrade-all resolve it from there, never from npm. OMP has no subscription mechanism, so an npm registry publication reaches no install path.
MUST release-please `extra-files` paths are **package-relative**. A repo-root path silently doubles the prefix.
