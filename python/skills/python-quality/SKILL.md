---
name: python-quality
description: Use to run Python format, lint, type-check, and test commands with the project toolchain.
---

# Python Quality

Use the `python_quality` tool (`mode: "check" | "fix"`, optional `path`). Check runs ruff check + ruff format --check, pyright when installed, pytest when installed and pyproject.toml or tests/ exists. Fix runs ruff check --fix and ruff format. Missing binaries are skipped.

Read failures as the project's actual toolchain output; do not invent extra linters.
