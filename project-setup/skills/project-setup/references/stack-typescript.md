# TypeScript stack

Asset set: `skill://project-setup/assets/lang/ts/`

## Asked

| Question | Default | Notes |
|---|---|---|
| Runtime version | `24` | Fills `@@NODE_VERSION@@` in `.mise/conf.d/ts.toml.template`. It is the local node a tool may shell out to; bun is what CI installs and what executes the recipes |
| Latest-stable bun version | exact value accepted during setup | Fills `@@BUN_VERSION@@` in `.mise/conf.d/ts.toml.template` and in the CI setup action, which pins setup-bun to the same value |

Nothing else. The tool set below is fixed, and the layout follows from what the
deployable does.

## Fixed

| Concern | Tool |
|---|---|
| Package manager and runtime | bun |
| Formatting and assists | biome |
| Linting | oxlint, type-aware |
| Tests | vitest |
| Types | tsc |
| Dead code | knip |

Type-aware oxlint is not a choice: it carries 59 of typescript-eslint's 61 rules against
biome's 4 outside nursery. It needs the `oxlint-tsgolint` executable as a dev dependency,
so `.oxlintrc.json` without that install reports nothing.

MUST Write `bunx <tool>`, never `bun exec <tool>`. `bun exec` is not a command.

## Apply order

1. `bun init` in the destination, or the framework's own generator, which writes
   `package.json` and the entry point.
2. Install the dev dependencies the config requires: `biome`, `oxlint`,
   `oxlint-tsgolint`, `vitest`, `typescript`, `knip`.
3. Read the exact installed `@biomejs/biome` version from `package.json`.
4. Copy the asset set and resolve `@@BIOME_VERSION@@`, `@@BUN_VERSION@@`, and the exact installed runtime versions.
   `biome.json` and `tsconfig.json` are SKIP when the generator already wrote them:
   its versions win, and this set contributes the fragments and CI jobs either way.
5. `just just-sync`, then `just hooks-merge`, then `just ci-sync`.

## Files

| Asset | Destination | Class |
|---|---|---|
| `biome.json.template` | `biome.json` | CREATE, or SKIP behind a generator |
| `tsconfig.json` | `tsconfig.json` | CREATE, or SKIP behind a generator |
| `.oxlintrc.json` | `.oxlintrc.json` | CREATE |
| `.just.d/ts.just` | `.just.d/ts.just` | CREATE |
| `.pre-commit.d/ts.yaml` | `.pre-commit.d/ts.yaml` | CREATE |
| `.gitignore.d/ts` | `.gitignore.d/ts` | CREATE |
| `.mise/conf.d/ts.toml.template` | `.mise/conf.d/ts.toml` | CREATE |
| `.github/actions/setup-ts/action.yml.template` | `.github/actions/setup-ts/action.yml` | CREATE |
| `.github/quality.d/ts.yml` | same path | CREATE |
| `.github/security.d/ts.yml` | same path | CREATE |
| `.github/workflows/wc-lint-ts.yml` | same path | CREATE |
| `.github/workflows/wc-test-ts.yml.template` | `.github/workflows/wc-test-ts.yml` | CREATE |
| `.gitlab/ci/ts.yml` | same path | CREATE on a GitLab forge, SKIP otherwise |

## Recipes it adds

`ts`, `ts-fmt`, `ts-lint`, `ts-types`, `ts-test`, `ts-dead`, `ts-cov`, `ts-install`.
`just check` finds `ts` by probing, so nothing aggregates it by hand.
