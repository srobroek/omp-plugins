# Module Authoring Guide

This directory contains copy-pasteable demonstrator modules. They live at
`examples/` — a sibling of `modules/` — so the runner's bundled-module
discovery (which roots at `modules/`) never picks them up as real modules.

---

## Directory shape

Every module lives in its own subdirectory:

```
<id>/
  module.toml      # manifest — parsed and validated by the runner
  module.py        # executable — invoked by: uv run module.py --plan ... --step ...
  templates/       # (optional) vendored file templates
  steering/        # (required for agent steps) steering docs consumed by Tier-2
  test_*.py        # (recommended) tests exercising the module in isolation
```

---

## module.toml schema (see [shared-contracts.md](shared-contracts.md) §1)

```toml
schema_version = "1.0"

[meta]
repository = "github.com/owner/repo"   # required
author     = "Your Name"               # required

[module]
id          = "my-module"              # required; <noun>-<verb> convention
name        = "My Module"             # required; human label
version     = "1.0.0"                 # required; semver
description = "One-line description." # required
reconcile   = false                   # required bool; true = overwrite-to-match
# default_enabled: optional bool; FORBIDDEN on non-bundled modules (FR-035)

[order]                                # all optional, default []
requires = ["core-identity"]           # hard dep: must be enabled + run before this
after    = ["dirs-scaffold"]           # soft ordering hint
before   = []                          # soft ordering hint

[tools]
required = ["git"]                     # missing tool → gate failure (MISSING_REQUIRED_TOOL)

# Input declarations drive the interview and are frozen into the plan.
# Valid types: string | text | int | bool | choice | multichoice | path | list
# (no "secret" type — secrets are out of scope)
[[inputs]]
key      = "language"
type     = "choice"
prompt   = "Primary language?"
choices  = ["python", "go", "rust"]
default  = "python"
required = false

# Steps are listed in execution order.
# kind=python  → uv run module.py --plan ... --step <id>
# kind=agent   → runner passes to a Tier-2 agent; requires steering="steering/<file>.md"
# kind=gate    → runner pauses and shows the message to the user; requires message="..."
[[steps]]
id   = "scaffold"
kind = "python"

[[steps]]
id      = "decide"
kind    = "agent"
steering = "steering/decide.md"

[[steps]]
id      = "confirm"
kind    = "gate"
message = "Review the generated files before continuing."
```

**FORBIDDEN fields** (→ `FORBIDDEN_FIELD` error at parse time): `priority`,
`title`, `entrypoint`, `required_answers`, `optional_answers`, `produces`,
`creates`, module-level `kind`. Unknown fields → `UNKNOWN_FIELD`.

---

## module.py contract

Every `module.py` follows this skeleton:

```python
# /// script
# requires-python = ">=3.11"
# dependencies = []      # stdlib only; add PEP 723 deps here if needed
# ///

import argparse, importlib.util, os, sys
from pathlib import Path

def _load_sdk():
    # Fast path: the executor puts the runner dir on PYTHONPATH (spec 005), so a
    # plain import works in production with zero boilerplate.
    try:
        import sdk
        return sdk
    except ModuleNotFoundError:
        pass
    # Fallback: load by file path for direct invocation outside the executor
    # (e.g. functional tests that run `uv run module.py` without PYTHONPATH).
    plugin_root = os.environ.get("PLUGIN_ROOT") or os.environ.get("CLAUDE_PLUGIN_ROOT")
    if plugin_root:
        sdk_path = Path(plugin_root) / "runner" / "sdk.py"
    else:
        sdk_path = Path(__file__).resolve().parents[2] / "runner" / "sdk.py"
    spec = importlib.util.spec_from_file_location("sdk", sdk_path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["sdk"] = mod   # register before exec_module (the fallback footgun)
    spec.loader.exec_module(mod)
    return mod

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--step", required=True)
    ap.add_argument("--inspect", action="store_true")
    args = ap.parse_args()

    sdk = _load_sdk()
    inputs = sdk.load_frozen_inputs(args.plan, module_id="my-module")

    # ... read inputs, write files ...

    sdk.emit_result(sdk.ModuleResult(
        module_id="my-module",
        step_id=args.step,
        status="ok",
        files_written=[],
        diffs=[],
    ))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

Key rules:
- **`import sdk` first, path-load fallback.** The `_load_sdk()` pattern above is
  the contract (spec 005): the executor puts the runner dir on `PYTHONPATH` so
  `import sdk` works in production; the `except` arm path-loads from
  `${PLUGIN_ROOT}/runner/sdk.py` (env var) or a `__file__`-relative fallback
  (`parents[2]/runner/sdk.py`) for direct invocation outside the executor.
- **Register before exec — in the fallback arm only.** `sys.modules["sdk"] = mod`
  must come before `spec.loader.exec_module(mod)` (the `@dataclass` on `SetupError`
  requires it). The fast `import sdk` arm is immune (normal import populates
  `sys.modules`).
- **stdout = one JSON object.** `sdk.emit_result(...)` prints exactly one
  canonical JSON object; do not print anything else to stdout.
- **Stdin/env are not input channels.** Read all inputs via `sdk.load_frozen_inputs`.

---

## Two tiers

| Tier | Step kind | Who runs it | Notes |
|------|-----------|-------------|-------|
| 1 | `python` | `uv run module.py` | Deterministic, offline-safe, testable end-to-end |
| 2 | `agent` | Runner hands to a Tier-2 LLM agent | Non-deterministic; `steering/` doc is the agent brief |

A single module can mix tiers: list python steps first, then agent steps.

---

## Adding a module

**Local root** — drop the directory under `.project-setup/modules/` in your
project (or `~/.config/project-setup/modules/` for a home-global module).
The runner discovers it automatically; it shadows any bundled module with the
same `id` at higher precedence.

**Git source** — add an entry to `.project-setup/sources.toml`:

```toml
[[source]]
locator = "https://github.com/my-org/my-modules.git"
ref     = "v1.0.0"
# subdir = "modules"   # optional: subdirectory within the repo containing modules
```

The correct top-level key is `[[source]]` (singular). The required field is
`locator` (a git URL or short `org/repo` form); `ref` must be an explicit tag
or SHA (unpinned sources are rejected — supply-chain safety). `subdir` is
optional.

Fetch happens **automatically** when the pipeline runs — there is no separate
fetch subcommand. Sources declared in `sources.toml` are fetched and their
modules discovered before the interview starts.

---

## How `--step` dispatch works (multi-step modules)

The runner invokes `module.py` once per python step:

```
uv run module.py --plan plan.json --step scaffold
uv run module.py --plan plan.json --step configure
```

`module.py` receives `args.step` and dispatches to the right handler. The
idiomatic pattern is a `STEP_HANDLERS` dict:

```python
STEP_HANDLERS = {
    "scaffold":  _do_scaffold,
    "configure": _do_configure,
}

def main() -> int:
    ...
    handler = STEP_HANDLERS.get(args.step)
    if handler is None:
        print(f"Unknown step: {args.step!r}", file=sys.stderr)
        return 1
    return handler(sdk, inputs, args)
```

See `examples/multi-step-python/` for a runnable demonstration.
