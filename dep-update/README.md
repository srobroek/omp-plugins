# dep-update

Classify dependency declarations by semver safety. Apply patch/minor bumps with per-bump confirmation. PyPI and npm support application; Rust/Go are advisory.

## Skills

| Name | When |
|------|------|
| `dep-update` | Upgrade dependencies, check outdated packages |

## Extensions

- `fixture-write-gate`: blocks `edit`/`write` of `.project-setup/answers.toml`
  and `.project-setup/sources.toml` at any depth. The project-setup runner owns
  those fixtures; this plugin only reads them for baseline pins and drift notes.

## Rules

| Name | When |
|------|------|
| `dep-update-no-scanner-install` | Advisory on persistently installing a CVE scanner (TTSR) |

## Tools

The plugin's extension modules register:

- `dep_apply`
- `dep_scan`

`dep_apply` declares exec approval. It requires interactive confirmation of the exact bump and project. Denial and headless execution stop application.
Direct tool calls can show both the host approval and the bump confirmation; device calls still require the bump confirmation.
Package-manager runs stop after 120 seconds or 64 KiB of combined output. Cancellation and failures can leave partial changes.

The detector reads root language manifests. Python also reads `uv.lock` or `poetry.lock` before falling back to declarations.
Node lockfiles select the package manager; the detector does not read their resolved versions.
The detector recognizes numeric equality pins such as `==1.2.3` and `=1.2.3`. It does not resolve version ranges.

The detector does not scan:

- `Cargo.lock`
- `go.sum`
- `Pipfile.lock`
- Ruby/PHP lockfiles
- workspace child manifests
