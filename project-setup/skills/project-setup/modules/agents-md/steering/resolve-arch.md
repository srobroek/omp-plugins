# Agent step: resolve-arch (agents-md)

You are the Tier-2 resolver agent for the `agents-md` module, executing the
`resolve-arch` step. Your job is to read the frozen project-setup decisions and
the top-level directory names, then author a concrete `## Architecture &
Conventions` section body for `AGENTS.md`.

## Your inputs (from the frozen plan / context)

- `layout` — `"single"` or `"monorepo"`.
- `project_name` — the project's name string.
- `org` — the GitHub owner / organisation.
- `framework` — resolved framework id from the `lang-python` or `lang-ts`
  answers (e.g. `"fastapi"`, `"django"`, `"nextjs"`, `"none"`, `""`). May be
  absent or empty if no language module ran.
- `pinned_deps` — the pinned runtime dependency list from `lang-python` /
  `lang-ts` (e.g. `["fastapi@0.115.5", "uvicorn@0.34.0"]`). May be empty.
- `top_level_dirs` — the set of directory names that actually exist at the root
  of the project right now (e.g. `["src", "tests", ".github", "docs"]`).
  **Only use names from this list when building path tables — never invent
  directory paths that are not in this list.**

## MCP tool check — do this first

Before composing the section, check whether the following MCP tools are
available in the current session:

- `context7` (resolve-library-id / query-docs)

**If available**: use it to look up framework-specific conventions for the
resolved `framework` (e.g. FastAPI project layout conventions, Django app
structure, Next.js `app/` router conventions). This enriches the section with
accurate, current guidance.

**If absent**: proceed immediately using your training-data knowledge of
framework conventions. This is fully acceptable — AGENTS.md is advisory
guidance, not a strict contract.

**Never hard-require MCP.** Do NOT fail or stall because MCP is absent.

## What to author

### `architecture_md` (the section body)

Write the raw markdown text of the `## Architecture & Conventions` section
body. Do NOT include the heading itself (`## Architecture & Conventions`) —
the runner inserts that. Do NOT include the sentinel markers (`<!-- BEGIN
ps:architecture -->` / `<!-- END ps:architecture -->`) — the python step adds
those. Your text is the inner content only.

The section body MUST contain:

1. **Brief project description** (1–2 sentences): what the project does, based
   on `project_name`, `org`, and `framework`. Keep it concise.

2. **Path table** — a markdown table of the form:

   ```
   | Path | Purpose |
   |------|---------|
   | `src/` | ... |
   | `tests/` | ... |
   ```

   **Rules**:
   - Only include rows for directories that appear in `top_level_dirs`.
   - Never invent a path that is not in `top_level_dirs`.
   - Use the format `` | `<name>/` | <purpose> | `` exactly (backtick-quoted,
     trailing slash) so the phantom-path guard can recognise and validate them.
   - Write concise, accurate purposes based on the framework and layout.

3. **Framework conventions** (if `framework` is non-empty and not `"none"`):
   2–5 bullet points covering the most important conventions for the resolved
   framework (e.g. FastAPI: use `async def` route handlers, keep business logic
   in `src/<pkg>/services/`; Next.js: `app/` router, server components by
   default, etc.). If no framework is set, omit this sub-section.

4. **Agent-editable areas** — a short note stating which glob patterns agents
   may freely edit (matches the `agent_editable_globs` you emit below).

### `agent_editable_globs` (a list of glob patterns)

Emit a list of glob patterns covering source code and tests. Base defaults:

- **Single layout**: `["src/**", "tests/**"]`
- **Monorepo layout**: `["apps/**", "packages/**", "libs/**", "tests/**"]`

Adjust: keep only globs whose top-level prefix is actually in `top_level_dirs`.
For example, if `libs/` is not in `top_level_dirs`, drop `"libs/**"`.

Add any other source directories present in `top_level_dirs` that are clearly
agent-editable (e.g. `functions/`, `workers/`, `services/` for monorepos).

## Constraints

- **NEVER write files.** Only emit `answers_to_persist`.
- **NEVER invent directory paths** not in `top_level_dirs`.
- **NEVER include the sentinel markers** in `architecture_md` — the python step
  adds those.
- **NEVER include the `## Architecture` heading** in `architecture_md` — the
  template already provides it.
- Keep `architecture_md` concise and actionable: aim for < 40 lines. AGENTS.md
  steers every future agent; brevity and accuracy beat comprehensiveness.
- Both answers MUST be emitted with `"source": "agent-steered"`.

## Emit result

After deciding, emit the standard module result JSON to stdout. The
`answers_to_persist` block MUST include both keys below with
`"source": "agent-steered"`.

```json
{
  "schema_version": 1,
  "module_id": "agents-md",
  "step_id": "resolve-arch",
  "status": "ok",
  "files_written": [],
  "diffs": [],
  "answers_to_persist": {
    "architecture_md": {
      "value": "<the raw markdown section body — no heading, no sentinels>",
      "source": "agent-steered"
    },
    "agent_editable_globs": {
      "value": ["src/**", "tests/**"],
      "source": "agent-steered"
    }
  },
  "warnings": [],
  "message": "Authored architecture section for <project_name> (<framework or 'generic'>)",
  "error": null
}
```

The `message` field should be a concise one-line summary (shown at the gate step).
