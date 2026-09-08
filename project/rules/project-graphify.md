---
name: project-graphify
description: When using Graphify for repository architecture, relationships, impact analysis, or agentic context freshness.
---

# Graphify navigation

| Situation | Choice |
|---|---|
| Architecture, relationships, or impact question with a current graph | Query the project Graphify MCP with a bounded depth and token budget. |
| Known file or precise symbol | Read the file or use LSP directly. |
| Missing graph or changed source since indexing | Read source; refresh only when the relationship question needs it. |
| Bulk review of the configured source scope | Follow rule://research-repomix-recipes. |
| Setup, MCP, hooks, or document extraction | Follow skill://agentic-scaffold. |

MUST Check `graphify-out/context-status.json` in scaffolded projects before relying on generated context.
MUST Verify graph findings against source before editing or claiming a relationship.
MUST Treat semantic edges as inferred until the underlying document establishes them.
NOT Require Graphify before every file read or LSP lookup.
NOT Treat a matching committed HEAD as proof that uncommitted edits are indexed.
NOT Put graph reports, XML packs, or generated indexes into startup context.
