# Agent step: resolve (ci-github-actions)

You are the Tier-2 resolver agent for the `ci-github-actions` module, executing
the `resolve` step. Your job is to synthesize a complete GitHub Actions CI plan
(`ci_plan`) sized to the project's **actual** resolved stack — one job per active
language overlay, matrix entries trimmed to pinned runtime versions, and action
refs pinned to their **current major** (`owner/repo@vN`).

## Your inputs

### From `context["answers"]` — this module's own answers

- `ci_trigger` — list of GitHub event triggers (e.g. `["push", "pull_request"]`).
- `default_branch` — the branch name for the push-trigger filter (e.g. `"main"`).

### From `context["all_answers"]` — cross-module resolved stack

Read these keys from the sibling modules' answers to size the CI plan:

| Key path | Meaning |
|----------|---------|
| `all_answers["lang-python"]["python_version"]` | Frozen Python version (e.g. `"3.13"`). Present only when `lang-python` is enabled. |
| `all_answers["lang-python"]["framework"]` | Framework id (`"fastapi"`, `"django"`, `"none"`, …). |
| `all_answers["lang-ts"]["package_manager"]` | JS package manager (`"bun"` or `"pnpm"`). Present only when `lang-ts` is enabled. |
| `all_answers["lang-ts"]["framework"]` | TS framework id (`"react"`, `"next"`, `"none"`, …). |
| `all_answers["lang-go"]["go_version"]` | Frozen Go version. Present only when `lang-go` is enabled. |
| `all_answers["lang-rust"]["rust_channel"]` | Rust channel (`"stable"`, `"nightly"`). Present only when `lang-rust` is enabled. |
| `all_answers["justfile-write"]["use_just"]` | Boolean — whether a justfile exists. If `true`, CI commands should use `just <recipe>`. |

A key path that does not exist in `all_answers` means that module is **not enabled** — do not
generate a job for it.

## MCP tool check — do this first

Before researching action versions, check whether these MCP tools are available:

- `context7` (`resolve-library-id` / `query-docs`)
- `whats-new` or `mcp-whats-new`

**If available**: use them to confirm the current major version for each action
ref you emit. This is the preferred path for accuracy.

**If absent**: use your training-data knowledge of current stable action majors.
This is acceptable — action refs are persisted in `answers.toml` so drift from
"v4 became v5" is a deliberate `--refresh ci-github-actions`, not a silent change.

**Never hard-require MCP.** Either path is valid.

## What to decide

### `ci_plan_jobs` — list of job IDs

Emit exactly one job ID per active language overlay:

| Active overlay | Suggested job ID |
|----------------|-----------------|
| `lang-python` | `"test-python"` |
| `lang-ts` | `"test-ts"` |
| `lang-go` | `"test-go"` |
| `lang-rust` | `"test-rust"` |

If **no** lang-* overlay is active but `use_just=true`, emit a single `"lint"` job.
If neither, emit an empty list — the python write step handles the zero-jobs case.

Example (Python + TS active):
```json
["test-python", "test-ts"]
```

### `ci_plan_action_refs` — list of pinned action refs

List every GitHub Actions action you reference in the workflow, in
`owner/repo@vN` form (current major, integer `N`). Do NOT emit:
- Floating refs: `@main`, `@master`, `@latest`
- Version ranges: `@v4.*`, `>=v4`
- Bare names without a ref

Common actions and their **current majors** (verify with MCP if available):

| Action | Current major |
|--------|--------------|
| `actions/checkout` | `@v4` |
| `actions/setup-python` | `@v5` |
| `astral-sh/setup-uv` | `@v5` |
| `actions/setup-node` | `@v4` |
| `oven-sh/setup-bun` | `@v2` |
| `actions/setup-go` | `@v5` |
| `dtolnay/rust-toolchain` | `@v1` |

Include only the actions you actually use.

Example:
```json
["actions/checkout@v4", "astral-sh/setup-uv@v5", "actions/setup-python@v5"]
```

### `ci_plan_matrix` — runtime matrix as a JSON string

A JSON-encoded list of `{"lang": "<id>", "version": "<frozen_version>"}` objects,
one per active language overlay. Use the **frozen** version from `all_answers` —
do NOT invent versions or add extra entries for untargeted versions.

If no lang-* overlay is active, emit `"[]"`.

Example (Python 3.13 + TS with bun):
```json
"[{\"lang\": \"python\", \"version\": \"3.13\"}, {\"lang\": \"ts\", \"pm\": \"bun\"}]"
```

Keep the matrix minimal — one entry per language. A single-version matrix is the
anti-goal of over-broad matrices that burn CI minutes.

### `ci_plan_commands` — flat list of command strings

A flat list of all commands that will appear in the workflow steps, across all
jobs. Format: one string per command. If `use_just=true`, prefer `just <recipe>`
commands (e.g. `just test`, `just lint`). If `use_just=false` or absent, emit bare
tool commands (e.g. `uv run pytest`, `bun test`).

The python write step validates each command against the on-disk justfile and
package.json. Use only standard justfile recipes (`test`, `lint`, `build`,
`dev`, `clean`) unless the user has custom recipes.

Example (Python, use_just=true):
```json
["just test", "just lint"]
```

Example (Python, use_just=false):
```json
["uv run pytest", "uv run ruff check ."]
```

## Constraints

- **`owner/repo@vN` only.** Every action ref MUST end with `@vN` where `N` is
  a decimal integer. No floating refs, no ranges, no `latest`.
- **One job per active overlay.** Do NOT add gratuitous jobs for languages not in
  the frozen answer set.
- **Minimal matrix.** One version entry per language — the frozen pin is the
  source of truth.
- **Do NOT write any files.** Only emit `answers_to_persist`.
- **Do NOT emit `ci_plan_*` keys with `null` values.** Omit a key if it has no
  meaningful value (the python step defaults gracefully).

## Emit result

After deciding, emit the standard module result JSON to stdout. All
`answers_to_persist` keys MUST use `"source": "agent-steered"`.

```json
{
  "schema_version": 1,
  "module_id": "ci-github-actions",
  "step_id": "resolve",
  "status": "ok",
  "files_written": [],
  "diffs": [],
  "answers_to_persist": {
    "ci_plan_jobs": {
      "value": ["test-python"],
      "source": "agent-steered"
    },
    "ci_plan_action_refs": {
      "value": ["actions/checkout@v4", "astral-sh/setup-uv@v5", "actions/setup-python@v5"],
      "source": "agent-steered"
    },
    "ci_plan_matrix": {
      "value": "[{\"lang\": \"python\", \"version\": \"3.13\"}]",
      "source": "agent-steered"
    },
    "ci_plan_commands": {
      "value": ["just test", "just lint"],
      "source": "agent-steered"
    }
  },
  "warnings": [],
  "message": "CI plan: 1 job (test-python), matrix [python 3.13], actions/checkout@v4 + astral-sh/setup-uv@v5",
  "error": null
}
```

The `message` field should summarize the plan (job count, languages, key action refs).
