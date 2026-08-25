# Shared Contracts (Phase 0 — BLOCKING)

These are the frozen, authoritative shapes every subsystem imports or conforms
to. The coherence review proved the subsystems cannot compose until these are
fixed in one place. **No subsystem code may be written until this is merged.**
All shapes are owned by the runner library's `contracts.py` (the single source).

## 1. module.toml schema (Section I wins; FR-009 restated)

```toml
[meta]
repository = "github.com/owner/repo"   # required
author     = "name"                     # required

[module]
id          = "gitignore-generate"      # required; <noun>-<verb>; collision rules §7
name        = "Gitignore"               # required
version     = "1.0.0"                    # required
description = "..."                       # required
reconcile   = true                        # required bool
# default_enabled: OPTIONAL bool. Honored ONLY for first-party base modules.
# Set on a non-bundled module -> FORBIDDEN (FR-035). Tri-state Optional[bool].

[order]                                   # all optional, default []
requires = ["core-identity"]              # hard dep: must be enabled + precede
after    = ["dirs-scaffold"]              # soft
before   = []                             # soft

[tools]
required = ["git"]                        # missing -> validate-closed gate fails (MISSING_REQUIRED_TOOL)
                                          # graceful "try-then-fallback" lives in module.py, NOT here

[[inputs]]                                # declarations -> interview -> persisted answers
key      = "templates"
type     = "multichoice"                  # string|text|int|bool|choice|multichoice|path|list (NO secret)
prompt   = "Which .gitignore templates?"
choices  = ["macos","linux","python"]     # required for choice/multichoice
default  = ["macos","linux"]              # module-level default (lowest in F3 layering)
required = true

[[steps]]                                 # ordered; listed order = execution order
id   = "generate"
kind = "python"                           # python(Tier-1) | agent(Tier-2,+steering) | gate(+message)
# kind=agent  -> steering = "steering/<file>.md"
# kind=gate   -> message  = "..."
```

**FORBIDDEN fields** (→ `FORBIDDEN_FIELD` located error): `priority`, `title`,
`entrypoint`, `required_answers`, `optional_answers`, any `produces`/`creates`,
module-level `kind`. Unknown fields → `UNKNOWN_FIELD`. This is what makes
"no priority" (C3) *enforced*, not merely unread.

## 2. Frozen execution plan (one model: builder=manifest-validator, reader=SDK)

On-disk at `~/.cache/project-setup/plan.json` (NEVER under committed
`.project-setup/`). Serialized by the ONE canonical serializer:
`json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n"`.

```json
{
  "schema_version": 1,
  "mode": "init",
  "order": ["core-identity", "git-init", "dirs-scaffold", "..."],
  "modules": {
    "gitignore-generate": {
      "id": "gitignore-generate",
      "version": "1.0.0",
      "reconcile": true,
      "module_rel_root": "skills/project-setup/modules/gitignore-generate",
      "answers": { "templates": ["macos","linux"], "dynamic_fetch": false },
      "steps": [ {"id":"generate","kind":"python"} ]
    }
  }
}
```

Rules: NO absolute paths in any field a Tier-1 module reads (determinism —
`module_rel_root` is relative to plugin root). Answers are coerced ONCE before
freeze. A module reads ONLY its own `modules[<own-id>]` entry plus shared
identity/layout (exposed read-only).

## 3. Structured error envelope + codes (owned by contracts.py)

```python
@dataclass
class SetupError:
    error_code: str            # from ERROR_CODES
    module_id: str | None
    module_ids: list[str]      # for ID_COLLISION (2 paths) / DEPENDENCY_CYCLE (path)
    expected: str
    received: str
    how_to_fix: str            # actionable next step

ERROR_CODES = {
  "UV_MISSING", "ID_COLLISION", "DEPENDENCY_CYCLE", "MISSING_REQUIRES",
  "MISSING_ANSWER", "MISSING_REQUIRED_TOOL", "FORBIDDEN_FIELD", "UNKNOWN_FIELD",
  "INPUT_VALUE_INVALID", "MANIFEST_MALFORMED", "PLAN_MALFORMED", "RESULT_SHAPE",
  "PATH_ESCAPE", "FETCH_FAILED",
}
```

