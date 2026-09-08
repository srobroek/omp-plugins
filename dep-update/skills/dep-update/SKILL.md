---
name: dep-update
description: Classify dependencies by semver safety and produce a cited upgrade plan. Applies patch/minor with per-bump confirm. Use when asked to upgrade dependencies.
---

# Dependency Update / Upgrade Advisory

TRIGGER
+ "upgrade dependencies", "update my dependencies", "bump versions", "apply safe bumps"
+ "what's outdated", "check for stale packages", "check for outdated packages", "update lockfile", "dep update", "renovate"
- reproducing a frozen bootstrap → project-setup `--refresh` (this output is
  time-varying by design; the same repo yields a different plan next month)

## Workflow

1. Run the `dep_scan` tool (params: `path`, optional `offline_fixture_dir`) -- it
   enumerates deps and classifies every bump. For rust and go, use the endpoints in
   `skill://dep-update/references/recipes.md`.
2. If `.project-setup/answers.toml` exists, read the baseline pins from
   `[module.lang-python]` / `[module.lang-ts]` (keys in `skill://dep-update/references/recipes.md`).
   Absent file or section → continue using detector declarations without baseline drift claims.
3. Run the CVE scanners below.
4. For MINOR-CHECK and MAJOR-ADVISORY, fetch changelog prose in the order given
   in `skill://dep-update/references/recipes.md` and cite every source by URL or git tag.
5. Present the plan, then run the apply loop.
6. Summarize: N applied, M skipped, K advisory majors, J CVEs needing action.

## Plan format

Four groups in this priority order, sorted by name within each group:

```
CVE-FLAGGED     <name>  <current> → <latest>  [CVE-XXXX-XXXX] <scanner> <advisory-url>
PATCH-SAFE      <name>  <current> → <latest>  [cite]  [drifted from answers.toml: <baseline>]
MINOR-CHECK     <name>  <current> → <latest>  [cite]
MAJOR-ADVISORY  <name>  <current> → <latest>  breaking: <summary>  [cite]
UNRESOLVABLE   <name>  <declaration> → <latest>  reason: <unresolved version or registry failure>
```

A dep whose independently resolved version differs from its `answers.toml` baseline carries
the drift note. Manifest ranges alone do not establish installed-version drift. Classes for `A.B.C` against latest `X.Y.Z`:
`C<Z` PATCH-SAFE · `B<Y` MINOR-CHECK · `A<X` MAJOR-ADVISORY · equal omitted.
Unresolved declarations are `UNRESOLVABLE`, not minor upgrades. Resolve exact versions before planning or applying a bump.

## Apply loop

Present each PATCH-SAFE and MINOR-CHECK dep alone, in plan order, showing the
changelog cite for MINOR:

```
name: old → new (PATCH|MINOR)  [cite]
Apply? [Y/n]
```

On `Y`: run the `dep_apply` tool (`ecosystem`, `name`, `version`, optional `path`).
On `n`: record as skipped and move on.

MUST confirm every bump on its own `[Y/n]` -- no global yes-to-all, no batching.
MUST wait for the user's host approval and exact-bump confirmation for each `dep_apply` call. Denial or a headless session stops application.
NOT approving a host prompt on the user's behalf.
MUST treat a dep-update skill read as workflow handoff, never as approval for a bump.
MUST inspect manifests and lockfiles after cancellation, deadline, output-limit, or package-manager failure; partial changes can remain.
MUST keep majors, rust, and go out of the loop: named, cited, stopped (FR-014).
NOT writing `.project-setup/answers.toml` or `sources.toml` -- enforced by the
`fixture-write-gate` extension.
NOT importing a Python SDK -- native TypeScript tools only.
MUST report coverage as observed: ecosystems detected, lockfiles read, scanners
that ran, scanners that were absent. An unrun scanner never reads as clean.

### ruff pre-commit bundling (FR-021)

When ruff is bumped in a Python project and `.pre-commit-config.yaml` has a
parseable `rev:` under `astral-sh/ruff-pre-commit`, bundle that `rev` update
into the same ruff confirm. Unparseable YAML → print the manual change instead.

## CVE scanners

| Ecosystem | Scanner                                       | Install hint                                          |
|-----------|-----------------------------------------------|-------------------------------------------------------|
| python    | `pip-audit` / `uvx pip-audit`                 | `pip install pip-audit`                               |
| node      | `pnpm audit` / `npm audit` / `yarn npm audit` | install via Node.js / Corepack                        |
| rust      | `cargo audit`                                 | `cargo install cargo-audit`                           |
| go        | `govulncheck`                                 | `go install golang.org/x/vuln/cmd/govulncheck@latest` |
| any       | `osv-scanner` (supplemental)                  | https://google.github.io/osv-scanner/                 |

Guard each with `command -v`; missing → report "scanner not available:
`<name>`" plus the install hint. Ephemeral runners and the ban on persistent
scanner installs are enforced by `rule://dep-update-no-scanner-install`.

## Tools

| Tool | Purpose |
|------|---------|
| `dep_scan` | Enumerate deps, query PyPI/npm, classify bumps. Optional `offline_fixture_dir` / `DEP_UPDATE_FIXTURE_DIR`. |
| `dep_apply` | Apply one bump via the package manager, then verify the manifest. |

`skill://dep-update/references/recipes.md` holds what the tools do not: the go-proxy and
crates.io endpoints, the advisory-only apply commands, the changelog fetch
order, and the `answers.toml` key names.

## Out of scope

The detector reads root `package.json`, `Cargo.toml`, `go.mod`, `Gemfile`, and `composer.json`.
Python uses the first available `uv.lock`, `poetry.lock`, `requirements.txt`, or `pyproject.toml`, in that order.
Node lockfiles select the apply command but are not scanned for resolved versions.
`Cargo.lock`, `go.sum`, `Pipfile.lock`, Ruby/PHP lockfiles, and workspace child manifests are not scanned.
Report these coverage gaps; do not describe declaration ranges as installed versions. It does not cover:

- Docker image tag lookup (`FROM` lines, Hub/GHCR tags)
- GitHub Actions pinning (`uses:` version pins in workflow YAML)

Those are not dependency-upgrade work under this skill's contract. Do not
implement them here and do not invent a scanner for them.
