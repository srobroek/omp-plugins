# Python stack

Asset set: `skill://project-setup/assets/lang/python/`

## Asked

| Question | Default | Notes |
|---|---|---|
| Minimum supported version | `3.13` | Fills `@@PYTHON_VERSION@@` in `.mise/conf.d/python.toml.template` and `@@PYTHON_VERSION_NODOT@@` in `ruff.toml.template`, where `3.13` becomes `313` |
| Latest-stable uv version | exact value accepted during setup | Fills `@@UV_VERSION@@` in `.mise/conf.d/python.toml.template`, `.mise/conf.d/hooks.toml.template`, and the CI setup action, which pins setup-uv to the same value |
| Layout: `src` or `flat` | `src` | A `src` layout keeps the package off `sys.path` during a test run. `src` keeps the `pythonpath = src` block in `pytest.ini.template`; `flat` deletes it |

## Fixed

| Concern | Tool |
|---|---|
| Environments and installs | uv |
| Formatting and linting | ruff |
| Types | ty |
| Tests | pytest |
| Unused dependencies | deptry |
| Version matrix | nox |

## ruff configuration, and why it is shaped this way

`preview = true` is required. Without it ruff prints `Selection 'DOC' has no effect
because preview is not enabled` and the docstring-signature rules check nothing.

`D` stays out of `select`. ruff has no per-rule severity, so selecting it makes a bare
`ruff check` fail, which defeats the advisory intent. The advisory recipe passes
`--select D --exit-zero` instead, which is why warn-level and block-level rules are two
invocations rather than one.

Per-file ignores use rule names. With `preview = true`, RUF201 rejects `"S101"` while
accepting a group prefix such as `ANN`. `ruff check --fix` rewrites a code to its name.

The `scripts/**` ignore block exempts copied plumbing from `DOC` and subprocess `S` rules.
Without the exemption, `just check` fails before the first commit.

## Apply order

1. `uv init` in the destination, which writes `pyproject.toml` and the package
   directory, then move the package under `src/` for a `src` layout.
2. Copy the asset set, resolving `@@PYTHON_VERSION@@`, `@@PYTHON_VERSION_NODOT@@`, `@@UV_VERSION@@`, and the layout block.
3. `uv sync`, then add the dev dependencies: `ruff`, `ty`, `pytest`, `deptry`, `nox`.
4. `just just-sync`, then `just hooks-merge`, then `just ci-sync`.

## Files

| Asset | Destination | Class |
|---|---|---|
| `ruff.toml.template` | `ruff.toml` | CREATE |
| `pytest.ini.template` | `pytest.ini` | CREATE |
| `.just.d/python.just` | `.just.d/python.just` | CREATE |
| `.pre-commit.d/python.yaml` | `.pre-commit.d/python.yaml` | CREATE |
| `.gitignore.d/python` | `.gitignore.d/python` | CREATE |
| `.mise/conf.d/python.toml.template` | `.mise/conf.d/python.toml` | CREATE |
| `.github/actions/setup-python/action.yml.template` | `.github/actions/setup-python/action.yml` | CREATE |
| `.github/quality.d/python.yml` | same path | CREATE |
| `.github/security.d/python.yml` | same path | CREATE |
| `.github/workflows/wc-lint-python.yml` | same path | CREATE |
| `.github/workflows/wc-test-python.yml.template` | `.github/workflows/wc-test-python.yml` | CREATE |
| `.gitlab/ci/python.yml` | same path | CREATE on a GitLab forge, SKIP otherwise |

`ruff.toml` names `ruff.toml` itself as the marker that a Python layer is present: the
gitignore fold and the steering generator both detect the language from that file rather
than from a recorded answer.

## Recipes it adds

`python`, `python-fmt`, `python-lint`, `python-docs`, `python-types`, `python-test`,
`python-deps`, `python-cov`, `python-matrix`, `python-install`.
