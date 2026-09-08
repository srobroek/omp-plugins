---
name: agentic-scaffold
description: Scaffolds a project's agent instructions, watchdog notes, Graphify MCP, scoped Repomix context, and prek hooks. Use for agentic scaffolding or repository agent setup.
---

# Agentic Scaffolding

TRIGGER
+ "agentic scaffolding", "scaffold this project for agents", or `/agentic-scaffold`
+ add project-local OMP instructions, repository context, MCP, and agentic Git hooks
- scaffold an application, framework, or product feature → the project's application workflow
- audit or migrate all existing agent tooling → skill://brownfield-project

## Workflow

1. Inspect the repository's purpose, owners, commands, and existing conventions.
   Read only enough source and manifests to identify its real workflow and risks.
2. Call `agentic_scaffold` with `action: inspect` and the repository root. Resolve
   conflicting hooks/configuration and missing tools before applying changes.
3. Choose explicit Repomix include patterns. Write a temporary JSON notes file
   with `agents` (purpose, commands, boundaries) and `watchdog` (specific risks).
   Never invent commands, project facts, or requirements.
4. Present the concrete files, hook stages, tool installs, and indexing scope.
   Apply an already authorized batch without asking for the same permission again.
5. Call `agentic_scaffold` with `action: apply`, `root`, `notesFile`, `include`,
   and `installTools` when installation is authorized. Default to local code-only
   indexing. LOAD skill://agentic-scaffold/references/integration.md for document
   indexing, existing hook managers, MCP discovery, or refresh failures.
6. Exercise Graphify queries and the configured MCP server; check generated XML
   and `graphify-out/context-status.json`. Run the installed prek refresh hook.
   Verify source exclusions and preservation of existing instructions/hooks.
7. Remove the temporary notes file. Report installed, verified, and blocked items
   separately, including the reload needed for newly discovered MCP/skills.

## Rules

MUST Preserve human-owned instructions and existing hooks; update only managed blocks.
MUST Keep graph output and `repomix.xml` ignored; refresh both after commits.
MUST Use source/LSP for exact edits; graph relationships and XML are discovery aids.
MUST Require an explicit backend, model, and disclosure approval for semantic docs indexing.
NOT Initialize Git, beads, a product framework, or a new global provider implicitly.
NOT Run Graphify's separate hook installer beside prek or register a graph merge driver.
NOT Import whole graph reports, XML packs, or detailed playbooks into startup context.
DEFAULT Fresh or existing Git repositories; no application code generation.
