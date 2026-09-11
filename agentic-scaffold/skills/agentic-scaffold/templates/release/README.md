# release

Renders the release configuration and two workflows to the standard in `docs/ci-standard.md`.

- `release-please-config.json`, `.release-please-manifest.json`: versions stay owned by
  `release-please`; never hand-edit them.
- `.github/workflows/release-please.yml`: runs on the default branch. With the
  `RELEASE_APP_CLIENT_ID` variable and `RELEASE_APP_PRIVATE_KEY` secret it uses a GitHub App
  token, so the release PR triggers CI. If either is missing it falls back to `GITHUB_TOKEN` and
  emits a warning; both App credentials are required for the App path.
- `.github/workflows/release.yml`: starts when the release PR merge publishes the GitHub release.
  - `release-gate` requires a green `gate` on the tagged commit and re-runs the checks on the
    tagged tree.
  - `build` produces the distributable once and attests it.
  - the publish lane for the interview's `publish` answer (`pypi`, `npm`, `crates`,
    `github-assets`, or `none`) publishes from that artifact in the `release` environment with
    trusted publishing.
  - `workflow_dispatch` with `dry_run` rehearses everything except the publish.
