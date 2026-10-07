---
name: dep-update
description: Classify dependencies by semver safety and produce a cited upgrade plan. Applies patch/minor with per-bump confirm. Use when asked to upgrade dependencies.
---

# Dependency Update / Upgrade Advisory

TRIGGER
+ "upgrade dependencies", "update my dependencies", "bump versions", "apply safe bumps"
+ "what's outdated", "check for stale packages", "check for outdated packages", "update lockfile", "dep update", "renovate"
- choosing a project's initial dependencies → the `toolchain-stack-defaults` rule (this skill only
  moves versions a repo already declares, and its output is time-varying by
  design: the same repo yields a different plan next month)

## Workflow

1. Run the `dep_scan` tool (params: `path`, optional `offline_fixture_dir`) -- it
   enumerates deps and classifies every bump. For rust and go, use the endpoints in
   `skill://dep-update/references/recipes.md`.
2. Run the CVE scanners below.
3. For MINOR-CHECK and MAJOR-ADVISORY, fetch changelog prose in the order given
   in `skill://dep-update/references/recipes.md` and cite every source by URL or git tag.
4. Present the plan, then run the apply loop.
5. Summarize: N applied, M skipped, K advisory majors, J CVEs needing action.

## Plan format

Four groups in this priority order, sorted by name within each group:

```
CVE-FLAGGED     <name>  <current> → <latest>  [CVE-XXXX-XXXX] <scanner> <advisory-url>
PATCH-SAFE      <name>  <current> → <latest>  [cite]
MINOR-CHECK     <name>  <current> → <latest>  [cite]
MAJOR-ADVISORY  <name>  <current> → <latest>  breaking: <summary>  [cite]
UNRESOLVABLE   <name>  <declaration> → <latest>  reason: <unresolved version or registry failure>
```

Manifest ranges alone do not establish installed versions; resolve the declared
version before classifying it. Classes for `A.B.C` against latest `X.Y.Z`:
`C<Z` PATCH-SAFE · `B<Y` MINOR-CHECK · `A<X` MAJOR-ADVISORY · equal omitted.
Unresolved declarations are `UNRESOLVABLE`, not minor upgrades. Resolve exact versions before planning or applying a bump.

## Apply loop

Present each PATCH-SAFE and MINOR-CHECK dep alone, in plan order, showing the
changelog cite for MINOR:

```
name: old → new (PATCH|MINOR)  [cite]
```

Then run the `dep_apply` tool (`ecosystem`, `name`, `version`, optional `path`). It
shows the user one confirmation naming that exact bump; that confirmation is the
approval -- do not ask a separate chat `[Y/n]` first. Denied: record as skipped and
move on.

MUST issue one `dep_apply` call per bump -- no batching, no yes-to-all.
MUST stop application when the confirmation is denied or the session is headless (`dep_apply` refuses without a UI).
NOT approving a host prompt on the user's behalf.
MUST treat a dep-update skill read as workflow handoff, never as approval for a bump.
MUST inspect manifests and lockfiles after cancellation, deadline, output-limit, or package-manager failure; partial changes can remain.
MUST keep majors, rust, and go out of the loop: named, cited, stopped.
NOT writing a lockfile or manifest by hand -- apply every bump with `dep_apply`.
NOT importing a Python SDK -- native TypeScript tools only.
MUST report coverage as observed: ecosystems detected, lockfiles read, scanners
that ran, scanners that were absent. An unrun scanner never reads as clean.

## CVE scanners

| Ecosystem | Scanner | Ephemeral runner |
|-----------|---------|------------------|
| python | `pip-audit` | `uvx pip-audit` |
| node | `pnpm audit` / `npm audit` / `yarn npm audit` | Use the project package manager's audit command; do not install a persistent scanner. |
| rust | `cargo-audit` | None: `cargo install`/`cargo binstall` are persistent installs. Use it only when `command -v cargo-audit` finds it; otherwise report the gap. |
| go | `govulncheck` | `go run golang.org/x/vuln/cmd/govulncheck@latest` |
| any | `osv-scanner` (supplemental) | `go run github.com/google/osv-scanner/v2/cmd/osv-scanner@latest` (not published to npm) |

Guard each with `command -v`; missing → report "scanner not available: `<name>`" plus the runner. The plugin's `dep-update-no-scanner-install` rule is advisory (`interruptMode: never`): it reminds after a persistent scanner install was sent, it does not stop one.

## Tools

| Tool | Purpose |
|------|---------|
| `dep_scan` | Enumerate deps, query PyPI/npm, classify bumps. Transitive lockfile entries are listed, not queried. |
| `dep_apply` | Apply one bump via the package manager after one exact-bump confirmation, then verify the manifest. |

`skill://dep-update/references/recipes.md` holds what the tools do not: the go-proxy and
crates.io endpoints, the advisory-only apply commands, and the changelog fetch
order.

## Out of scope

The detector reads root `package.json` (+ `package-lock.json` for resolved versions), `Cargo.toml`, `go.mod`, `Gemfile`, and `composer.json`.
Python declarations come from `pyproject.toml` (PEP 621, dependency groups, Poetry tables), else `requirements.txt`; `uv.lock`/`poetry.lock` only supply resolved versions, and undeclared lock entries are transitive (never bumped). Local path/editable sources are skipped.
Python apply: `poetry add` when `poetry.lock` or `[tool.poetry]` exists; else `uv add` (`--frozen` when there is no `uv.lock`); a requirements-only project gets a manual instruction, never an install.
`Cargo.lock`, `go.sum`, `Pipfile.lock`, Ruby/PHP lockfiles, other Node lockfiles, and workspace child manifests are not scanned.
Report these coverage gaps; do not describe declaration ranges as installed versions. It does not cover:

- Docker image tag lookup (`FROM` lines, Hub/GHCR tags)
- GitHub Actions pinning (`uses:` version pins in workflow YAML)

Those are not dependency-upgrade work under this skill's contract. Do not
implement them here and do not invent a scanner for them.
