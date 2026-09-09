# agentic-scaffold

Deterministic repository scaffolding from ordered template layers and Beads formulas. The renderer uses only Python's standard library and never overwrites an existing user file. Managed marker blocks are updated in place.

## Usage

```bash
python3 skills/agentic-scaffold/scripts/scaffold.py profiles list
python3 skills/agentic-scaffold/scripts/scaffold.py inspect --root /path/to/repo
python3 skills/agentic-scaffold/scripts/scaffold.py plan --root /path/to/repo --profile agentic-repo --name example
python3 skills/agentic-scaffold/scripts/scaffold.py render --root /path/to/repo --profile agentic-repo --name example
python3 skills/agentic-scaffold/scripts/scaffold.py tools install --root /path/to/repo --yes
python3 skills/agentic-scaffold/scripts/scaffold.py hooks install --root /path/to/repo
python3 skills/agentic-scaffold/scripts/scaffold.py plugins sync --root /path/to/repo
```

`plan` writes nothing. `render` returns exit 5 for ownership or managed-marker conflicts. Render again to verify idempotency. Use `--var web_ui=true` to append the project-local browser/design plugin set and `--var speckit=true` to append `speckit`.

## Layout

Profiles live in `profiles/*.toml` and name ordered `templates/<layer>/` directories. A `.tmpl` suffix is rendered with `string.Template`; `__name__` path segments become the package name. `.block` fragments compose a managed block and preserve text outside its markers.

The agentic layer writes `.omp/plugins.toml` as the committed desired state. Plugin installations live under `.omp/plugins/` and are always project scope. `.omp/mcp.json`, `.omp/repomix.json`, `.omp/context.py`, and `.omp/project-context.json` configure local context refresh.

## Profiles

`agentic-repo` is the minimal profile shipped here. Language, CI, and release profiles are separate layers and can be supplied by the companion profile package. Run `profiles list` to inspect available layers and desired plugins.

## Development

```bash
just test
just lint
just check
just formulas-check
```

The human end-to-end process is in [`docs/runbook.md`](docs/runbook.md).
