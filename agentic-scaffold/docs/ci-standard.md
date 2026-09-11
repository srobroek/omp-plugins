# CI and release standard

The standard the `ci/github` and `release` layers render. It is the norm across the 70
repositories active in September 2026, plus fixes for the gaps in the next section. Where a
repository differs, this document is the target and the repository is the outlier.

## Sources

| Pattern | Repositories |
|---|---|
| Fan-in `gate` with `needs` + `if: always()` + fail-closed predicate | slopvac `test.yml`, agentic-scaffold `ci.yml`, computer-says-no `CI OK`, esp-idf-smtp `ci-ok`, KiroCrew `Coverage Gate` |
| Independent parallel lanes per language and surface | omp-orchestrate (`ts`, `py`), ai-sde (`lint`, `typecheck`, `test`), Nightwatch crates (3-OS matrix) |
| `release-please` with a GitHub App token so release PRs trigger checks | omp-orchestrate, slopvac, agentic-packages, sabot |
| Publish only from the tagged tree, after verification | omp-autoclassifier (`bun run verify` on the tag), platevault `release-gate.yml`, prompting-press draft-then-finalize |
| PyPI trusted publishing in a protected environment | slopvac `publish-lint.yml` |
| npm trusted publishing (OIDC, no token) | omp-autoclassifier `release.yml` |
| crates.io trusted publishing | matinee, prompting-press, Nightwatch release workflows |
| GoReleaser with checksums | facc |
| SHA-pinned actions with version comments | slopvac, agentic-scaffold, computer-says-no, dotfiles |
| Security lane: zizmor, gitleaks, actionlint | dotfiles `test-chezmoi.yml`, slopvac `security.yml` |
| Renovate: automerge patch, minor, pin, digest after checks | omp-plugins, omp-orchestrate, agentic-packages |

Gaps the standard closes:

- no repository gated its publish job on the CI gate, only on the `release_created` output
- half the repositories with parallel jobs had no fan-in, so no stable required check
- most application repositories had no security lane
- action pins were mutable tags outside the mature repositories
- branch protection was configured almost nowhere

## Validation workflow: `.github/workflows/ci.yml`

Workflow header:

- triggers: `pull_request`, `push` to the default branch, `merge_group`
- permissions: `{}` at workflow level; each job elevates only what it needs
- concurrency: one group per workflow and pull request; superseded pull-request runs are canceled,
  default-branch and merge-group runs complete

Every lane is its own job. Each one:

- runs in parallel with the others
- has `timeout-minutes`
- checks out with `persist-credentials: false`
- references actions by commit SHA, with the version in a trailing comment

The selected layers decide which lanes exist:

| Lane | Rendered when | Steps |
|---|---|---|
| `python` | `lang/python` | `uv sync --frozen`, the profile's lint, fmt, check, test commands (Ruff check, Ruff format check, the type checker, pytest) |
| `typescript` | `lang/ts` | `bun install --frozen-lockfile`, Biome check, `tsc --noEmit`, `bun test`, the build |
| `rust` | `lang/rust` | `rust-cache`, `cargo fmt --all --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all-features`, `cargo doc --no-deps` |
| `go` | `lang/go` | `gofmt -l` empty, `go vet`, golangci-lint, `go test -race`, `govulncheck` |
| `terraform` | `lang/terraform` | `terraform fmt -check -recursive`, `terraform validate`, tflint |
| `hooks` | `hooks` | `uvx prek run --all-files`: the same hooks a commit runs locally |
| `agentic` | `agentic` | agentic lint over agents, skills, and rules; slopvac prose gate over documentation |
| `security` | always | actionlint, zizmor (offline), gitleaks |
| `gate` | always | the fan-in check, described under The gate |

The `changes` job always runs. It emits one boolean per lane from `dorny/paths-filter`. Global
files (`.github/**`, `mise.toml`, `justfile`, `.pre-commit-config.yaml`) set every boolean to true.
Each lane runs only when its boolean is true and is otherwise `skipped`.

## Release workflows

Two workflows, split so the version decision and the publish are separate events.

### `.github/workflows/release-please.yml`

On `push` to the default branch, one job runs `googleapis/release-please-action` with the
repository's `release-please-config.json` and manifest.

- Token: a GitHub App token when both `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY` exist;
  otherwise `GITHUB_TOKEN`, with a warning in the run log. Both are required for the App path.
  release PR authored with it has no CI gate.
- Merging the release PR creates the tag and the GitHub release; that event starts the publish
  workflow.

### `.github/workflows/release.yml`

On `release: published`, plus `workflow_dispatch` with `dry_run` (default `true`) for rehearsal.

`release-gate`:

- resolves the tag's commit
- needs a `gate` check run with conclusion `success` on that exact commit
  (`gh api .../commits/<sha>/check-runs?check_name=gate`)
