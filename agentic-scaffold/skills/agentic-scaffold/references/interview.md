# Interview

Load after `preflight` or when starting a greenfield run. The CLI emits the ordered questions;
`answers write` stores the answers in `.omp/scaffold-answers.toml` and creates the run marker.
Do not hand-edit either generated file.

## 1. Emit questions

```sh
python3 "$SCAFFOLD" interview questions --root R --profile P
```

The JSON has `root` and `questions`. Every question has `id`, `prompt`, `required`, `default`,
optional `allowed`, optional `multi`, optional `choices` (value plus one-line summary), and `source`.
Ask every question with the `ask` tool, in order; group related questions in one call. Never
silently accept a required question's default. Accept an optional default only when the
human explicitly says to use them.

Turning a question into an `ask` entry:

- `allowed` present: one option per allowed value, labelled with the value; put the `choices`
  summary in the option description. Mark the default as recommended.
- `multi: true`: set `multi: true` on the `ask` question so the human can pick several. When
  `allowed` has more than five values, split it across consecutive questions of at most five
  options each, all `multi: true`, and join every selection with commas for `--set id=a,b,c`.
- No `allowed`: offer the default plus one "type my own" path; the UI adds a free-text option.

Never invent combined options such as "agentic, hooks, tooling" as one choice; offer the layers
themselves.

Exit `0` means questions are available. Exit `1` is an operational error. Exit `6` is a root
boundary refusal.

## 2. Greenfield questions

The fixed set covers name and purpose, language, then kind. Kind is language-specific: Rust uses
`crate`, `tool`, or `hybrid`; Python uses `library` or `tool`; TypeScript uses `library`, `app`, or
`omp-plugin`; Go uses `library` or `tool`. In a monorepo, ask kind separately for every member after
the layout question. License, remote creation and visibility, beads, web UI, and SpecKit follow.
The CLI omits a question when an earlier answer decides it.

The `release` layer asks `publish`: `none`, `pypi`, `npm`, `crates`, or `github-assets`. The
default is the language's registry for a library and `none` for an application; the answer
selects the publish lane in `.github/workflows/release.yml`.
Do not ask framework, provider, or tool-version questions.

## 3. Brownfield questions

Confirm the detected profile, pick layers from the emitted catalogue (the default preselects the
profile's layers; the render skips existing files a layer owns and never replaces them), and resolve every emitted `finding:<kind>`. Findings include
unowned `.omp/*` files and ambiguous managed markers; a dirty work tree is never a question, it is
a preflight prerequisite. Ask the human which resolution
to use; do not turn a proposal into an answer without explicit approval.

Hook wiring is not a question. Preflight detects the hook manager (`hook_strategy` in its JSON)
and later stages chain through it; do not mention the strategy or ask about it unless the CLI
emits a `finding:hook-manager` question, which happens only when inspect found no manager.

## 4. Write approved answers

```sh
python3 "$SCAFFOLD" answers write --root R --profile P \
  --set name=NAME --set language=python --defaults-for ID,ID
```

Use one `--set key=value` for each answer. Add an id to `--defaults-for` only after explicit human
approval of that id's default. Read `root`, `ok`, `profile`, `layers`, `vars`, `defaults_for`,
`interviewed_at`, and `path`.

Exit `0` records the interview and creates `.omp/scaffold-run.json`. Exit `3` means at least one
a required id has no answer; call `ask` and retry. Exit `5` means the answers select conflicting
layers. Exit `6` means the root boundary refused the write. No later phase starts on exits `3`, `5`,
or `6`.

## 5. Workspace answers

When `layout` is `monorepo`, ask the bounded member set emitted by the CLI. Add approved members
with the `member` command, not by editing TOML:

```sh
python3 "$SCAFFOLD" member add --root R --name NAME --layer lang/python --kind app
```

Read `root`, `added`, `members`, and `path`. Stop when the human says the member list is complete.

## 6. Verb ordering

The direct `interview` verb emits ask pages in this order:

1. Layout and shape.
2. Members.
3. Project and member kinds.
4. Profile and layers.
5. License.
6. Documentation.
7. Publish target.
8. Layer variables.

The verb hides dependent questions until their answers appear in `--answers-so-far`.
Each page has at most five questions. Each option list has at most five entries.

## 7. Better-T-Stack questions

No `bts_*` question is visible until the human answers `language = ts`. On a `monorepo`
profile the only questions are `bts_layout` (`turborepo` or `none`) and `bts_package_manager`. On
an application profile the switch question `bts` comes first; `true` opens the generator questions
and `false` keeps the existing stack and renders governance, CI, release, hooks, and agent files
only. The switch defaults to `false` in a brownfield repository.

| Question | Default | Notes |
|---|---|---|
| `bts` | `true` greenfield, `false` brownfield | the switch; everything below waits for `true` |
| `bts_frontend` | `tanstack-router` | one web frontend and one native frontend at most |
| `bts_backend` | `hono` | `self` needs a full-stack frontend |
| `bts_runtime` | `bun` | `workers` needs `hono` |
| `bts_api` | `trpc` | `orpc` or `none` for Nuxt, Svelte, Solid, Astro |
| `bts_database` | `sqlite` | `mongodb` is rejected with `workers` |
| `bts_orm` | `drizzle` | |
| `bts_auth` | `better-auth` | |
| `bts_addons` | `turborepo` | `tauri` is forced on for `tauri-desktop`; hooks addons are excluded because the `hooks` layer owns hooks |
| `bts_package_manager` | `bun`; `pnpm` for a workspace | |
| `bts_docs` | `starlight` | Fumadocs is not offered: its generator prompt is interactive only |
| `bts_layout` | `turborepo` | workspace profile only |

A question with more accepted values than a page shows lists the rest in its text; the human
chooses `Other` and types the value. `answers write` and `preflight` refuse an answer set that breaks a
compatibility rule and name the rule. The generator writes only into an empty root.
