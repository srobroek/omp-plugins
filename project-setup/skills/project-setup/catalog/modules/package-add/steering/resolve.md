# Agent step: resolve (package-add)

You are the Tier-2 resolver agent for the `package-add` module, executing the
`resolve` step. Your job is to decide the fully-pinned dependency set for a NEW
monorepo package, aligning with already-frozen sibling pins wherever the same
package appears (Decision D — no re-research of frozen pins).

## Your inputs (from the frozen plan)

- `name` — the new package name (e.g. `"workers"`, `"api"`).
- `lang` — the language (`"python"`, `"ts"`, `"go"`, `"rust"`).
- `dir` — the parent packages directory (e.g. `"packages"`).
- `context["all_answers"]` — a read-only view of every answer already frozen by
  modules that ran before this one. Use this to align pins with siblings.

## Step 1: read sibling pins from all_answers (FR-004)

Before researching ANY version, read `context["all_answers"]` for these keys:

```
all_answers.get("lang-python", {}).get("pinned_deps", [])   # e.g. ["fastapi@0.111.0","pydantic@2.7.1"]
all_answers.get("lang-ts",     {}).get("pinned_deps", [])   # e.g. ["next@14.2.0","react@18.3.0"]
```

Build a **sibling index**: a mapping of `package_name → exact_version` from those
frozen lists. Package names are normalized to lowercase with `-` → `_`.

**Alignment rule**: if the new package requires a package whose name is already in
the sibling index, you MUST use the EXACT frozen version from the sibling index.
Do NOT re-research that version. Do NOT propose a newer release.

No siblings present (sibling index empty) → proceed with fresh resolution (same
as lang-python/lang-ts resolver steps).

**Conflict**: if the new package requires an INCOMPATIBLE version (e.g. a direct
dependency that itself requires a minimum higher than the frozen sibling pin) →
flag the conflict in `rationale` and propose the minimum compatible version with
a clear explanation. You cannot silently change a frozen sibling pin.

## Step 2: decide the manifest type and pinned deps

| lang     | manifest file   | package format        |
|----------|-----------------|-----------------------|
| python   | pyproject.toml  | `name@X.Y.Z`          |
| ts       | package.json    | `name@X.Y.Z`          |
| go       | go.mod          | `module@vX.Y.Z`       |
| rust     | Cargo.toml      | `name@X.Y.Z`          |

### Rules

- **EXACT pins only**: every entry in `pinned_deps` MUST be `name@X.Y.Z`.
  No ranges (`>=`, `~=`, `^`). No `"latest"`. No bare names without a version.
- **Align first**: use sibling frozen versions where the package appears.
- **Fresh for new packages**: if a package is not in the sibling index, research
  the current stable version using MCP tools (context7, package-version) if
  available; otherwise use training-data knowledge (the mandatory registry
  verification step will catch hallucinated pins).
- **Go/Rust note**: registry verification (`verify_pins`) is NOT run for go/rust
  (OQ-4 deferred). Propose reasonable stable versions; the gate message will note
  that verification was skipped.
- **Empty deps**: if the new package has no runtime dependencies, emit
  `pinned_deps: []` — this is valid.

## Step 3: decide the framework

Emit a normalized `framework` id (e.g. `"fastapi"`, `"nextjs"`, `"none"`), or
`"none"` if no framework applies. This is used to label the manifest.

## MCP tool check

Before researching non-sibling versions, check whether the following MCP tools
are available:

- `context7` (resolve-library-id / query-docs)
- `package-version` or `mcp-package-version`

If available: use them for non-sibling package versions.
If absent: use training-data knowledge. The gate step lets the human review
before any write occurs.

**Never hard-require MCP.** Either path is valid.

## What to emit

Emit the standard module result JSON to stdout. The `answers_to_persist` block
MUST include all five keys below with `"source": "agent-steered"`.

```json
{
  "schema_version": 1,
  "module_id": "package-add",
  "step_id": "resolve",
  "status": "ok",
  "files_written": [],
  "diffs": [],
  "answers_to_persist": {
    "framework": {
      "value": "<framework-id, e.g. fastapi or none>",
      "source": "agent-steered"
    },
    "pinned_deps": {
      "value": ["fastapi@0.111.0", "pydantic@2.7.1"],
      "source": "agent-steered"
    },
    "package_manifest_type": {
      "value": "pyproject.toml",
      "source": "agent-steered"
    },
    "rationale": {
      "value": "Aligned fastapi@0.111.0 + pydantic@2.7.1 with sibling lang-python pins (packages/api). No conflicts.",
      "source": "agent-steered"
    }
  },
  "warnings": [],
  "message": "Resolved package-add stack: fastapi@0.111.0 + pydantic@2.7.1 (aligned with sibling pins)",
  "error": null
}
```

The `message` field should be a concise one-line summary shown to the user in the
gate step. Mention sibling alignment if it occurred.

## Constraints recap

- Do NOT write any files. Only emit `answers_to_persist`.
- Do NOT re-research already-frozen sibling pins — use the exact frozen versions.
- Do NOT propose ranges, `latest`, or bare names without a version.
- For conflicts: flag in rationale, do not silently change sibling pins.
- For go/rust: note in rationale that registry verification is skipped (OQ-4).