- checks out the tag and runs the profile's check and test commands on the tagged tree
- fails the release on anything else, before any artifact exists

`build` (`needs: release-gate`):

- builds the distributable once: `uv build`, `bun run build` + `npm pack`, or
  `cargo package --locked`
- uploads it as a workflow artifact
- attests it with `actions/attest-build-provenance`

`publish-<registry>` (`needs: [release-gate, build]`, `environment: release`,
`permissions: id-token: write`):

- publishes the built artifact and nothing else
- exists only for the registry the interview selected

Publish lanes:

| Registry | Mechanism |
|---|---|
| PyPI | `pypa/gh-action-pypi-publish` with trusted publishing and `attestations: true`; no token secret |
| npm | Node 24, `npm publish --provenance --access public` with trusted publishing; no `NODE_AUTH_TOKEN` |
| crates.io | `rust-lang/crates-io-auth-action` then `cargo publish --locked`; workspaces publish members in dependency order |
| GitHub release assets (Go, CLIs) | GoReleaser against the tag with checksums; assets attached to the release that triggered the run |

When a registry publish needs a human, the `release` environment carries the reviewer. The
registry's trusted-publisher configuration names that environment, so renaming it breaks
publishing. `dry_run` builds and attests but publishes nowhere.

## Local parity

The lanes run the same commands as the `justfile` recipes and the prek hooks from the `hooks`
layer. A green `just check` therefore predicts a green `gate`. Tool versions come from the
project's `mise.toml`, and the workflows set up the same versions.

## Repository policy

The scaffold renders workflows and configuration; it does not change repository settings. The
matching policy, applied by a human or by the `github` layer when it exists:

- protect the default branch: the `gate` check and up-to-date branches are mandatory
- squash merges only, with the PR title as the commit subject in Conventional Commits form
- a `release` environment with a reviewer where a registry publish warrants one
- the registry's trusted publisher pointing at this repository, workflow, and environment
- Renovate with `config:recommended` and automerge for patch, minor, pin, and digest updates
  after the `gate` check
- Renovate's `github-actions` manager, so pinned action SHAs move with their version comments

## TypeScript applications

Better-T-Stack owns the application skeleton: the workspace manifest, `package.json`, `tsconfig.json`,
`turbo.json`, the frontend and backend packages, and `bts.jsonc`. The scaffold owns governance, CI,
release, hooks, and agent files. The TypeScript lane installs with the selected package manager and
runs `turbo run check-types build` when Turborepo is selected. The generator runs once, into an empty
target, with a pinned version and no install or git step. A repository that already has a stack keeps it.

## Attestation

The release workflow sets `permissions: {}` and elevates only the build job and the publish job. The
build job does these steps in order:

1. Generate an SBOM with `anchore/sbom-action`.
2. Attest the files with `actions/attest-build-provenance` and `actions/attest-sbom`.
3. Verify every release subject with `gh attestation verify <artifact> --repo <owner>/<repo>`.

Publication happens after step 3. Release and security jobs set `ACTIONS_CACHE_MODE` to `none`.
Repository settings: enable artifact attestations; give the `release` environment a reviewer.

## CodeQL

Set `ci_codeql=true` for public repositories. The scaffold derives the CodeQL matrix from the Python,
TypeScript, and Go layers. CodeQL has no Rust analyzer, so a Rust repository gets no CodeQL job.
Only the CodeQL job has `security-events: write`. Repository settings: enable code scanning with
CodeQL.

## Runner hardening

Set `ci_harden_runner=true` to make `step-security/harden-runner` the first step of every job, with
`egress-policy: audit`. After a few runs, read the audit log, allow the endpoints it lists, and
change the policy to `block` in the workflow.

## Tauri desktop release

The `tauri-desktop` profile builds Tauri v2 bundles for four targets:

- macOS arm64
- macOS x86_64
- Windows x86_64
- Linux x86_64

The build job publishes nothing until the end. Its order:

1. Sign the updater artifacts with `TAURI_SIGNING_PRIVATE_KEY`.
2. Generate an SBOM and attest the bundles.
3. Verify the attestations.
4. Upload the verified files to the release that release-please created.

A missing signing input fails the job. On macOS the job also requires the Apple certificate, identity,
and notarization account. A final job composes `latest.json` from the uploaded assets and their
`.sig` files and attaches it to the release. Set the updater endpoint in
`tauri.conf.json` to `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.

Set `tap_bump=true` to render the tap workflow; the default is false. On each published release it
reads the asset digests and edits two manifests:

- `Casks/<name>.rb` in `<owner>/homebrew-tap`
- `bucket/<name>.json` in `<owner>/scoop-bucket`

It opens a pull request in each repository with the release App token. Create both repositories and
install the release App on them.
