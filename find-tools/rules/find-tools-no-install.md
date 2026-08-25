---
name: find-tools-no-install
description: Discovery must not run install-mutating commands.
condition: ["^\\s*(?:npx\\s+skills\\s+add|smithery\\s+mcp\\s+add)\\b"]
scope: "tool:bash"
interruptMode: never
---
Install-mutating commands (`npx skills add`, `smithery mcp add`, curl piped to a shell) are trial-only after explicit approval. Never part of discovery.
