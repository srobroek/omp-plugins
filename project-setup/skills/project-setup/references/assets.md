# Asset library

Static files under `skill://project-setup/assets/` are copied into a target repository. Use
`cp` for a non-template asset. For a `.template` asset, copy it first, then change only the
declared tokens and optional blocks against the accepted plan. Never recreate, shorten, or
rewrite an asset with a generated body.
MUST Treat a copied script or configuration file whose body differs from its source as an apply
failure. Repository-specific simplification is not an allowed transform.

## Naming

| Filename ends in | Meaning |
|---|---|
| `.template` | Carries at least one token or optional block. Remove `.template` at the destination. |
| anything else | Copy byte for byte. |

A token is `@@UPPER_SNAKE@@`. `${{ ... }}`, `{{ name }}` inside a Just body, and
`{{ branch | hash_port }}` in `wt.toml` belong to their host tools and remain literal.

MUST leave no `@@` sequence in an applied file. A plan row still holding one is not ready.

## Optional blocks

A block fenced by `# OPTIONAL BEGIN <condition> -- <what to delete>` and
`# OPTIONAL END` is kept only when the accepted condition holds. Existing optional blocks
cover self-hosted Worktrunk settings, dev servers, excluded hook paths, commit-scope choices,
and language layout choices.

## Token catalog

| Token | Source |
|---|---|
| `@@PROJECT_NAME@@` | repository and hosting topic |
| `@@DESCRIPTION@@` | repository and hosting topic |
| `@@INSTALL_COMMANDS@@` | accepted runtime and package-manager install commands |
| `@@USAGE_EXAMPLE@@` | accepted minimal invocation for the primary deployable or package |
| `@@ORG@@` | repository and hosting topic |
| `@@REPO_URL@@` | accepted remote; omit its optional block when no remote exists |
| `@@SPDX_ID@@` | selected licence |
| `@@DEFAULT_BRANCH@@` | repository and hosting topic |
| `@@JOB_TIMEOUT_MINUTES@@` | repository and hosting topic |
| `@@FORGE_PLATFORM@@` | repository and hosting topic; only `github` or `gitlab` is supported |
| `@@FORGE_HOSTNAME@@` | repository and hosting topic, self-hosted forge only |
| `@@SETUP_COMMAND@@` | delivery and tooling topic |
| `@@DEV_COMMAND@@` | delivery and tooling topic, dev server only |
| `@@HOOK_EXCLUDE_PATTERNS@@` | delivery and tooling topic, joined with `\\|` |
| `@@MAX_FILE_KB@@` | delivery and tooling topic |
| `@@COMMIT_SCOPES@@` | delivery and tooling topic, joined with `,` |
| `@@CODEOWNER@@` | accepted owner or team |
| `@@SECURITY_CONTACT@@` | accepted private security channel, or the supported forge form |
| `@@CODE_OF_CONDUCT_CONTACT@@` | accepted reporting contact; required when the optional file is kept |
| `@@BIOME_VERSION@@` | exact installed `@biomejs/biome` version |
| `@@NODE_VERSION@@` | TypeScript stack |
| `@@PYTHON_VERSION@@` | Python stack |
| `@@PYTHON_VERSION_NODOT@@` | Python stack, `3.13` becomes `313` |
| `@@GO_VERSION@@` | Go stack |
| `@@BUN_VERSION@@` | exact latest-stable `bun` value accepted and resolved during setup |
| `@@UV_VERSION@@` | exact latest-stable `uv` value accepted and resolved during setup |
| `@@GOLANGCI_LINT_VERSION@@` | exact latest-stable `golangci-lint` value accepted and resolved during setup |
| `@@GOVULNCHECK_VERSION@@` | exact latest-stable `govulncheck` value accepted and resolved during setup |
| `@@RUST_VERSION@@` | exact latest-stable Rust runtime value accepted and resolved during setup |
| `@@CARGO_NEXTEST_VERSION@@` | exact latest-stable `cargo-nextest` value accepted and resolved during setup |
| `@@CARGO_DENY_VERSION@@` | exact latest-stable `cargo-deny` value accepted and resolved during setup |
| `@@CARGO_MACHETE_VERSION@@` | exact latest-stable `cargo-machete` value accepted and resolved during setup |
| `@@CARGO_LLVM_COV_VERSION@@` | exact latest-stable `cargo-llvm-cov` value accepted and resolved during setup |
| `@@API_DESCRIPTION@@` | accepted one-line deployable purpose |
| `@@API_TITLE@@` | protocols and events topic |
| `@@API_VERSION@@` | protocols and events topic |
| `@@API_SERVER_URL@@` | accepted deployment endpoint; unresolved is a blocking gap |
| `@@API_FAIL_SEVERITY@@` | protocols and events topic |
| `@@API_BASELINE_REF@@` | protocols and events topic |
| `@@MONOREPO_MEMBERS@@` | accepted MONOREPO member rows, each with a name, repository-relative path, and capability map |
| `@@BASE_LOCALE@@` | accepted internationalization base locale |
| `@@LOCALES_JSON@@` | accepted shipped locales as a JSON string array, including the base locale |
| `@@INLANG_MESSAGE_FORMAT_MODULE_URL@@` | exact user-supplied module URL; no recommendation |
| `@@AWS_CDK_DEST_SHELL@@` | accepted repository-relative CDK destination rendered with Python `shlex.quote` |
| `@@I18N_PREPARE_COMMANDS@@` | accepted clean-checkout dependency and catalog preparation commands, indented four spaces |
| `@@I18N_CHECK_COMMANDS@@` | one accepted recurring catalog command per configured deployable, indented four spaces |
| `@@A11Y_SURFACES_JSON@@` | accepted array of `{name, baseURL, routes}` objects; each route independently establishes its state |
| `@@A11Y_WEB_SERVERS_JSON@@` | accepted array of Playwright `{command, url, cwd}` objects; `cwd` is repository-relative |
| `@@A11Y_PREPARE_COMMANDS@@` | accepted dependency or fixture setup commands for every scanned product member, indented four spaces |
| `@@PLAYWRIGHT_VERSION@@` | resolved stable `@playwright/test` version accepted in the plan |
| `@@AXE_PLAYWRIGHT_VERSION@@` | resolved stable `@axe-core/playwright` version accepted in the plan |
| `@@ADR_TITLE@@` | accepted ADR title |
| `@@ADR_STATUS@@` | `accepted` for setup decisions |
| `@@ADR_DATE@@` | ISO 8601 calendar date when accepted |
| `@@ADR_DECISION@@` | accepted decision statement |
| `@@ADR_RATIONALE@@` | accepted driver and evidence |
| `@@ADR_ALTERNATIVES@@` | alternatives shown in the interview and why they lost |
| `@@ADR_CONSEQUENCES@@` | accepted benefits, costs, and constraints |
| `@@ADR_CONFIRMATION@@` | verification that proves the decision was applied |

