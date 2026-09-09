# agentic-scaffold

Deterministic repository scaffolding from ordered template layers and Beads formulas. Install it with:

```bash
omp plugin install agentic-scaffold@srobroek-omp
```

The renderer uses Python's standard library, never overwrites user-owned files, and updates only managed marker blocks.

## CLI

Run from the target repository or pass `--root` explicitly:

| Command | Purpose |
| --- | --- |
| `profiles list` | List available profiles, layers, and desired plugins. |
| `inspect --root <root>` | Detect stacks, tooling, hooks, and missing tools. |
| `plan --root <root> --profile <profile> --name <name>` | Show the file map without writing. |
| `render --root <root> --profile <profile> --name <name>` | Render missing files and managed blocks. |
| `plugins sync --root <root> [--check]` | Reconcile `.omp/plugins.toml` with project-scope installs. |
| `hooks install --root <root>` | Install declared prek hooks without forcing existing hooks. |
| `tools install --root <root> --yes` | Install the profile's pinned tools and dependencies. |
| `context refresh --root <root>` | Refresh Graphify and Repomix context. |

`plan` and `render` return exit code 5 for ownership or managed-marker conflicts. Use `--var web_ui=true` to append the web UI plugin set and `--var speckit=true` to append SpecKit.

## Layout and profiles

`skills/agentic-scaffold/templates/` contains ordered layers. `.tmpl` files use Python `string.Template`; `.block` files contribute managed marker fragments. `profiles/*.toml` select layers, defaults, project plugins, and commands. Available profiles include `agentic-repo`, language library/application profiles, `terraform`, and `web-ui`.

The agentic layer writes the committed desired state at `.omp/plugins.toml`. Installed plugins belong to `.omp/plugins/` and always use project scope; global plugin state is never changed.

Formulas are in `formulas/`; architectural notes are in `docs/architecture.md`; the human verification procedure is in [`docs/runbook.md`](docs/runbook.md).
