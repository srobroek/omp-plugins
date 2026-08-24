---
name: go-quality
description: Use to run Go format, lint, and test checks with the project toolchain.
---

# Go Quality

Use the `go_quality` tool (`mode: "check" | "fix"`, optional `path`). Check runs gofmt -l, golangci-lint (if installed), then go test ./.... Fix runs gofmt -w only. Missing binaries are skipped.

Read failures as the project's actual toolchain output; do not invent extra linters.
