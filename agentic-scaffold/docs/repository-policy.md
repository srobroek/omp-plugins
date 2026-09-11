# Repository policy

The `github` layer applies repository settings through the GitHub API. Run `scaffold.py policy apply --root . --dry-run` to inspect the planned requests, then run the command without `--dry-run` to apply them.

The policy enables squash merges, disables merge commits and rebases, disables the wiki and Discussions, enables issues, and creates standard labels. Public repositories also receive branch protection for the default branch with the `gate` status check, linear history, pull requests, and no force pushes or deletion.

## Manual steps

A maintainer must install the CLA app when `cla=true`, configure trusted package publishers, add required reviewers, and configure private-plan protection. The CLI does not grant app permissions or configure external registries.

## Runbook

1. Install and authorize `gh` for the repository owner.
2. Review the dry-run JSON.
3. Run `scaffold.py policy apply --root .`.
4. Install the CLA app if the repository uses CLA checks.
5. Configure trusted publishers and private repository protections in each provider.
6. Confirm the `gate` check and reviewer requirements in repository settings.