A `*_VERSION` token holds the bare version, with no leading `v` and no range operator.
`.mise/conf.d/*.toml` and the CI setup actions read it as written; a consumer needing a
tag prefix writes the `v` itself, as `wc-lint-go.yml.template` does for both
golangci-lint and govulncheck.

## Plan classes

| Class | Meaning |
|---|---|
| `CREATE` | No file exists at the destination. |
| `OVERWRITE` | The asset replaces an existing file; the plan states what is lost. |
| `MERGE` | Both existing and asset contents survive; the plan states the merge rule. |
| `SKIP` | The existing file wins and the asset is not applied. |

Read every existing file before assigning a class. Fragment directories normally take
`CREATE`; their generator or include consumes them. Generated files are listed once as the
command that rewrites them, not as copied rows.

For brownfield repositories, classify `LICENSE` as manual/API state sourced from
governance/LICENSE.source, not as an unreviewed overwrite. Ask `KEEP|CHANGE|REMOVE` for
existing governance, release, forge, and CI files before applying their assets. A `CHANGE` or
`REMOVE` row names its migration consequence.

## Set index

Per-language files are listed in the four stack references. The remaining files follow.

### base

| Asset | Destination |
|---|---|
| `.editorconfig` | `.editorconfig` |
| `.gitattributes` | `.gitattributes` |
| `.gitignore.d/os` | `.gitignore.d/os` |
| `README.md.template` | `README.md` |
| `scripts/fold_gitignore.py` | `scripts/fold_gitignore.py` |

