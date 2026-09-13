---
name: find-tools-no-install
description: During tool discovery, block install-mutating skills or MCP commands until explicitly approved.
condition: ["(?:^|[;&|(]\\s*|\\b(?:then|do)\\s+)(?:npx\\s+(?:--[^\\s]+\\s+)*skills\\s+add|smithery\\s+mcp\\s+add)\\b"]
scope: "tool:bash"
interruptMode: never
---
Install-mutating commands (`npx skills add`, `smithery mcp add`, curl piped to a shell) are trial-only after explicit approval. Never part of discovery.
