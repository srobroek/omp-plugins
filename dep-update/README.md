# dep-update

This plugin classifies dependency declarations by semver safety. It can apply patch or minor bumps, with confirmation for each bump.
The plugin can apply changes for PyPI and npm. For Rust and Go, it only provides advice.

## Skills

| Name | When |
|------|------|
| `dep-update` | Upgrade dependencies, check outdated packages |

## Extensions

- `fixture-write-gate`: blocks `edit`/`write` of `.project-setup/answers.toml`
  and `.project-setup/sources.toml` at any depth.
  The project-setup runner owns these fixtures. This plugin reads them only to report baseline pins and drift.

## Rules

| Name | When |
|------|------|
| `dep-update-no-scanner-install` | Advisory on persistently installing a CVE scanner (TTSR) |

## Tools

The plugin registers `dep_scan` to scan dependencies and `dep_apply` to apply a confirmed bump.

### Confirm a bump

`dep_apply` declares exec approval. Before applying a bump, it asks you to confirm which version to install and which project to change.
If you deny confirmation or run without an interactive session, the tool stops without applying the bump.
Direct calls to the tool can show both host approval and confirmation of the bump. Calls through a device still need confirmation of the bump.

After 120 seconds or 64 KiB of combined output, the tool stops the package manager. Cancellation and failures can leave partial changes.

### Find dependency versions

The detector reads manifests at the project root. For Python, it checks `uv.lock` or `poetry.lock` first. If neither supplies the version, it uses declarations.
For Node, lockfiles select the package manager. The detector does not read resolved versions from those lockfiles.

The detector recognizes versions pinned with `==` or `=`, such as `==1.2.3` and `=1.2.3`. It does not resolve version ranges.
The scanner labels unresolved versions `UNRESOLVABLE` and excludes them from upgrade recommendations.
Before choosing a bump, resolve the installed version.

The detector does not scan:

- `Cargo.lock`
- `go.sum`
- `Pipfile.lock`
- Ruby/PHP lockfiles
- workspace child manifests
