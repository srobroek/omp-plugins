---
name: go-language
description: When writing or reviewing Go binaries, packages, domain boundaries, CLIs, configuration, routing, RPC, SQL, tests, or tooling.
---

# Go

Use `cmd/` for binaries and `internal/` for non-exported implementation code.

Keep packages small and explicit. Avoid framework imports in domain packages.

Structural navigation uses the `lsp` tool; text search uses the `grep` tool.
