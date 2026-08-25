---
name: find-tools-no-install
description: Discovery must not run install-mutating commands.
condition: ["(npx skills add|smithery mcp add|curl .*\\| *(ba)?sh)"]
scope: "tool:bash"
interruptMode: always
---
Install-mutating commands are trial-only after explicit approval. Never part of discovery.
