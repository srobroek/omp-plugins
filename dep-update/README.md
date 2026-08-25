# dep-update

Classify lockfile/manifest dependencies by semver safety and apply patch/minor bumps with per-bump confirm. PyPI and npm are implemented; rust/go are advisory. Docker tags and GitHub Actions pins are out of scope.

## Skills

| Name | When |
|------|------|
| `dep-update` | Upgrade dependencies, check outdated packages |

## Extensions

- `fixture-write-gate` — blocks `edit`/`write` of `.project-setup/answers.toml`
  and `.project-setup/sources.toml` at any depth. The project-setup runner owns
  those fixtures; this plugin only reads them for baseline pins and drift notes.

## Rules

| Name | When |
|------|------|
| `dep-update-no-scanner-install` | Advisory on persistently installing a CVE scanner (TTSR) |

## Agents

None.

## Tools

Registered by this plugin's extension modules:

- `dep_apply`
- `dep_scan`
