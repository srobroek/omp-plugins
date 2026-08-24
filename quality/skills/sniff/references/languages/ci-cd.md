# CI/CD pipelines -- Sniff Reference

CI/CD workflow definitions: YAML used *functionally* to define pipelines, primarily
**GitHub Actions** (with GitLab CI noted). This doc covers **pipeline semantics +
security** -- action pinning, least-privilege permissions, injection, timeouts,
concurrency. The pure-YAML **format** layer (indentation, anchors, truthy, duplicate
keys) is covered separately in `yaml.md`; reference that split and do not re-flag
syntax here. Dominant concerns: security misconfig, reliability, maintainability.

## Detect

How sniff knows a CI/CD pipeline is present: key files.
- GitHub Actions: `.github/workflows/*.yml` / `*.yaml`; composite actions in `action.yml`
- GitLab CI: `.gitlab-ci.yml` (and `include:`-d fragments)
- Other (noted, not primary): `.circleci/config.yml`, `Jenkinsfile`, `azure-pipelines.yml`
- Config that governs it: `.actionlint.yaml`, `.github/dependabot.yml` (action update policy)

## Tools

Primary first. Exact invocation + machine-readable flag. Canonical detail in
`../tooling.md`; this is the runnable subset.

| Tool | Invocation | Covers | Tier | Installed via |
|------|-----------|--------|------|---------------|
| actionlint | **Run recipe:** from repo root, `actionlint -format '{{json .}}' -no-color`. **Flags are single-dash (Go flag pkg) -- `-format`, NOT `--format`; `--format` is the "bad flag" that errors.** The `{{json .}}` arg must be quoted exactly as shown. With no path args it auto-discovers `.github/workflows/`; or pass explicit workflow files. **Exit:** 0 clean · 1 = problems (parse JSON) · 3 = usage error (bad flag) → INVALID, fix the flag. | workflow AST: bad syntax, invalid `needs`/`if`, expr typos; **embeds shellcheck** for `run:` steps | default-on | `install-tools.sh --install infra` |
| zizmor | `zizmor --format json <workflow>` | GHA security dataflow: `pull_request_target` injection, `persist-credentials`, template injection | opt-in (security-only) | `install-tools.sh --install infra` |
| pinact | `pinact run --check` | verifies every `uses:` is pinned to a full commit SHA | opt-in (mutating fixer + needs a token) | `install-tools.sh --install infra` |

Notes: `actionlint` is the primary AST linter and already runs `shellcheck` over
every `run:` body, so do not separately shellcheck a workflow. `zizmor` is the
security specialist (the dataflow analyzer that catches injection and credential
leaks -- actionlint does **not** cover these). `pinact run --check` is a focused
gate for SHA pinning. GitLab CI has no equivalent of this trio; validate it with
GitLab's own CI Lint API / schema validator (`glab ci lint` or the project's
`/ci/lint` endpoint) and apply the semantic smells below by hand.

## Smell checklist

Beyond what tools flag. Each: what it looks like + the idiomatic alternative.

| Smell | What it looks like (GHA) | Idiomatic alternative |
|-------|--------------------------|-----------------------|
| Unpinned action ref | `uses: actions/checkout@v4` or `@main` | Pin to a full commit SHA: `uses: actions/checkout@<40-char-sha>` (+ comment the version) |
| `pull_request_target` + untrusted checkout | `on: pull_request_target` then `actions/checkout` of the PR head | Use `pull_request`; never check out + run untrusted PR code with write/secret access |
| Plaintext secrets / secret leak | Secret echoed to logs, written to a file, or hardcoded | Reference via `${{ secrets.X }}`, mask, never `echo` a secret |
| Over-broad `permissions:` | No `permissions:` block (defaults to broad `write`) | Set least-privilege at workflow top: `permissions: { contents: read }`, widen per-job |
| No job timeout | Job with no `timeout-minutes` | Add `timeout-minutes:` (prevents hung jobs burning runner minutes) |
| No concurrency control | Re-pushes trigger redundant overlapping runs | `concurrency: { group: …, cancel-in-progress: true }` |
| Script injection via `${{ }}` | `run: echo "${{ github.event.pull_request.title }}"` interpolated into shell | Pass via `env:` then reference `"$VAR"` (quote it); never inline untrusted expr into `run:` |
| No caching | Deps reinstalled every run | `actions/cache` or `setup-*` built-in cache (`cache: 'npm'`) |
| Brittle matrix | Hardcoded duplicated jobs that should be a matrix | `strategy.matrix` + `include`/`exclude` |
| Missing `if:` guards | Steps/jobs run on irrelevant events, wasting runs | Gate with `if:` (e.g. `if: github.event_name == 'push'`) |
| Self-hosted runner on public repo | `runs-on: self-hosted` in a public-repo workflow | Use ephemeral/GitHub-hosted runners; never self-host for fork PRs |

## Idioms & style authorities

- GitHub Actions security hardening -- https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions
- actionlint checks -- https://github.com/rhysd/actionlint/blob/main/docs/checks.md
- OpenSSF Scorecard (pinned-deps / token-permissions checks) -- https://github.com/ossf/scorecard/blob/main/docs/checks.md
- GitLab CI Lint reference -- https://docs.gitlab.com/ee/ci/yaml/lint.html
- Key conventions: pin actions to a full commit SHA; set least-privilege
  `permissions:` (default `contents: read`); add `timeout-minutes` and
  `concurrency`; never run untrusted PR code via `pull_request_target` with
  write/secret access; never interpolate untrusted `${{ }}` directly into `run:`.

## refactoring.guru mappings

| CI/CD smell | refactoring.guru smell | Idiomatic refactoring |
|-------------|------------------------|-----------------------|
| Duplicated steps across workflows/jobs | Duplicate Code (`/smells/duplicate-code`) | Extract a **reusable workflow** (`workflow_call`) or **composite action** |
| One giant job doing build+test+lint+deploy | Long Method (`/smells/long-method`) | Split into separate jobs wired by `needs:` |

The OO catalog maps **weakly** -- most CI smells are pipeline-design + security
specific (pinning, permissions, injection) with no refactoring.guru analogue. Cite
the GitHub security-hardening URL as the authority over forcing an OO mapping.

## Pragmatism notes (for the adversarial pass)

- `@vN` tags are acceptable per team policy for *trusted first-party* actions
  (`actions/checkout@v4`, `actions/setup-node@v4`) -- the SHA-pinning smell weighs
  heaviest on *third-party* actions. Respect a documented allow-policy.
- Not every workflow needs `concurrency`: a fast lint-only job or a manual
  `workflow_dispatch` gains little -- flag it on expensive or deploy workflows.
- A single-job workflow doesn't always need splitting; flag Long Method only when a
  job mixes unrelated concerns that should gate independently.
- No-timeout is low-severity on a job that's intrinsically short; weight it up on
  jobs that can hang (integration tests, network waits, self-hosted).
- Security smells here are rarely false positives -- `pull_request_target` + untrusted
  checkout, script injection via `${{ }}` into `run:`, and over-broad `permissions:`
  enable real supply-chain compromise. **Weight them high; do not soften them.**
