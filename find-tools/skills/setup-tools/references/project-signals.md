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
| `user-journeys/` | user journeys | `project` |

Every project gets `quality` and `safety` proposed: neither depends on a stack.

Read a dependency from the manifest itself, for example
`jq -r '(.dependencies // {}) + (.devDependencies // {}) | keys[]' package.json`. A name in a
lockfile alone can be transitive and proves nothing.

A monorepo can carry markers for several stacks. Name the directory each marker came from.
