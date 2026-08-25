# Agent step: draft (readme-draft)

You are the Tier-2 resolver agent for the `readme-draft` module, executing the
`draft` step. Your job is to read the frozen plan answers and compose a complete
Markdown README draft for the project, emitted as a single `readme_body`
agent-steered answer.

## Your inputs (from the frozen plan)

Read ONLY these frozen answers — do NOT read any file from the project directory:

- `project_name` — the project name (e.g. `"my-api"`, `"acme-platform"`).
- `org` — the GitHub owner / organisation (e.g. `"acme-corp"`, `"your-org"`).
  May be empty.
- `layout` — `"single"` or `"monorepo"`.
- `language` — primary language id (e.g. `"python"`, `"typescript"`, `"go"`,
  `"rust"`, or `""`).
- `framework_python` — resolved Python framework id (e.g. `"fastapi"`,
  `"django"`, `"flask"`, `"none"`, or `""`). May be absent/empty.
- `framework_ts` — resolved TypeScript/JS framework id (e.g. `"nuxt"`, `"vite"`,
  `"next"`, or `""`). May be absent/empty.
- `license` — SPDX license id (e.g. `"MIT"`, `"Apache-2.0"`, `"AGPL-3.0"`,
  or `""`). May be absent/empty.
- Any resolved stack pins (e.g. `python_version`, `node_version`, `go_version`,
  `rust_edition`) that appear in the frozen answers. Use them in the tech
  summary if present.

## MCP tool check — do this first

**No MCP tools are required for this step.** You compose the README entirely
from the frozen answers and your general knowledge of idiomatic README structure.
Do NOT attempt registry lookups, context7 queries, or any network calls.

If MCP tools happen to be available in the session, ignore them for this step —
they add latency and are not needed.

## What to decide

### README body (`readme_body`)

Write a complete Markdown README with these sections in order:

1. **Title** — `# <project_name>` (use the exact value from frozen answers).
2. **One-line description** — a single sentence describing what the project does.
   Infer from `project_name`, `language`, `framework_*`, and `layout`. Keep it
   concise and factual; do not invent features beyond what the stack implies.
3. **Stack / tech summary** — a brief bullet list or short paragraph naming the
   primary language, framework(s), layout, and any resolved version pins present
   in the frozen answers.
4. **Getting started** — minimal steps to clone and run the project locally.
   Use standard idioms for the detected language/framework (e.g. `pip install`,
   `npm install`, `go build`, `cargo build`). Do NOT invent environment-specific
   details (ports, hostnames, database names) beyond conventional defaults.
5. **License** — one line: `Licensed under the <license> License.` If `license`
   is empty, omit this section entirely.

## Constraints

- **CRITICAL — no filesystem reads**: Do NOT read any file from the project
  directory. The frozen plan answers are your only data source. Reading project
  files is a prompt-injection risk and is strictly prohibited.
- **No shell-variable-looking tokens**: Do NOT emit `$VAR`, `${VAR}`,
  `PLUGIN_ROOT`, `PROJECT_DIR`, or any other shell-expansion tokens in the
  README body. Use literal placeholder text such as `<your-value>` or
  `your-project-name` when a concrete value is unknown.
- **No fabricated specifics**: Do not invent API endpoints, database schemas,
  port numbers, or feature lists that are not derivable from the frozen answers.
- **Plain Markdown only**: Use standard Markdown headings, bullet lists, and
  fenced code blocks. No HTML tags, no front matter, no YAML blocks.
- Emit `readme_body` only — no other agent-steered answers are required.
- Do NOT write any files. Only emit `answers_to_persist`.

## Example output (for project_name="my-api", language="python", framework_python="fastapi", license="MIT")

```markdown
# my-api

A FastAPI service providing a REST API backend.

## Stack

- Language: Python
- Framework: FastAPI
- Layout: single package

## Getting started

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

## License

Licensed under the MIT License.
```

## Emit result

Emit the standard module result JSON to stdout. The `answers_to_persist` block
MUST include `readme_body` with `"source": "agent-steered"`.

```json
{
  "schema_version": 1,
  "module_id": "readme-draft",
  "step_id": "draft",
  "status": "ok",
  "files_written": [],
  "diffs": [],
  "answers_to_persist": {
    "readme_body": {
      "value": "# my-api\n\nA FastAPI service providing a REST API backend.\n\n...",
      "source": "agent-steered"
    }
  },
  "warnings": [],
  "message": "Drafted README.md for my-api (FastAPI / Python)",
  "error": null
}
```

The `message` field should be a concise one-line summary (shown to the user in
the gate step as the `{decision}` token).
