# Agent step: resolve (env-example)

You are the Tier-2 resolver agent for the `env-example` module, executing the
`resolve` step. Your job is to map the frozen stack inputs (`framework_python`,
`framework_ts`, `extra_env_hints`) to a structured list of environment variable
definitions for `.env.example`.

## Your inputs (from the frozen plan)

- `framework_python` — the resolved Python framework id (e.g. `"fastapi"`,
  `"django"`, `"flask"`, `"none"`, or `""`). May be empty if no Python overlay
  is enabled.
- `framework_ts` — the resolved TypeScript/JS framework id (e.g. `"nuxt"`,
  `"vite"`, `"next"`, or `""`). May be empty if no TS overlay is enabled.
- `extra_env_hints` — a freeform comma-separated string of additional env var
  names the user wants to include (e.g. `"STRIPE_API_KEY, SENDGRID_API_KEY"`).
  Use this as a hint, not an override — normalize each name to `SCREAMING_SNAKE_CASE`
  and add it to the list with an appropriate placeholder and `secret_bool`.

## MCP tool check — do this first

**No MCP tools are required for this step.** You derive env var names
entirely from your framework knowledge and the frozen inputs. Do NOT attempt
registry lookups, context7 queries, or any network calls. This step is
deliberately offline.

If MCP tools happen to be available in the session, ignore them for this step
— they add latency and are not needed.

## What to decide

### Env var list (`env_keys`)

Build a list of env var definitions for the project. Follow these rules:

**1. Python framework vars** (only if `framework_python` is non-empty):

| Framework | Vars to include |
|-----------|-----------------|
| `django` | `SECRET_KEY` (secret), `DEBUG` (non-secret), `ALLOWED_HOSTS` (non-secret), `DATABASE_URL` (non-secret) |
| `fastapi` | `DATABASE_URL` (non-secret), `SECRET_KEY` (secret), `DEBUG` (non-secret) |
| `flask` | `SECRET_KEY` (secret), `DEBUG` (non-secret), `DATABASE_URL` (non-secret) |
| `none` / `""` | No framework-derived vars from this input |

**2. TypeScript/JS framework vars** (only if `framework_ts` is non-empty):

| Framework | Vars to include |
|-----------|-----------------|
| `nuxt` | `NUXT_PUBLIC_API_BASE` (non-secret), `NUXT_SECRET` (secret) |
| `vite` | `VITE_API_BASE_URL` (non-secret), `VITE_APP_TITLE` (non-secret) |
| `next` / `nextjs` | `NEXT_PUBLIC_API_URL` (non-secret), `NEXTAUTH_SECRET` (secret), `NEXTAUTH_URL` (non-secret) |
| `none` / `""` | No framework-derived vars from this input |

**3. Extra env hints** (from `extra_env_hints`):
- Split on commas, trim whitespace from each item.
- Normalize each item to `SCREAMING_SNAKE_CASE` (uppercase, replace spaces/hyphens with underscores).
- Skip items that are empty after normalization.
- For names containing common patterns (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`,
  `PASS`, `CREDENTIAL`), set `secret_bool = true`. Otherwise `secret_bool = false`.
- If `secret_bool = true`, use `"your-<name-lower>-here"` as the placeholder.
  If `secret_bool = false`, use `"your-<name-lower>-here"` or a contextual example.

**4. Deduplication**: deduplicate by `name` (case-insensitive). If the same
name appears from multiple sources, keep the first occurrence.

**5. Placeholder rules** — this is the safety invariant:
- Every `placeholder` MUST be a non-empty descriptive token string.
- Use patterns like `"your-secret-key-here"`, `"postgres://user:pass@localhost/db"`,
  `"http://localhost:3000"`, `"true"`, `"debug"`.
- NEVER use a real API key, token, password, or credential shape.
- NEVER use version ranges, semver strings, or file paths as placeholders.
- NEVER leave `placeholder` empty (use `"your-value-here"` as fallback).

**6. Comment rules**:
- For `secret_bool = true`: `"Rotate before committing to production"`.
- For `secret_bool = false`: a brief description of what the var controls.

## Example output

For `framework_python = "fastapi"`, `framework_ts = ""`, `extra_env_hints = ""`:

```json
[
  {"name": "DATABASE_URL", "placeholder": "postgres://user:pass@localhost/db", "comment": "Database connection string", "secret_bool": false},
  {"name": "DEBUG", "placeholder": "true", "comment": "Enable debug mode (set to false in production)", "secret_bool": false},
  {"name": "SECRET_KEY", "placeholder": "your-secret-key-here", "comment": "Rotate before committing to production", "secret_bool": true}
]
```

## Constraints

- Emit `env_keys` only — no other agent-steered answers are required.
- Do NOT write any files. Only emit `answers_to_persist`.
- Names MUST be `SCREAMING_SNAKE_CASE` (uppercase letters, digits, underscores;
  must start with a letter: `^[A-Z][A-Z0-9_]*$`).
- If both `framework_python` and `framework_ts` are empty AND `extra_env_hints`
  is empty, emit an empty list `[]` — this is correct and not an error.

## Emit result

Emit the standard module result JSON to stdout. The `answers_to_persist` block
MUST include `env_keys` with `"source": "agent-steered"`.

```json
{
  "schema_version": 1,
  "module_id": "env-example",
  "step_id": "resolve",
  "status": "ok",
  "files_written": [],
  "diffs": [],
  "answers_to_persist": {
    "env_keys": {
      "value": [
        {"name": "DATABASE_URL", "placeholder": "postgres://user:pass@localhost/db", "comment": "Database connection string", "secret_bool": false},
        {"name": "DEBUG", "placeholder": "true", "comment": "Enable debug mode (set to false in production)", "secret_bool": false},
        {"name": "SECRET_KEY", "placeholder": "your-secret-key-here", "comment": "Rotate before committing to production", "secret_bool": true}
      ],
      "source": "agent-steered"
    }
  },
  "warnings": [],
  "message": "Resolved 3 env vars for .env.example: DATABASE_URL, DEBUG, SECRET_KEY",
  "error": null
}
```

The `message` field should be a concise one-line summary listing the var names
(shown to the user in the gate step).
