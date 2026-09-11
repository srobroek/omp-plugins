# Repository policy

The `github` layer applies repository settings through the GitHub API. `scaffold.py policy apply
--root . --dry-run` prints the requests it would send; without `--dry-run` it sends only the
requests whose current value differs.

## What the layer applies

- Merges: squash only, PR title as subject, PR body as message.
- Branches: delete on merge.
- Issues on; wiki off; Discussions off.
- Labels: `bug`, `enhancement`, `task`.
- Environments: `release`, plus `github-pages` when `.omp/docs.json` names a docs flavor.
- Public repositories get a ruleset on the default branch. It requires:
  - the `gate` check on an up-to-date branch
  - linear history
  - a pull request
  - no force push and no deletion

## What stays manual

A maintainer does these once per repository, because the API does not let the layer do them:

- Install the CLA app and set `CLA_APP_ID` when `cla=true`.
- Register the trusted publisher on PyPI, npm, or crates.io for this repository, the release
  workflow, and the `release` environment.
- Set the App variable `RELEASE_APP_CLIENT_ID` and secret `RELEASE_APP_PRIVATE_KEY`.
- Add required reviewers to the `release` environment where a publish warrants one.
- Protect the default branch on a private repository whose plan lacks rulesets.

## Release credentials

A maintainer creates these repository secrets and variables before the first release:

- `RELEASE_APP_CLIENT_ID` (variable) and `RELEASE_APP_PRIVATE_KEY` (secret): the release App.
  The tap bump uses the same App, so the App must have `contents: write` and
  `pull-requests: write` on the tap and bucket repositories.
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: updater signatures.
  The build fails when the key is missing.
- Apple signing, required on macOS; the macOS jobs fail when any is missing:
  - `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` (secrets)
  - `APPLE_ID` and `APPLE_PASSWORD` (secrets)
  - `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID` (variables)

The maintainer configures required reviewers on the `release` environment. The reviewer approves
registry publication and release asset publication.

## Runbook

1. Authorize `gh` for the repository owner: `gh auth status`.
2. Run `scaffold.py policy apply --root . --dry-run` and read the JSON.
3. Run `scaffold.py policy apply --root .`.
4. Do the manual steps above.
5. Open a pull request and confirm that `gate` appears as the required check.
