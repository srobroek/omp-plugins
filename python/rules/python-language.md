---
name: python-language
description: When writing or reviewing Python layout, services, domain code, framework boundaries, tooling, tests, linting, or typing.
globs: ["**/*.py"]
---

# Python

Use `src/<package>/` layouts with `api`, `domain`, `application`, `adapters`,
and `settings.py` for services.

Keep domain code independent from framework and IO concerns.

Use Python tooling, editor integrations exposed by the host, and `rg` for
definitions, references, diagnostics, and rename planning. Do not assume a
Python LSP MCP server is configured.
