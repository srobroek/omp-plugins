# dep-update: what the scripts do not implement

`research.py` queries PyPI and npm only. Everything below covers the gaps:
the rust/go endpoints, the apply commands per package manager, the changelog
fetch order, and the `answers.toml` key names.

All version data comes from machine-readable JSON endpoints -- never scrape
rendered HTML for a version number. Reserve web-fetch for changelog prose
(migration guides, breaking-change posts) that has no structured endpoint.

## Registry endpoints not in research.py

Go modules (advisory only -- no apply):

```sh
curl -fsSL "https://proxy.golang.org/<module>/@latest"   # {"Version":"v1.2.3","Time":"..."}
curl -fsSL "https://proxy.golang.org/<module>/@v/list"   # newline-separated tags
```

Rust / crates.io (advisory only -- no apply): `max_stable_version` and
`repository` live under `.crate` in

```sh
curl -fsSL -A 'dep-update-skill (+https://github.com/srobroek/omp-plugins)' \
  "https://crates.io/api/v1/crates/<name>"
```

## Ecosystem → lockfile → apply command

| Lockfile / manifest | Ecosystem | Apply command | Notes |
|---------------------|-----------|---------------|-------|
| `uv.lock` / `pyproject.toml` / `requirements.txt` / `poetry.lock` / `Pipfile.lock` | python | `uv add "name==ver"` | Updates pyproject.toml + uv.lock atomically |
| (python, no uv) | python | `pip install "name==ver"` | Manual: also edit requirements.txt / pyproject.toml |
| `pnpm-lock.yaml` | node | `pnpm update name --version ver` | |
| `bun.lock` / `bun.lockb` | node | `bun add "name@ver"` | |
| `yarn.lock` | node | `yarn add "name@ver"` | |
| `package-lock.json` / `npm-shrinkwrap.json` | node | `npm install "name@ver"` | |
| `Cargo.lock` / `Cargo.toml` | rust | `cargo update -p name --precise ver` | Advisory only -- never applied by this skill |
| `go.sum` / `go.mod` | go | `go get module@ver && go mod tidy` | Advisory only -- never applied by this skill |

Node package manager precedence: `[module.lang-ts].package_manager` in
`answers.toml` first, else lockfile order `pnpm-lock.yaml` →
`bun.lock`/`bun.lockb` → `yarn.lock` → `package-lock.json`.

Pre-release candidates (`rc`, `alpha`, `beta`, `a`, `b`, `dev`) are excluded
from the upgrade offer unless the installed version is itself pre-release; the
latest stable is offered instead.

## Changelog fetch order (MINOR-CHECK + MAJOR-ADVISORY)

1. Registry metadata URLs: `info.project_urls.Source` (PyPI), `repository` (npm).
2. Blobless bare clone at the tag span, reading the changelog at the target tag:
   ```sh
   git clone --bare --filter=blob:none "$REPO" "$TMP/r.git"
   G="git --git-dir=$TMP/r.git"
   $G tag --list | grep -E "(^|[-@/])v?${TO}$"   # tags carry v-, @-, path- prefixes
   $G show "${TO}:CHANGELOG.md"                   # or CHANGELOG, CHANGES.md, HISTORY.md, NEWS.md
   ```
3. Migration prose (MAJOR-ADVISORY only): locate it in-repo first with
   `$G ls-tree -r --name-only "$TO" | grep -iE 'migrat|upgrad|breaking'`. Prefer
   the project's own guide; flag third-party blogs as derivative. Only then is a
   targeted web fetch justified.
4. Nothing found → report "no changelog found" and point the user upstream.

## answers.toml keys (read-only, opportunistic)

Read `.project-setup/answers.toml` with `tomllib`. Under `module`:

| Section | Keys |
|---------|------|
| `lang-python` | `pinned_deps`, `dev_deps`, `framework`, `python_version`, `ruff_version` |
| `lang-ts` | `pinned_deps`, `dev_deps`, `package_manager`, `package_manager_pin` |

`pinned_deps` entries are `"name@exact-version"` strings. Absent file, section,
or key → empty defaults, never an error.
