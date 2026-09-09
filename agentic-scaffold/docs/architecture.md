# Architecture

`skills/agentic-scaffold/scripts/scaffold.py` is the runtime boundary. It uses Python stdlib modules (`tomllib`, `json`, and `string.Template`) plus subprocesses for declared integrations. The CLI loads a profile, resolves layer defaults, applies profile overrides, applies CLI overrides, and produces one deterministic file map.

Each `templates/<layer>/` directory contains `layer.toml`, a short `README.md`, and plain template files. `layer.toml` defines ordering, tools, ownership, managed blocks, conflicts, variables, and project plugins. `.tmpl` files use `string.Template`. The renderer substitutes `__name__` path segments. `.block` files compose managed markers for each layer.

Profiles define ordered layers, variables, and commands. The `web-ui` layer adds an `AGENTS.md` block and plugin entries. The renderer writes plugin entries to `.omp/plugins.toml`. It keeps existing marketplaces and plugin names. For `mcp.json`, existing keys win in a deep merge. The renderer parses existing TOML `[tools]` keys with `tomllib` before it appends missing keys.

`.omp/scaffold-answers.toml` stores committed desired input. `.omp/scaffold.json` stores the installed profile, layer list, plugin version, and hashes of owned files. `update` refreshes managed blocks. It reports owned-file drift and leaves changed owned files untouched.

`inspect` reads the repository and reports stack, tool, hook-manager, and unowned-file findings. `plan` and `render --dry-run` read the repository and return exit 5 for conflicts. `doctor` checks tools, project plugin sync, installed hooks, context status, answers, and markers. Exit 2 means drift. Formulas add human gates for the interview and commit stages.