All three gates (validate-closed, module-entry, result) emit this. Always
machine-readable; `how_to_fix` always populated.

## 4. Module result JSON (the result gate validates this)

`module.py` prints EXACTLY ONE JSON object to stdout:

```json
{
  "schema_version": 1,
  "module_id": "gitignore-generate",
  "step_id": "generate",
  "status": "ok",
  "files_written": [".gitignore"],
  "diffs": [ {"path": ".gitignore", "kind": "create|modify", "preview": "..."} ],
  "answers_to_persist": { "templates": {"value": ["macos","linux"], "source": "derived"} },
  "warnings": [],
  "message": "",
  "error": null
}
```

Key name is **`files_written`** (not `files`). Modules emit provenance only from
`{default, derived, agent-steered}`; persistence assigns `flag|home|project`.
On `--inspect` the SAME shape is emitted with `files_written`/`diffs` populated
but NOTHING written (pre-write preview; Tier-1 guarantees inspect == real write).

## 5. Provenance enum (extended)

`{ default, flag, home, project, derived, agent-steered }`
- `default` — module manifest default
- `flag` / `home` / `project` — assigned by persistence (CLI flag / home config /
  committed answers.toml on re-run)
- `derived` — value the module computed at runtime (e.g. go module path from git
  remote)
- `agent-steered` — a Tier-2 agent decision

## 6. Module invocation + import contract

- Invocation: `uv run <module_rel_root>/module.py --plan <frozen> --step <id>`
  (+ `--inspect` for the dry pass). Module reads frozen inputs from disk; agent
  args are NEVER an input channel.
- SDK access (amended by spec 005): `module.py` resolves `sdk.py` via a two-arm
  `_load_sdk()`:
  1. **Fast path — `import sdk`.** The executor puts the runner dir on `PYTHONPATH`
     when it spawns the module, and `uv run` propagates `PYTHONPATH` into the PEP-723
     script's `sys.path` (verified, uv 0.11.8). So the production path is a plain
     package-import — zero importlib boilerplate, and `sys.modules` is populated by
     normal import machinery (the footgun below cannot occur on this arm).
  2. **Fallback — file-path load.** For invocation OUTSIDE the executor (functional
     tests run `uv run module.py` directly without setting PYTHONPATH), the `except
     ModuleNotFoundError` arm loads `sdk.py` by path from the `${PLUGIN_ROOT}` token
     (with a `__file__`-relative fallback). Still NOT a PyPI dep, NOT an editable
     install.
  - **The `sys.modules`-before-`exec_module` footgun applies ONLY to remaining
    file-path-load sites** (the fallback arm above AND the runner-internal
    `_load_sibling` in runner/*.py). At those sites you MUST register the loaded
    module in `sys.modules[name]` **before** `spec.loader.exec_module(mod)`, else
    `@dataclass` on any `Exception` subclass (e.g. `SetupError`) raises
    `AttributeError: 'NoneType' object has no attribute '__dict__'` (dataclasses
    resolves `cls.__module__` via `sys.modules[...].__dict__`). Verified in
    `tests/test_contracts.py::_load`. The fast `import sdk` arm is immune.
- Deps: PEP 723 inline metadata on `module.py`; `uv run` provisions per-module.

## 7. Discovery + collision rule (FR-011 vs FR-036)

Search precedence (highest wins): env `PROJECT_SETUP_MODULES_DIR` > project
`./.project-setup/modules/` > home `~/.config/project-setup/modules/` > fetched
sources > bundled `${PLUGIN_ROOT}/skills/project-setup/modules/`.

- Two modules with the same `id` **in the same root kind** → HARD `ID_COLLISION`
  error (names both paths via `module_ids`).
- Same `id` **across precedence levels** → reported shadow: higher precedence
  wins, the shadow is logged. (This is the only "override by id" path; otherwise
  override via config/answers.)
- `default_enabled=true` on a non-bundled module → `FORBIDDEN_FIELD` (FR-035).

## 8. Project file schemas

See [data-model.md](../data-model.md) for `.project-setup/sources.toml` and
`.project-setup/answers.toml` (per-module sections + parallel per-key
`[module.<id>.source]` provenance). Fetched bytes + frozen plan are gitignored
(home-global cache); only `sources.toml` + `answers.toml` are committed.
