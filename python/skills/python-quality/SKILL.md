---
name: python-quality
description: Use to run Python format, lint, type-check, and test commands with the project toolchain.
---

# Python Quality

Use the `python_quality` tool (`mode: "check" | "fix"`, optional `path`). Check runs ruff check + ruff format --check, pyright when installed, pytest when installed and pyproject.toml or tests/ exists. Fix runs ruff check --fix and ruff format. Missing binaries are skipped, and so is a pytest run that collects no tests.
Missing projects or requested binaries make the report incomplete (`ok: false, complete: false`), and so does a command that times out or is cancelled. Skipped steps are not PASS.
The tool runs on the whole project: pass the project root as `path`, since a subdirectory or file path without its own pyproject.toml or tests/ skips every step. Fix mode can rewrite files outside the task, so review the diff and revert incidental rewrites; for a narrow fix, run `ruff check --fix PATHS` or `ruff format PATHS` through bash.

Read failures as the project's actual toolchain output; do not invent extra linters.
