# Module Author Reference

This document covers the SDK public API available to every `module.py`, the
module invocation model, and how to test modules in isolation. See
[README.md](README.md) for the directory shape and module.toml schema, and
[shared-contracts.md](shared-contracts.md) for the full contract reference.

---

## SDK public API

The sdk is loaded by `module.py` via the `_load_sdk()` shim (see
[README.md](README.md) for the pattern). Once loaded, the following names are
available:

### `load_frozen_inputs(plan_path, module_id) -> FrozenInputs`

Load the frozen plan and return a `FrozenInputs` for the named module.

```python
inputs = sdk.load_frozen_inputs(args.plan, module_id="my-module")
```

Raises `GateFailure` if the plan is malformed or the module id is absent.
`plan_path` is the value of `args.plan` (passed by the runner as `--plan`).

---

### `class FrozenInputs`

Typed read-only view of a module's frozen answers. Returned by
`load_frozen_inputs`.

| Accessor | Signature | Purpose |
|---|---|---|
| `.get_str(key, default="")` | `(str, str) -> str` | Return answer as `str` |
| `.get_bool(key, default=False)` | `(str, bool) -> bool` | Return answer as `bool` |
| `.get_list(key, default=None)` | `(str, list\|None) -> list` | Return answer as `list` |
| `.get_choice(key, default="")` | `(str, str) -> str` | Return single-choice answer as `str` |
| `.get_multichoice(key, default=None)` | `(str, list\|None) -> list[str]` | Return multi-choice answer as `list[str]` |
| `.reconcile` | `bool` property | Whether this module runs in reconcile (overwrite) mode |
| `.mode` | `str` property | Run mode: `"init"` or `"reproduce"` |

`.mode` is useful for Tier-2 resolvers: skip network registry checks in
`"reproduce"` mode (pins were verified at init; reproduce is zero-network).

---

### `emit_result(result) -> None`

Print the module result as exactly one canonical JSON object to stdout.
Validates required keys, provenance values, and schema version. Raises
`SetupError(RESULT_SHAPE)` on a programming error in the result.

```python
sdk.emit_result(sdk.ModuleResult(
    module_id="my-module",
    step_id=args.step,
    status="ok",
    files_written=["path/to/file.txt"],
    diffs=[sdk.Diff(path="path/to/file.txt", kind="create", preview="...")],
))
```

**Do not print anything else to stdout** — the runner parses stdout as the
result JSON.

---

### `class ModuleResult`

The structured result a module emits via `emit_result`.

| Field | Type | Purpose |
|---|---|---|
| `module_id` | `str` | The module's own id |
| `step_id` | `str` | The step id (from `args.step`) |
| `status` | `str` | `"ok"` or `"error"` |
| `files_written` | `list[str]` | Repo-relative paths written (canonical key — NOT `files`) |
| `diffs` | `list[Diff]` | One `Diff` per proposed/applied filesystem change |
| `answers_to_persist` | `dict[str, dict]` | Key → `{"value": Any, "source": "derived"\|"agent-steered"}` |
| `warnings` | `list[str]` | Non-fatal messages surfaced to the user |
| `message` | `str` | Optional human-readable summary |
| `error` | `dict\|None` | Structured error payload on `status="error"` |

---

### `class Diff`

A single proposed or applied filesystem change.

```python
sdk.Diff(path="relative/path.txt", kind="create", preview="first few lines…")
```

`kind` is one of `"create"` / `"modify"` / `"skip"`.

---

### `idempotent_write(rel_path, body, *, project_dir=None, reconcile=False, inspect=False) -> Diff`

Write `body` to `rel_path` (relative to `project_dir`) idempotently.

- `reconcile=False` (default): write-if-absent — skip if the file exists.
- `reconcile=True`: overwrite to match — modify if content differs.
- `inspect=True`: produce the `Diff` preview WITHOUT writing (Tier-1 guarantee:
  the inspect diff is byte-identical to the real write).
- `project_dir` defaults to the `PROJECT_DIR` env var or `cwd()`.

Raises `SetupError(PATH_ESCAPE)` for unsafe paths (`..`, absolute, null bytes).

```python
diff = sdk.idempotent_write(
    "src/hello.py", "print('hello')\n",
    reconcile=inputs.reconcile, inspect=args.inspect,
)
```

---

### `merge_append_lines` — not yet available

This function is planned but not yet implemented. Use `append_if_absent` for
marker-based idempotent appends, or `idempotent_write` for whole-file writes.

---

