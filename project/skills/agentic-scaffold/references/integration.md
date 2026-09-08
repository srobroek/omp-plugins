# Repository integrations

## Graphify for OMP

Install Graphify's project skill with `graphify install --project --platform agents`.
OMP discovers `.agents/skills/graphify`; the Pi platform writes a different location.
Keep one `graphify` skill provider per repository. Preserve an existing installation.

The scaffold adds a `graphify` stdio entry to `.omp/mcp.json` and preserves other
servers. Its Python launcher finds the Git root, then starts `graphify-mcp` with
an absolute graph path. Reload OMP after installation. Run a graph query through
MCP; listing a configuration file alone does not prove the server works.

Use Graphify for repository relationships, architecture, and impact questions.
Use LSP for exact definitions, references, and refactors. Read source before edits.
For known files, read directly. Missing or stale graph coverage does not block
source navigation. The generated skill does not override this scoped policy.

## Indexing and billing

Default extraction is `graphify extract . --code-only --no-cluster`, followed by
`graphify cluster-only . --no-label --no-viz`. Neither step requests model output.
Graphify's unrestricted extraction can auto-select an API backend from environment
credentials. Do not use that default for unattended hooks.

For semantic document indexing, obtain approval for repository disclosure and
recurring hook usage. Pass both `docsBackend` and `docsModel`; configure credentials
outside the repository. A local Ollama backend still needs a running model and its
Graphify backend prerequisites. Do not select a paid backend merely because a key
exists. OMP role names and Codex subscriptions are not Graphify backend credentials.

Semantic extraction produces inferred relationships. Check the underlying document
before treating those relationships as facts. The default code-only graph excludes
document semantics; Repomix can still include their text.

## Repomix

Use `repomix.xml` when reviewing the selected source files together. Choose explicit
include patterns during scaffolding; do not broaden to the whole tree by default.
The generated `.omp/repomix.json` enables security scanning and a 40,000-token cap.
A capped pack can omit content. Read its warnings and inspect source for exact work.

Both tools exclude generated output, credentials, environment files, dependencies,
and build products. Security scanning is a second check, not a disclosure guarantee.
Keep generated output ignored and never import XML into `AGENTS.md`.

## Prek hooks and preservation

The scaffold composes a local `omp-context-refresh` hook into the existing
`prek.toml` or `.pre-commit-config.yaml`. Multiple competing configurations require
a human choice. Existing entries and comments remain; repeated setup updates the
same hook rather than appending another.

Install post-commit, post-checkout, and post-merge stages through prek. Its migration
mode preserves existing executable hooks as `.legacy` and invokes them. Never use
`--force` to delete them. Resolve a configured `core.hooksPath` with its owner before
installation. Do not install Graphify's separate hooks or its graph merge driver:
the graph is untracked, and prek owns refresh dispatch.

Refresh is synchronous and bounded. `graphify-out/context-status.json` becomes
`STALE` before generation and `CURRENT` only after both artifacts succeed. A refresh
failure cannot roll back an already-created commit. Report the failure and rerun
`python3 .omp/context.py refresh`; never claim that the commit failed to exist.
Concurrent refreshes fail visibly rather than racing. Inspect a leftover
`graphify-out/.refresh.lock` before removing it after an interrupted process.

## Ownership and recovery

`AGENTS.md` and `WATCHDOG.md` retain content outside the scaffold's marked blocks.
Do not run setup against symlinked instructions or ambiguous markers. The scaffold
owns `.omp/context.py`, `.omp/project-context.json`, and `.omp/repomix.json`; an
existing unowned file requires reconciliation, not automatic adoption.

Dependencies require `uv`, `bun`, and Python through the project's toolchain. With
installation authority, the tool installs missing prek, Graphify with MCP support,
and Repomix. It never initializes Git, beads, or application code. Re-run the
scaffold after a clone or toolchain relocation; generated indexes are local.
