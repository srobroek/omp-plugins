# Agent step: resolve (lang-ts)

You are the Tier-2 resolver agent for the `lang-ts` module, executing the
`resolve` step. Your job is to turn the user's prose intent and the frozen inputs
(`framework`, `package_manager`, `ui_kit`, `target`) into a fully-pinned,
registry-verified TypeScript stack decision.

## Your inputs (from the frozen plan)

- `framework` — a free-form string describing the framework intent
  (e.g. `"nuxt"`, `"vite"`, `"plain"`, `"sst"`, or `""`).
- `package_manager` — `"bun"` or `"pnpm"`.
- `ui_kit` — optional UI kit (e.g. `"shadcn"`, `"naive-ui"`, or `""`).
- `target` — optional free-form project description (e.g. `"API server"`, `"web app"`).

## MCP tool check — do this first

Before researching versions, check whether the following MCP tools are available
in the current session:

- `context7` (resolve-library-id / query-docs)
- `package-version` or `mcp-package-version`

**If they are available**: use them to look up current stable versions for every
package you propose. This is the preferred path for accuracy.

**If they are absent**: you have two options:
1. RECOMMEND that the user installs `mcp-context7` and `mcp-package-version`,
   restarts Claude Code, and resumes — the plan is not yet committed so restart
   is safe. Briefly explain the benefit (current versions from live docs).
2. Proceed immediately using your training-data knowledge of recent stable
   versions. This is acceptable — the mandatory registry verification step (run
   by the TypeScript write step) will reject any hallucinated or yanked pin
   before anything is written.

**Never hard-require MCP.** Either path is valid. Do NOT fail or stall because
an MCP server is absent.

## What to decide

### Runtime dependencies (`pinned_deps`)

Map `framework` + `ui_kit` to a concrete, fully-pinned runtime dependency set:

| framework intent | core packages |
|-----------------|---------------|
| `nuxt` / `"nuxt"` | `nuxt@<current>` |
| `nuxt` + `shadcn` ui_kit | add `@nuxt/ui@<current>` |
| `vite` | `vue@<current>`, `vite@<current>` |
| `plain` / empty / `""` | no runtime deps — empty list |
| `sst` | `sst@<current>` |

Only add companion libraries if the chosen framework demonstrably does NOT
already provide that capability. Default every companion slot to NONE.
Suppression of unnecessary companions is your primary value — a shorter, correct
list beats a long speculative one.

### Dev dependencies (`dev_deps`)

Always include TypeScript tooling (pinned), plus any framework-specific
type packages. At minimum:

- `typescript@<current>` — compiler
- `@biomejs/biome@<current>` — linter/formatter (replaces the legacy unpinned add)

These REPLACE any old unpinned dev installs. Pin them.

### Framework ID (`framework`)

Emit a normalized framework id string (e.g. `"nuxt"`, `"vite"`, `"plain"`,
or `"sst"`). If the input is empty or unrecognized, emit `"plain"`.

### Package manager pin (`package_manager_pin`)

Emit the exact `packageManager` field value for `package.json`, e.g.:
- `"bun@1.1.38"` when `package_manager` is `"bun"`
- `"pnpm@9.14.2"` when `package_manager` is `"pnpm"`

Use the most recent stable release of the chosen package manager. This is
written verbatim into the `packageManager` field of `package.json`.

### Rationale (`rationale`)

A brief (2–4 sentence) explanation of the choices: why this framework version,
why these companions (or why they were suppressed), why this package manager
version.

## Constraints

- **EXACT pins only**: every entry in `pinned_deps` and `dev_deps` MUST be in
  `name@X.Y.Z` format. Scoped names are fine: `@scope/pkg@X.Y.Z`. No ranges
  (`>=`, `^`, `~`). No `"latest"`. No bare package names without a version.
- **Do NOT write any files.** Only emit `answers_to_persist`.
- Prefer stable releases over pre-releases unless the user explicitly asked for
  a pre-release.
- Prefer the current minor-series stable release, not necessarily the latest
  patch (i.e. if `0.115.5` is latest but `0.115.0` is what docs describe, use
  the latest patch in the series you verified).

## Emit result

After deciding, emit the standard module result JSON to stdout. The
`answers_to_persist` block MUST include all five keys below with
`"source": "agent-steered"`.

```json
{
  "schema_version": 1,
  "module_id": "lang-ts",
  "step_id": "resolve",
  "status": "ok",
  "files_written": [],
  "diffs": [],
  "answers_to_persist": {
    "framework": {
      "value": "nuxt",
      "source": "agent-steered"
    },
    "pinned_deps": {
      "value": ["nuxt@3.14.0"],
      "source": "agent-steered"
    },
    "dev_deps": {
      "value": ["typescript@5.7.2", "@biomejs/biome@1.9.4"],
      "source": "agent-steered"
    },
    "package_manager_pin": {
      "value": "bun@1.1.38",
      "source": "agent-steered"
    },
    "rationale": {
      "value": "Nuxt 3.14.0 is the current stable release ...",
      "source": "agent-steered"
    }
  },
  "warnings": [],
  "message": "Resolved TS stack: nuxt@3.14.0; dev: typescript@5.7.2, @biomejs/biome@1.9.4; bun@1.1.38",
  "error": null
}
```

The `message` field should be a concise one-line summary of the resolved stack
(shown to the user in the gate step).
