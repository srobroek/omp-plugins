# cicd

Trunk-based development and release policy for OMP plugins and repositories that release from commits. The rules cover small batches, feature-flag decisions, safe CI configuration, and compatible semantic-release setup.

## Rules

| Name | When |
| --- | --- |
| `cicd-trunk-workflow` | Use short-lived topic branches, required MR/PR CI, Conventional Commit squash titles as default-branch release units, exact-SHA previews, and protected-branch server checks. References `rule://delivery-git-workflow` for review and landing mechanics. |
| `cicd-feature-flags` | Decide whether incomplete work, controlled exposure, or rollback needs a flag. Record its owner and removal date. Test both states and clean up temporary flags. |
| `cicd-skip-ci-text` | A bash command that contains a skip-CI marker in a git commit, GitLab MR, or GitHub PR operation gets a reminder. The rule includes markers quoted in prose. This advisory does not stop the command. |

## Skills

| Name | When |
| --- | --- |
| `cicd-release-setup` | Configure and verify semantic-release on GitLab or GitHub, including Conventional Commit analysis, synchronized manifests, baseline tags, protected credentials, and first-release checks. |

## Extensions

| Module | Behavior |
| --- | --- |
| `cicd-commit-gate` | Blocks inline non-Conventional Commit subjects for `git commit`/`dgit commit` in repositories with release configuration. It also blocks parsed pushes to `main`/`master`. Explicit refspec destinations are checked. Without a refspec, the gate checks the current branch. `CICD_ALLOW_NONCONVENTIONAL_COMMIT=1` overrides the commit check. `CICD_ALLOW_MAIN_PUSH=1` overrides the push check. Both overrides are explicit and audited. The gate allows editor commits without inline messages. It also fails open on unreadable `-F` files, unparsable commands, missing git, non-repositories, and other uncertainty. It allows tag-only, dry-run, deletion, and other-branch pushes. This early local guardrail does not guarantee it blocks every non-conventional commit or main push. Protected branches, required pipelines, and server-side title validation enforce the policy. |
| `cicd-mr-advisory` | Never blocks. It reminds on non-Conventional Commit `glab mr create`/`gh pr create` titles, missing `Flag:` lines for `feat`/breaking titles with inline bodies, merges without `--squash` when commit-based releases apply, and pushes of branches older than two days. For file/editor bodies, it reminds without judging. |

The extensions provide best-effort local guidance for parsed commands. Forge-side checks and branch protection enforce the policy.