`fold_gitignore.py "<dest>"` rebuilds the managed gitignore section from the `.gitignore.d/`
fragments installed in the destination, and takes no other argument. It fetches nothing: every
upstream GitHub rule set it needs is vendored inside a fragment, `.gitignore.d/os` here and one
per language in each stack set, so the same input produces the same output offline. A fragment
is the whole rule set for its subject; no two assets share a destination fragment name. It
preserves text outside one stable `# BEGIN PROJECT-SETUP MANAGED BLOCK` /
`# END PROJECT-SETUP MANAGED BLOCK` pair. A no-marker
file is hand-owned and receives one appended managed section. Duplicate or malformed markers,
read-only targets, and other ownership conflicts return `conflict` rather than overwriting.
The fold source intentionally carries no Repomix ignore defaults. Repomix is not part of the
setup asset contract; a target repository adds any unrelated ignore rule through its own plan.
| `CONTRIBUTING.md` | `CONTRIBUTING.md` | contribution policy selected |
### governance

| Asset | Destination | Condition |
|---|---|---|
| `LICENSE.source` | manual selection source for `LICENSE` | selected SPDX text is copied manually; source is not copied as `LICENSE` |
| `CODEOWNERS.template` | `CODEOWNERS` | accepted owner or team |
| `SECURITY.md.template` | `SECURITY.md` | security policy selected |
| `CONTRIBUTING.md` | `CONTRIBUTING.md` | contribution policy selected |
| `CODE_OF_CONDUCT.md.template` | `CODE_OF_CONDUCT.md` | accepted reporting contact |
| `ADR.md.template` | one `docs/adr/NNNN-kebab-title.md` per ADR manifest row | beads plugin not installed; substitute only accepted ADR fields |

### worktrunk

| Asset | Destination |
|---|---|
| `.config/wt.toml.template` | `.config/wt.toml` |
| `.worktreeinclude` | `.worktreeinclude` |

Worktrunk's setup step runs trust, then `wt step copy-ignored --require-include`, then the
accepted toolchain and dependency setup. The sequence is bounded and is not a repomix step.
Both files are required for project provisioning.
The Worktrunk source intentionally omits unsupported index artifacts. Only accepted dependency
directories listed by `.worktreeinclude` are copied, and no index or Repomix state is promised.

### just

| Asset | Destination |
|---|---|
| `justfile` | `justfile` |
| `.mise/conf.d/just.toml` | `.mise/conf.d/just.toml` |
| `scripts/gen_justfile.py` | `scripts/gen_justfile.py` |

The Just surface contains only copied fragments and member paths accepted in the plan. No
additional package-orchestration layer is supplied.

### hooks

| Asset | Destination |
|---|---|
| `.pre-commit.d/hygiene.yaml.template` | `.pre-commit.d/hygiene.yaml` |
| `.pre-commit.d/git-actions.yaml.template` | `.pre-commit.d/git-actions.yaml` |
| `.just.d/hooks.just` | `.just.d/hooks.just` |
| `.mise/conf.d/hooks.toml.template` | `.mise/conf.d/hooks.toml` |
| `scripts/merge_hooks.py` | `scripts/merge_hooks.py` |
| `scripts/commit-msg-rewrite.py` | `scripts/commit-msg-rewrite.py` |
| `scripts/close_keywords.py` | `scripts/close_keywords.py` |
| `scripts/attribution_guard.py` | `scripts/attribution_guard.py` |
| `scripts/attribution_patterns.py` | `scripts/attribution_patterns.py` |
| `scripts/no_force_push.sh` | `scripts/no_force_push.sh` |

`merge_hooks.py` reads an existing `.pre-commit-config.yaml`, preserves top-level semantics,
repos, hooks, and metadata, de-duplicates identical entries, and returns `conflict` for
conflicting revisions, hook metadata, malformed YAML, or an unsafe merge. Preserve the
executable bits on `commit-msg-rewrite.py` and `no_force_push.sh`.

`no_force_push.sh` protects exactly the branches its hook entry passes as arguments, and exits
non-zero with a usage line when it is given none. `git-actions.yaml.template` passes
`@@DEFAULT_BRANCH@@`, so the accepted branch is protected rather than whichever name an ambient
variable happens to hold.

### ci

| Asset | Destination |
|---|---|
| `.github/workflows/wc-changes.yml` | same path on GitHub |
| `.github/workflows/wc-quality.yml.template` | `.github/workflows/wc-quality.yml` on GitHub |
| `.github/workflows/wc-security.yml.template` | `.github/workflows/wc-security.yml` on GitHub |
| `.github/workflows/wc-gate.yml.template` | `.github/workflows/wc-gate.yml` on GitHub |
| `.github/actions/ci-gate/action.yml` | same path on GitHub |
| `.just.d/ci.just` | `.just.d/ci.just` |
| `.mise/conf.d/ci.toml` | `.mise/conf.d/ci.toml` |
| `.ci/members.json.template` | `.ci/members.json` (MONOREPO only; resolved member rows drive per-member CI jobs) |
| `scripts/gen_caller.py` | `scripts/gen_caller.py` on GitHub |

