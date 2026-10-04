# Project signals

Map files the project actually contains to the capability they prove, and to the tier 1
package that covers it. A capability with no marker is not proposed.

| Marker | Capability | Tier 1 package |
|---|---|---|
| `package.json`, `tsconfig.json` | TypeScript and JavaScript | `typescript` |
| `pyproject.toml`, `uv.lock` | Python | `python` |
| `Cargo.toml` | Rust | `rust` |
| `tauri.conf.json` | Tauri desktop app | `rust` |
| `go.mod` | Go | `go` |
| a `react`, `vue`, `svelte`, `next`, `astro`, or `vite` dependency | rendered UI | `design` |
| `.beads/` | Beads ledger | `beads` |
| `.specify/` | SpecKit | `speckit` |
| `release-please-config.json` | release automation, pull-request delivery | `delivery` |
| `.chezmoiroot`, `.chezmoi.toml.tmpl` | chezmoi source | `chezmoi` |
| `.config/wt.toml`, `.worktreeinclude` | Worktrunk worktrees | `worktrunk` |
| `renovate.json`, `.github/dependabot.yml` | dependency updates | `dep-update` |
| `user-journeys/` | user journeys | `journeys` |

Every project gets `quality` and `safety` proposed: neither depends on a stack.

Read a dependency from the manifest itself, for example
`jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys[]' package.json`. A name in a
lockfile alone can be transitive and proves nothing.

A monorepo can carry markers for several stacks. Name the directory each marker came from.

## Greenfield intents

With no stack marker, ask which of these the project will be. Several can apply. Each row
adds its tier 1 packages; the tier 3 query runs only if the user widens the search.

| Intent | Tier 1 packages | Language question | Tier 3 query |
|---|---|---|---|
| Frontend web app | `typescript`, `design` | none: TypeScript | none |
| Full stack | `typescript`, `design`, `toolchain`, `architecture` | backend language, when not TypeScript | none |
| Backend service | `toolchain`, `architecture` | TypeScript, Python, Go, or Rust | none |
| API | `toolchain`, `architecture` | TypeScript, Python, Go, or Rust | `openapi` |
| AWS or cloud infrastructure | `toolchain` (Terraform and infrastructure rules) | none | `aws` |
| AI/ML | `python` | none: Python | the model provider or framework named |
| CLI | `toolchain` | Go, Rust, Python, or TypeScript | none |
| Desktop app | `rust` (Tauri), `design` | none: Rust with a TypeScript frontend | none |
| Library or package | `delivery` | the package's language | none |
| Docs or content | `authoring` | none | none |

Add the language package for each answer: `typescript`, `python`, `go`, or `rust`. Also ask
whether the project will track work in Beads and deliver through pull requests; each yes
adds `beads` or `delivery`.
