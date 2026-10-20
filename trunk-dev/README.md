# trunk-dev

Trunk-based development and release policy for OMP plugins and repositories that release from commits. The rules cover small batches, feature-flag decisions, safe CI configuration, and compatible semantic-release setup.

## Rules

| Name | When |
| --- | --- |
| `trunk-dev-workflow` | Use short-lived topic branches, required MR/PR CI, Conventional Commit squash titles as default-branch release units, exact-SHA previews, and protected-branch server checks. References `rule://delivery-git-workflow` for review and landing mechanics. |
| `trunk-dev-feature-flags` | Gate every new feature (`feat`) behind a default-off flag; non-feature changes need none. Record its owner and removal date. Test both states and clean up temporary flags. |
| `trunk-dev-skip-ci-text` | A bash command that contains a skip-CI marker in a git commit, GitLab MR, or GitHub PR operation gets a reminder. The rule includes markers quoted in prose. This advisory does not stop the command. |

## Skills

| Name | When |
| --- | --- |
| `trunk-dev-release-setup` | Configure and verify semantic-release on GitLab or GitHub. Also provides copyable daily stale-branch CI templates for GitLab and GitHub Actions, which report through failed-job notifications without notification tokens. |

## Extensions

| Module | Behavior |
| --- | --- |
| `trunk-dev-commit-gate` | Blocks inline non-Conventional Commit subjects for `git commit`/`dgit commit` in repositories with release configuration. It also blocks parsed pushes to `main`/`master`. Explicit refspec destinations are checked. Without a refspec, the gate checks the current branch. `TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT=1` overrides the commit check. `TRUNK_DEV_ALLOW_MAIN_PUSH=1` overrides the push check. Both overrides are explicit and audited. The gate allows editor commits without inline messages. It also fails open on unreadable `-F` files, unparsable commands, missing git, non-repositories, and other uncertainty. It allows tag-only, dry-run, deletion, and other-branch pushes. This early local guardrail does not guarantee it blocks every non-conventional commit or main push. Protected branches, required pipelines, and server-side title validation enforce the policy. |
| `trunk-dev-mr-advisory` | Never blocks. It reminds on non-Conventional Commit `glab mr create`/`gh pr create` titles, `feat` MRs/PRs without a named `Flag:` line (or with `Flag: none`), breaking changes without a `Flag:` decision, merges without `--squash` when commit-based releases apply, and pushes of branches older than two days. For file/editor bodies, it reminds without judging. |
| `trunk-dev-beads` | Sends one quiet session-start reminder for in-progress bead branches claimed more than 48 hours ago (override with positive-integer `TRUNK_DEV_STALE_HOURS`). After successful `gh pr merge`/`glab mr merge`, reads the merged PR/MR and creates a due-dated cleanup chore for valid flagged `feat` work when no open cleanup bead exists. It writes through the Beads plugin's embedded-store single-writer runner; if the runner is unavailable or cannot lock the store, it supplies one exact `bd create` command for the agent to execute through the Bash write gate. The embedded store must never be written by a bare extension child process because concurrent Dolt writers can corrupt it.

The `trunk-dev-release-setup` skill ships copyable daily stale-branch CI templates for both GitLab and GitHub Actions. The session reminder remains independent. Templates bootstrap Beads read-only, print stale branch claims, and fail the scheduled job so the CI platform notifies the schedule owner; they do not post webhooks or need a notification token. A stale branch therefore shows as a failed scheduled pipeline until it lands or its claim is released; replace the marked sink step to report without failing.

The cleanup chore is created only when the forge reports the PR/MR as merged. A `gh pr merge --auto` or `glab mr merge --auto-merge` that only schedules the merge creates nothing.

The extensions provide best-effort local guidance for parsed commands. Forge-side checks and branch protection enforce the policy.