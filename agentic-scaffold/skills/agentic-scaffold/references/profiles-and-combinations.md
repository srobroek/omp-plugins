# Profiles and combinations

LOAD when choosing a stack. `profiles list` and `layers show` are the source of current details.

| Case | Command |
|---|---|
| Python CLI | `render --profile python-app --var kind=cli` |
| Python service | `render --profile python-app --var beads=true` |
| TypeScript library | `render --profile ts-lib` |
| Bun web app with design stack | `render --profile ts-app --layer web-ui` |
| Rust CLI | `render --profile rust-app --var kind=cli` |
| Rust crate | `render --profile rust-lib` |
| Go service | `render --profile go-app` |
| Terraform estate | `render --profile terraform` |
| Agentic-only dotfiles/docs repo | `render --profile agentic-repo` |
| Brownfield agentic + hooks | `inspect`, then `answers write --profile agentic-repo`, then `render` |
| SpecKit project | any profile with `--var speckit=true` |
| Python and TypeScript members | `answers write --profile monorepo`, then `member add` for `lang/python` and `lang/ts` |
| Python members with Moon | `render --profile monorepo --layer moon` |
| Any profile with Worktrunk | `render --profile python-app --layer worktrunk` |

Mixed language members create one root manifest per family and share one root justfile.

`--layer NAME` appends one layer for a run and records it in `.omp/scaffold-answers.toml`. `--var` overrides profile and layer defaults for that run. `web-ui` may be enabled with `--var web_ui=true`.

Out of scope: docs sites, CDK, GitLab, and containers. Use `monorepo` for nested members.