### `run_tool(args, cwd, warnings, label, *, timeout=120) -> bool`

Run an external tool. Returns `True` on success. Appends a warning and returns
`False` if the tool is absent from PATH or exits non-zero. Never raises.

```python
ok = sdk.run_tool(["git", "init"], cwd=project_dir, warnings=warns, label="git init")
```

---

### `append_if_absent(path, marker, block, warnings, label) -> bool`

Append `block` to `path` if `marker` is not already present. Returns `True` if
appended, `False` if already present. Creates the file if absent. Never raises.

```python
sdk.append_if_absent(
    project_dir / ".gitignore", "# project-setup", "\n# project-setup\n*.pyc\n",
    warnings=warns, label="gitignore entry",
)
```

---

### `verify_pins(pins, ecosystem, *, timeout=10.0, _opener=None) -> dict[str, str]`

Verify each `name@version` pin against its package registry (PyPI or npm).
Returns a dict mapping each pin to one of:

| Constant | Value | Meaning |
|---|---|---|
| `sdk.PIN_VERIFIED` | `"verified"` | The exact version exists on the registry |
| `sdk.PIN_DISCONFIRMED` | `"disconfirmed"` | Registry answered; version absent/yanked/bad name |
| `sdk.PIN_UNREACHABLE` | `"unreachable"` | Registry unreachable (offline/timeout) |

```python
results = sdk.verify_pins(["requests@2.31.0", "httpx@0.27.0"], "pypi")
```

`ecosystem` must be `"pypi"` or `"npm"`. A pin with no explicit version
(`name` without `@version`) is always `DISCONFIRMED`. Disconfirmed pins must be
rejected (fail-closed); unreachable pins are reported and safe-skipped.

---

### `looks_like_secret(value) -> str | None`

Return a human label if `value` matches a known credential shape, else `None`.
Used by the interview/persist boundary (G8) to refuse persisting secrets.

```python
label = sdk.looks_like_secret(some_input)
if label:
    # refuse to use this value
```

---

### `scan_top_level_dirs(project_dir=None) -> frozenset[str]`

Return the set of top-level directory names directly under `project_dir`. No
recursion, no network. Missing/empty dir yields empty frozenset. Useful for
the AGENTS.md phantom-path guard (spec 006 FR-007).

---

### `detect_marketplaces(home=None) -> dict[str, list[str]]`

Return per-system marketplace names from offline registry files (no network).
Returns `{"apm": [...], "claude-code": [...], "codex": [...]}`. Missing files
yield empty lists. Call at interview time only — NOT at execute time (frozen
into answers for determinism).

---

### `is_safe_relative_path(p) -> bool`

Return `True` iff `p` is a safe relative path within a project directory
(no `..`, not absolute, no null bytes). Used by `idempotent_write` internally.

---

### `fetch_addon_catalog` — planned (Group B)

This function will be added in Group B (addon catalog). It fetches a catalog
JSON from a URL and returns a list of `{name, description, locator, category}`
records. Network failure / malformed / empty → `[]`, never raises.

---

## Standalone module testing

Run a module directly without the full pipeline (useful during development):

```bash
# Dry-run (inspect) — shows what would be written, nothing changes
uv run module.py --plan /path/to/frozen/plan.json --step <step-id> --inspect

# Real run
uv run module.py --plan /path/to/frozen/plan.json --step <step-id>
```

The `--plan` argument must point to a frozen `plan.json`. Generate one via:

```bash
cd /path/to/your/project
uv run /path/to/runner/cli.py --dry-run --non-interactive
# plan.json is written to ~/.cache/project-setup/plan.json by default
```

Or in tests, use `sdk.freeze(plan, path=tmp_path / "plan.json")` to write a
plan programmatically. See `tests/test_example_multi_step_python.py` for a
complete integration test pattern.

---

## Scaffolding a new module

Use the built-in scaffold to generate a starter module directory:

```bash
# Writes .project-setup/modules/<id>/ with module.toml, module.py, test_<id>.py
uv run /path/to/runner/cli.py --new-module my-module

# Custom destination directory
uv run /path/to/runner/cli.py --new-module my-module --new-module-dest /path/to/dir
```

The scaffold produces a valid `module.toml` (accepted by `parse_manifest` with
no errors), a minimal working `module.py`, and a test stub. Edit all three to
implement your module's logic.

**`default_enabled` is FORBIDDEN on non-bundled modules** (FR-035). The
scaffold omits it deliberately — never add it to an addon module.