`.ci/members.json` is the committed source of truth for accepted MONOREPO CI capabilities. Its
`members` array contains objects with a unique job-safe `name`, a safe repository-relative
`path`, and a `capabilities` object mapping each language to `lint` and/or `test`. A missing
file means the repository is the single-root case; the caller must not infer members from
directories or manifests.

GitHub's caller is generated by `just ci-sync`. GitLab uses the static root pipeline in the
forge set. Gitea, Azure DevOps, and other forges are explicit unsupported gaps.

### forge

| Asset | Destination | Condition |
|---|---|---|
| `github/ISSUE_TEMPLATE/bug_report.md` | `.github/ISSUE_TEMPLATE/bug_report.md` | GitHub forge |
| `github/ISSUE_TEMPLATE/feature_request.md` | `.github/ISSUE_TEMPLATE/feature_request.md` | GitHub forge |
| `github/PULL_REQUEST_TEMPLATE.md` | `.github/PULL_REQUEST_TEMPLATE.md` | GitHub forge |
| `gitlab/issue_templates/bug.md` | `.gitlab/issue_templates/bug.md` | GitLab forge |
| `gitlab/merge_request_templates/default.md` | `.gitlab/merge_request_templates/default.md` | GitLab forge |
| `gitlab/.gitlab-ci.yml` | `.gitlab-ci.yml` | GitLab forge |

The GitLab root pipeline includes `.gitlab/ci/*.yml` and declares the `lint`, `test`,
`quality`, and `security` stages used by the language fragments.

### release

| Asset | Destination | Condition |
|---|---|---|
| `renovate.json` | `renovate.json` | Renovate configuration accepted |
| `release-please-config.json` | `release-please-config.json` | release-please accepted |
| `.github/workflows/release-please.yml.template` | `.github/workflows/release-please.yml` | GitHub forge and release-please accepted |

Renovate activation and credentials are API or manual state. The release workflow is GitHub
only; GitLab release automation remains an explicit manual gap. Its `on: push` list is
`@@DEFAULT_BRANCH@@`: a release workflow listening to the wrong branch never runs and reports
nothing.

### steering

| Asset | Destination |
|---|---|
| `steering-tree/AGENTS.body.md.template` | `docs/agents/AGENTS.body.md` |
| `steering-tree/index.md` | `docs/agents/index.md` |
| `steering-tree/conventions.md` | `docs/agents/conventions.md`; `SKIP` once it exists |
| `steering-tree/ci/index.md` | `docs/agents/ci/index.md` |
| `steering-tree/docs/index.md` | `docs/agents/docs/index.md` |
| `steering-tree/env/index.md` | `docs/agents/env/index.md` |
| `steering-tree/quality/index.md` | `docs/agents/quality/index.md` |
| `steering-tree/release/index.md` | `docs/agents/release/index.md` |
| `steering-tree/testing/index.md` | `docs/agents/testing/index.md` |
| `.just.d/steering.just` | `.just.d/steering.just` |
| `scripts/gen_steering.py` | `scripts/gen_steering.py` |
| `scripts/install_agents_index.py` | `scripts/install_agents_index.py` |

`install_agents_index.py "<dest>" [--claude MERGE|OVERWRITE|SKIP] [--agents MERGE|OVERWRITE|SKIP]`
writes `AGENTS.md` from the rendered body and links `CLAUDE.md` to it. An existing
`CLAUDE.md` whose text `AGENTS.md` does not already carry, or a symlink pointing elsewhere,
returns `conflict`: that destination's class is asked and passed as `--claude`, never
assumed. An `AGENTS.md` that is already a symlink is the same class of conflict and is
asked as `--agents`; writing through the link is never the default.

### api

| Asset | Destination |
|---|---|
| `openapi.yaml.template` | `openapi.yaml`; `SKIP` once an endpoint is described |
| `.just.d/api.just.template` | `.just.d/api.just` |
| `.pre-commit.d/api.yaml.template` | `.pre-commit.d/api.yaml` |
| `.mise/conf.d/api.toml` | `.mise/conf.d/api.toml` |
| `.github/quality.d/api.yml` | same path on GitHub |
| `.github/security.d/api.yml` | same path on GitHub |
| `.github/workflows/wc-lint-api.yml.template` | `.github/workflows/wc-lint-api.yml` on GitHub |
| `.gitlab/ci/api.yml.template` | `.gitlab/ci/api.yml` on GitLab |

