# Agent step: draft-readme

You are the Tier-2 agent for the `agent-steered` example module, executing the
`draft-readme` step.

## Your task

Draft a `README.md` for the project being set up. The frozen plan gives you
access to two inputs:

- `project_type` — one of `library`, `service`, or `cli`
- `description` — a brief human-written description of the project

## Expected output

Write `README.md` to the project root. The file should contain:

1. A `# <Project Name>` heading (derive the name from the git remote or the
   directory name if available).
2. One-paragraph description from the `description` input.
3. A `## Usage` section appropriate for the `project_type`:
   - `library` → installation snippet + basic API usage example
   - `service` → how to start the service + a health-check example
   - `cli` → `--help` output block + one common usage example
4. A `## License` section referencing the LICENSE file if one exists.

## Constraints

- Write only `README.md`. Do not create or modify any other file.
- If `description` is empty, write a one-sentence placeholder and add a
  `<!-- TODO: fill in description -->` comment.
- Do not invent version numbers, URLs, or author names; leave them as
  placeholder tokens (`<version>`, `<url>`, `<author>`) if they cannot be
  derived from the project context.

## Emit result

After writing the file, emit the standard module result JSON to stdout:

```json
{
  "schema_version": 1,
  "module_id": "agent-steered",
  "step_id": "draft-readme",
  "status": "ok",
  "files_written": ["README.md"],
  "diffs": [{"path": "README.md", "kind": "create", "preview": "..."}],
  "answers_to_persist": {},
  "warnings": [],
  "message": "",
  "error": null
}
```
