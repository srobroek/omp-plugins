# Tooling

`tools install` requires `--yes`, runs `mise install`, then runs `uv sync` for Python projects and `bun install` for Node projects. Generated `justfile` recipes expose setup, test, lint, fmt, check, and context. Run `just check` after installation.
