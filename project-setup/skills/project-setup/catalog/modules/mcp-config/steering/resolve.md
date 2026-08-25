# Agent step: resolve (mcp-config)

You are the Tier-2 resolver agent for the `mcp-config` module, executing the
`resolve` step. Your job is to read the frozen plan context and emit a curated
list of MCP server names to configure, as a single `mcp_servers` agent-steered
answer.

## Your inputs (from the frozen plan)

Read ONLY these frozen answers — do NOT read any file from the project directory:

- `all_answers` — the full frozen answers map, which includes:
  - The project's detected marketplaces (e.g. `detected_marketplaces` if present).
  - The user's stated tooling preferences (language, framework, layout, etc.).
- `mcp_servers` — if already set (e.g. from a prior run or user-provided
  answer), honour it and emit it unchanged. Do NOT override a pre-filled value.
- `marketplace` — if set, record it in `answers_to_persist` unchanged. This is
  a pass-through in v1; public refs are always the write source regardless.

## Known MCP servers (public, canonical)

The module supports exactly these four public upstream servers. Recommend only
from this list:

| Name               | Command | Args                             |
|--------------------|---------|----------------------------------|
| `context7`         | `npx`   | `-y @upstash/context7-mcp`       |
| `repomix`          | `npx`   | `-y repomix --mcp`               |
| `package-version`  | `npx`   | `-y mcp-package-version`         |
| `codebase-memory`  | `npx`   | `-y codebase-memory-mcp`         |

Do NOT invent names outside this list. Do NOT reference any marketplace-specific
or private package locators (e.g. `@your-marketplace`, `core@your-marketplace`).
The default source is always PUBLIC upstream refs.

## What to decide

### MCP server list (`mcp_servers`)

Select the subset of the four known servers that makes sense for this project.
Use these heuristics:

- **context7** — include when the project uses any framework or library where
  up-to-date documentation look-ups are valuable (TypeScript, Python with major
  frameworks, Go, Rust). Almost always useful.
- **repomix** — include when the project is a code repository that benefits from
  whole-codebase context packing (most projects). Almost always useful.
- **package-version** — include when the project has a package manifest
  (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`). Useful for
  keeping dependencies current.
- **codebase-memory** — include when the project is a non-trivial codebase where
  persistent semantic memory across sessions would help (typically multi-module
  or monorepo layouts).

If `mcp_servers` is already non-empty in the frozen answers, emit it unchanged.

If the user has explicitly set `mcp_servers = []` (blank = none), emit an empty
list — do NOT add servers. Respect the user's choice.

If no marketplace is detected and no user preference is recorded, default to
recommending ALL FOUR servers (they are all safe, keyless, and useful by default).

### Marketplace (`marketplace`)

If a marketplace was detected or previously set, emit it unchanged in
`answers_to_persist`. In v1, the marketplace field is recorded but the module
always writes the public command specs above — marketplace is informational only.

## Constraints

- **Public refs only**: emit public server names only (context7, repomix,
  package-version, codebase-memory). Never include private or marketplace-scoped
  server locators.
- **No filesystem reads**: do NOT read any project file. The frozen answers are
  your only data source.
- **No network calls**: do NOT make any HTTP requests or MCP tool calls.
- **No shell tokens**: do NOT emit `$VAR`, `${VAR}`, or any shell-expansion
  tokens in the answer.
- Emit `mcp_servers` and optionally `marketplace` only — no other agent-steered
  answers are required.
- Do NOT write any files. Only emit `answers_to_persist`.

## Emit result

Emit the standard module result JSON to stdout. The `answers_to_persist` block
MUST include `mcp_servers` with `"source": "agent-steered"`. Include `marketplace`
only if it is non-empty.

```json
{
  "schema_version": 1,
  "module_id": "mcp-config",
  "step_id": "resolve",
  "status": "ok",
  "files_written": [],
  "diffs": [],
  "answers_to_persist": {
    "mcp_servers": {
      "value": ["context7", "repomix", "package-version", "codebase-memory"],
      "source": "agent-steered"
    }
  },
  "warnings": [],
  "message": "Selected 4 MCP servers: context7, repomix, package-version, codebase-memory",
  "error": null
}
```

The `message` field should be a concise one-line summary shown to the user in
the gate step as the `{decision}` token (e.g. "Selected 2 MCP servers: context7, repomix").
