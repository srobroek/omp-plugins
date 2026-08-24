---
name: python-language
description: When writing or reviewing Python layout, services, domain code, framework boundaries, tooling, tests, linting, or typing.
globs: ["**/*.py"]
---

# Python

Use `src/<package>/` layouts with `api`, `domain`, `application`, `adapters`,
and `settings.py` for services.

Keep domain code independent from framework and IO concerns.

Structural navigation uses the `lsp` tool; text search uses the `grep` tool.