### infrastructure/aws-cdk

| Asset | Destination | Condition |
|---|---|---|
| `scripts/init_aws_cdk.py` | `scripts/init_aws_cdk.py` | `AWS_CDK_TYPESCRIPT` selected |
| `.just.d/aws-cdk.just.template` | `.just.d/aws-cdk.just` | generated AWS CDK member exists |
| `.gitlab/ci/aws-cdk.yml` | `.gitlab/ci/aws-cdk.yml` | GitLab and AWS CDK selected |
| `.gitignore.d/aws-cdk` | `.gitignore.d/aws-cdk` | AWS CDK selected |

The approved generator command is the only writer for a new CDK member. The destination must be
absent and pass the repository-relative path grammar. The generator runs native `cdk init` with an
exact accepted version, generates `bun.lock`, and atomically installs the completed member. It has no
bootstrap or deploy command.

Render `@@AWS_CDK_DEST_SHELL@@` into the Just fragment. GitHub quality CI invokes install and synth
when that fragment exists. GitLab uses the copied job.


### i18n

| Asset | Destination | Condition |
|---|---|---|
| `ts/paraglide/project.inlang/settings.json.template` | `<deployable>/project.inlang/settings.json` | Paraglide selected; merge or skip an existing Inlang project |
| `ts/paraglide/scripts/check-i18n-locale-drift.mjs` | `scripts/check-i18n-locale-drift.mjs` | at least one Paraglide deployable selected |
| `.just.d/i18n.just.template` | `.just.d/i18n.just` | at least one recurring completeness command accepted |
| `.gitlab/ci/i18n.yml` | `.gitlab/ci/i18n.yml` | GitLab and recurring completeness command accepted |

The plan creates one `<deployable>/messages/<locale>.json` catalog per shipped locale. Catalog bodies
are product copy, not static assets; show their initial keys and require explicit acceptance.
`@@I18N_PREPARE_COMMANDS@@` installs each selected tool from its committed lockfile.
`@@I18N_CHECK_COMMANDS@@` contains every accepted recurring command. For Paraglide it includes:

```sh
    node scripts/check-i18n-locale-drift.mjs '<deployable>'
```

An accepted path MUST equal `.` or match `[A-Za-z0-9._/-]+`. A non-root path remains relative and
contains no empty, `.` or `..` segment. Render the value with Python `shlex.quote`; reject it before
the plan when it fails the grammar.

The aggregate `just check` invokes the rendered `i18n` recipe. GitHub quality CI invokes the same
recipe when the fragment exists.

### a11y

| Asset | Destination | Condition |
|---|---|---|
| `ts/playwright/package.json.template` | `.a11y/package.json` | Playwright route scan accepted |
| `ts/playwright/playwright.a11y.config.ts.template` | `.a11y/playwright.config.ts` | at least one stable route accepted |
| `ts/playwright/tests/a11y/a11y.pw.ts.template` | `.a11y/tests/a11y.pw.ts` | at least one stable route accepted |
| `ts/playwright/.just.d/a11y.just.template` | `.just.d/a11y.just` | Playwright route scan accepted |
| `ts/playwright/.gitlab/ci/a11y.yml` | `.gitlab/ci/a11y.yml` | GitLab and Playwright route scan accepted |
| `ts/playwright/.mise/conf.d/a11y.toml.template` | `.mise/conf.d/a11y.toml` | Playwright route scan accepted |
| `ts/playwright/.gitignore.d/a11y` | `.gitignore.d/a11y` | Playwright route scan accepted |

The isolated `.a11y` package works when no root package exists. After copying it, run
`bun install --cwd .a11y` once and commit `.a11y/bun.lock`. Later installs use the frozen lockfile.
`@@A11Y_PREPARE_COMMANDS@@` installs each product member's dependencies and prepares accepted fixture
data before Playwright starts its servers. The config resolves every repository-relative `cwd`
against the repository root. GitHub and GitLab CI run preparation, install Chromium, and run `a11y`.

When no stable route exists, record axe scanning as a gap and do not copy this set.

Generated `.gitignore`, `.pre-commit-config.yaml`, GitHub `ci.yml`, the Just import block,
and generated steering blocks are rewritten only by their listed commands after the plan is
approved. No destination outside the plan is written.
