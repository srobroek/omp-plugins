---
name: setup-tools
description: Sets up project-local OMP plugins, skills, and MCP servers from approved sources. Use when setting up project agent tooling or installing a plugin or marketplace.
---

# Setup Tools

Installs the agent tooling a project needs, scoped to that project. Discovery and vetting of
unknown tools stay with `skill://find-tools`; this skill turns a chosen list into installs.

TRIGGER
+ "set up tooling for this project", "which plugins should this repo have"
+ installing a named plugin, skill, or MCP server
+ adding a third-party marketplace
- judging whether an unknown tool is worth adopting -> `find-tools`
- a design skill's own upstreams -> `rule://design-upstream-preflight`

GATES
ASK Before any install, with the full candidate table and a multi-select of rows.
ASK Before registering a marketplace outside `skill://setup-tools/references/approved-sources.md`.
ASK Before running `npx skills` or `smithery`: each executes downloaded package code.
ASK Before any user-wide install. Project scope is the default.

## Workflow

1. Take inventory. -> `omp plugin list --json` (each `.marketplace[]` row carries `scope`),
   `omp plugin marketplace list`, and the project's `.omp/mcp.json`, `.omp/skills/`, and
   `.agents/skills/`. Everything already present is marked `installed`, never re-proposed.
2. Profile the project from its files. -> LOAD
   `skill://setup-tools/references/project-signals.md`; every capability is named with the
   marker file that proved it. No marker, no capability.
3. Search tier 1, this repository's own catalog. -> `omp plugin marketplace update srobroek-omp`,
   then `omp plugin discover srobroek-omp`; match each capability to an entry.
4. Search tier 2, the approved third-party marketplaces. -> register any missing one with
   `omp plugin marketplace add OWNER/REPO`, then `omp plugin discover NAME`. Registration is
   user-wide: it adds a catalog, never a plugin.
5. Search tier 3 only when the user asks to widen, or when a capability has no tier 1 or 2
   match. -> call `find_tools_scan` first; it is read-only. Then, after the ASK gate, the
   CLIs in the tier 3 table of `approved-sources.md`. Vet every hit with
   `skill://find-tools/references/adoption-policy.md` before it enters the table.
6. Present one table of every relevant package. -> the OUTPUT table below, then ASK.
7. Install each approved row by kind, project-local. -> the Install table below.
8. Verify each install. -> `omp plugin list --json` shows the plugin with `"scope":"project"`;
   a skill's `SKILL.md` exists under `.agents/skills/NAME/`; an MCP entry parses in
   `.omp/mcp.json`. A new skill loads after `/reload-plugins` or in the next session. A new
   extension, hook, or tool needs a restart.

## Install

| Kind | Command | Lands in |
|---|---|---|
| Marketplace plugin | `omp plugin install NAME@MARKETPLACE --scope project` | `.omp/plugins/installed_plugins.json` |
| Skill from a git repo | `npx --yes skills@1.7.0 add OWNER/REPO --skill NAME -a universal -y` | `.agents/skills/NAME/`, which the OMP `agents` provider loads, plus `skills-lock.json` |
| MCP server | an entry in `.omp/mcp.json`, built from the registry's package or remote metadata | project MCP config |
| npm plugin package | `omp plugin install PACKAGE` | user-wide: `--scope` applies to marketplace installs only |

## Rules

MUST Install at project scope unless the user asks for user-wide.
MUST Take every tier 1 and 2 row from its catalog: install address, version, and description
  come from `omp plugin discover`, not from memory.
MUST Record each tier 3 candidate's source URL, license, and last activity before listing it,
  and finish that check before its install command runs.
DEFAULT Prefer a tier 1 entry over a tier 2 or 3 one covering the same capability.
NOT Pass `-g` to `skills add`. It installs user-wide.
NOT Use `smithery mcp add` to configure a project. It creates a hosted connection on the
  user's Smithery account, not a project file.
NOT Commit the files an install writes unless the user asks.

OUTPUT
L1 PROJECT: markers found -> capabilities.
   Table: | package | kind | tier | install command | scope | status | proved by |
   `status` is `installed`, `available`, or `vetted` (tier 3).
   After install: each row's verification result, then the reload or restart the user needs.
CAP 200w plus the tables
