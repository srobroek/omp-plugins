---
name: trunk-dev-release-setup
description: Set up semantic-release on GitLab or GitHub with compatible Conventional Commit analysis, synchronized version manifests, protected-branch credentials, and a verified first release.
---

# Set up semantic-release

TRIGGER
+ Configure automated releases from Conventional Commits on GitLab or GitHub.
+ Add or debug semantic-release, release-note generation, multi-manifest version synchronization, or its CI credentials.
- GitLab does not support release-please; use semantic-release for GitLab release automation.
- On GitHub, release-please is an alternative that opens a release PR rather than releasing directly from each qualifying merge.

Keep release execution on the protected default branch. Follow the repository's existing package manager, CI conventions, and version files; do not replace unrelated release policy.

## 1. Check the release contract

Confirm the default branch, commit type policy, semantic-release plugin versions, all version-bearing manifests, CI provider, and tag conventions. The squash commit subject is the release unit. A breaking change must use the syntax recognized by the configured analyzer. Use the project package manager and commit the resulting lockfile.

The compatible baseline used here is semantic-release `25.0.9` with `conventional-changelog-conventionalcommits` `9.x`. semantic-release 25.0.9 bundles `conventional-changelog-writer` 8; the 9.x preset is compatible with it. Do not select preset 10.x with this writer: it requires writer 9 and fails while generating release notes. Keep the core and plugin versions compatible and locked rather than using floating versions.

Install/configure the semantic-release plugins needed by the project:

- `@semantic-release/changelog` writes the changelog.
- `@semantic-release/exec` runs the version synchronization check or other required release commands.
- `@semantic-release/git` commits the updated release files.
- `@semantic-release/gitlab` publishes the GitLab release. For GitHub, use the provider plugin supported by the repository's existing setup, typically `@semantic-release/github`.

Configure the conventional-commits preset, analyzer, notes generator, changelog, version sync, git assets, and forge publisher in release order. The GitLab setup requires the changelog, exec, git, and gitlab plugins; do not omit `@semantic-release/exec` when it owns synchronization.

## 2. Synchronize every version manifest

Create or reuse one repository script that updates every package or manifest version that represents the released product. It should accept the target version and provide a check-only mode that exits nonzero when any version is stale without rewriting files. Invoke that mode in ordinary CI so divergence fails before merge. Invoke the update mode in the semantic-release preparation lifecycle before changelog/git commit, and include all changed manifests in the release commit.

Do not maintain separate handwritten version bumps for each manifest. Confirm the release commit contains the complete synchronized set and that check-only mode passes afterward.

## 3. Establish the release baseline

Before the first automated run, create and push the baseline tag for the current released version, pointing to the commit that represents that release. Ensure the tag name matches semantic-release's configured format and the tag does not already identify another commit. This gives the analyzer a previous release boundary; without it, the first run may misclassify the entire repository history as unreleased work.

## 4. Configure forge protection and credentials

### Enforce it on the forge

Treat the extensions as best-effort early local guardrails for command forms they parse, not as the security or enforcement boundary. Protect the default branch so developers and maintainers cannot push directly; allow changes through an MR/PR with a required passing pipeline (`Pipelines must succeed` on GitLab or required status checks on GitHub). Require squash, or strongly encourage it with validation of the squash title. Configure the semantic-release token's bot identity as the identity allowed to push the release commit and tags. If branch or tag protection does not permit that bot, the release job will be blocked.

Add a required pipeline job that validates the MR/PR title (the future squash subject) as a Conventional Commit, for example commitlint against `$CI_MERGE_REQUEST_TITLE` on GitLab or the pull-request title on GitHub. Make a `feat` MR/PR fail when its description lacks a named `Flag:` line or uses `Flag: none`. These server-side controls enforce the policy; the local extensions only complement them.

For GitLab, create a **project access token** whose bot user has Maintainer role and the `api` and `write_repository` scopes. Store it as masked and protected `GITLAB_TOKEN` in CI variables. A `CI_JOB_TOKEN` cannot push the release commit or open merge requests; it is not a substitute. Limit the release job's rules to the default branch and ensure the protected token is present in that job's context. Scope permissions narrowly enough that the release bot can push the release commit and tags while ordinary developers cannot push directly.

On GitHub, use the repository's approved release credential (for example a GitHub App token or appropriately scoped secret) and explicitly configure permissions needed to create tags/releases and push the release commit. Keep secrets protected from untrusted fork/MR pipelines.

## 5. Keep the release commit from looping CI

Configure the git plugin to use a message such as `chore(release): ${nextRelease.version} [skip ci]` for its generated release commit. GitLab and GitHub recognize skip-CI markers in commit messages; this prevents the release commit from starting another release pipeline. Do not put the marker in MR titles or ordinary commits: it suppresses their pipeline even when included as quoted prose. The `trunk-dev-skip-ci-text` rule provides a post-command reminder for recognized commands.

## 6. Verify in stages

1. Run semantic-release with `--dry-run` on a branch containing representative Conventional Commits. Confirm it finds the expected previous tag, next version, release notes, and branch configuration without publishing.
2. Test the complete local release in a throwaway bare Git repository: create a minimal history and baseline tag, run semantic-release, and verify the release commit and synchronized manifests. Remove the GitLab/GitHub forge plugin for this local run so it does not make a network release. Do not use a production checkout or real release credentials as the throwaway target.
3. Run the first protected-default-branch pipeline with the configured project access token. Confirm the job's authorization output includes **`Allowed to push`**, and inspect the resulting commit/tag/release and pipeline state. If this is absent, stop and fix token identity, scopes, protection, or job rules before retrying.

## Alternatives

On GitHub, release-please is an alternative for maintainers who prefer a reviewed release PR with version and changelog updates. Merging that PR creates the release. GitLab does not support release-please.