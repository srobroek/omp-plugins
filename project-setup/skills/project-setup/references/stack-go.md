# Go stack

Asset set: `skill://project-setup/assets/lang/go/`

## Asked

| Question | Default | Notes |
|---|---|---|
| Module path | none | As `go mod init` takes it, for example `github.com/<org>/<name>` |
| Minimum supported version | what `go mod init` wrote | Fills `@@GO_VERSION@@` in `.mise/conf.d/go.toml.template`. `go mod init` writes the installed toolchain's version into the `go` directive, and CI reads `go.mod` natively through `go-version-file`, so asking is only for a floor below the installed one |
| Latest-stable golangci-lint version | exact value accepted during setup | Fills `@@GOLANGCI_LINT_VERSION@@`. `.mise/conf.d/go.toml` and `wc-lint-go.yml` both read it |
| Latest-stable govulncheck version | exact value accepted during setup | Fills `@@GOVULNCHECK_VERSION@@`. `.mise/conf.d/go.toml` and `wc-lint-go.yml` both read it |
| Commit `vendor/` | no | No keeps the `vendor/` entry in `.gitignore.d/go.template`; yes deletes it. The upstream Go gitignore template cannot express this |

## Fixed

| Concern | Tool |
|---|---|
| Linting | golangci-lint on the v2 schema |
| Security lint | gosec, inside golangci-lint |
| Style | revive |
| Vulnerabilities | govulncheck |
| Module hygiene | `go mod tidy` with a diff check |

## golangci-lint v2, which rejects v1's file

v2 rejects a top-level `linters-settings` key. Settings nest under `linters.settings`.
`gosec` ships inside golangci-lint and is off by default, so the shipped `.golangci.yml`
enables it explicitly.

`govulncheck` is pinned to a concrete version rather than `latest`. mise's go backend
resolves `latest` by listing module versions, which timed out at its 20-second ceiling on
every fresh-clone setup measured, while `go list` on the same machine answered in under a
second.

## The versions CI installs

A GitHub runner has no mise, so `wc-lint-go.yml` installs golangci-lint and govulncheck
itself. Both read the same tokens `.mise/conf.d/go.toml` does, so a local `just go-lint`
and the CI job run one build of each: `latest` in either place would move the gate with no
diff in the repository. GitLab needs none of this; its jobs install through mise.

## Apply order

1. `go mod init <module path>` in the destination.
2. Copy the asset set, resolving `@@GO_VERSION@@`, `@@GOLANGCI_LINT_VERSION@@`, `@@GOVULNCHECK_VERSION@@`, and the vendor block. `.golangci.yml` is
   SKIP when the repository already has one.
3. `go mod tidy`.
4. `just just-sync`, then `just hooks-merge`, then `just ci-sync`.

## Files

| Asset | Destination | Class |
|---|---|---|
| `.golangci.yml` | `.golangci.yml` | CREATE, or SKIP when one exists |
| `.gitignore.d/go.template` | `.gitignore.d/go` | CREATE |
| `.just.d/go.just` | `.just.d/go.just` | CREATE |
| `.pre-commit.d/go.yaml` | `.pre-commit.d/go.yaml` | CREATE |
| `.mise/conf.d/go.toml.template` | `.mise/conf.d/go.toml` | CREATE |
| `.github/actions/setup-go/action.yml` | same path | CREATE |
| `.github/quality.d/go.yml` | same path | CREATE |
| `.github/security.d/go.yml` | same path | CREATE |
| `.github/workflows/wc-lint-go.yml.template` | `.github/workflows/wc-lint-go.yml` | CREATE |
| `.github/workflows/wc-test-go.yml.template` | `.github/workflows/wc-test-go.yml` | CREATE |
| `.gitlab/ci/go.yml` | same path | CREATE on a GitLab forge, SKIP otherwise |

`.golangci.yml` is the marker file that tells the gitignore fold and the steering
generator a Go layer is present.

## Recipes it adds

`go`, `go-fmt`, `go-lint`, `go-test`, `go-vuln`, `go-tidy-check`, `go-cov`, `go-install`.
