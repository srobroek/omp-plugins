# delivery

Delivery workflow guidance for reviewed pull requests, landing proof, worktree hygiene, and Beads handoff.

## Tools

The plugin registers four tools.

| Tool | Approval | Purpose |
| --- | --- | --- |
| `delivery_orient` | `read` | Read-only orientation for a main agent or run lead. |
| `delivery_hygiene_report` | `read` | Read-only hygiene inventory when state remains ambiguous. |
| `delivery_land` | `exec` | Prove a pull request landing and write one receipt. |
| `delivery_cleanup` | `exec` | Reconcile, remove, and verify one landed worktree and branch. |

Call `delivery_orient` before a main-agent or run-lead-only action. It reports the owned repository scope, linked worktrees, branch publication state, dirty paths, receipt residue, and scan limitations. It never mutates state. Call `delivery_hygiene_report` for the same bounded inventory on demand. `ExtensionContext` does not provide role identity, so these tools report facts instead of deciding a role.

`delivery_land` runs only from a linked worktree. Pass `pr` and, when needed, `repo`, `remote`, `expectHeadSha`, `setupAutoDelete`, and `worktree`. The tool reads the pull or merge request, refuses a head mismatch, merges at most once, re-reads the same request and base, observes the remote branch, and writes one validated receipt. The tool never writes the Beads ledger.

`delivery_cleanup` accepts `receipt`, `pr`, `branch`, `worktree`, and `remote`. Supplied identity fields must equal the selected receipt. The tool performs read-only `bd show` calls. It refuses a dirty target, an unpushed commit, an unproven owner or tip, or an unsafe identity. It removes one linked worktree without force. It deletes the local branch with `git branch -d`. It verifies worktree registration, path absence, local-ref absence, and remote-branch state. It writes one continuation receipt.

## Hygiene lifecycle

Run these steps in order after a reviewed branch lands:

1. **Orient.** Call `delivery_orient` before a role-restricted action.
2. **Land.** Call `delivery_land` with the exact request and linked worktree.
3. **Reconcile.** Run `bd_reconcile` to write the Beads ledger from the receipt. Delivery writes receipts, never the ledger.
4. **Clean.** Call `delivery_cleanup` with the receipt or matching identity fields.

Cleanup requires exact landing proof. The request must be merged at its recorded base. Its `headRefOid` must cover the branch tip. The merge must reach the final destination. A dirty tree, unpushed commit, ambiguous owner, uncovered tip, failed identity check, or unknown local absence stops cleanup. Remote absence `unknown` remains unverified. The receipt records that result and never presents it as absence. Never force removal, stash changes to make a tree clean, or remove a worktree or branch by hand.

## Landing receipts

Receipts use the plugin-agnostic schema `omp.receipt.landing` at version `1`. The tool writes them under `$PI_CODING_AGENT_DIR/receipts/<repo-key>`. If `PI_CODING_AGENT_DIR` is unset, it uses `$HOME/.omp/receipts/<repo-key>`. The tool never stores a receipt inside a checkout.

The writer emits these top-level fields in this order:

1. `schema`
2. `version`
3. `receiptId`
4. `emittedAt`
5. `emitter`
6. `repo`
7. `pr`
8. `branch`
9. `worktree`
10. `beads`
11. `proof`
12. `outcome`
13. `supersedes`

`notes` is optional. The nested records contain these fields:

| Record | Fields |
| --- | --- |
| `emitter` | `plugin`, `version`, `tool` |
| `repo` | `key`, `canonicalRoot`, `remote`, `forge`, `nameWithOwner` |
| `pr` | `number`, `url`, `state`, `baseRefName`, `headRefName`, `headRefOid`, `mergeCommitOid`, `mergedAt` |
| `branch` | `name`, `deletedRemote`, `remoteAbsenceVerifiedAt`, `autoDeleteSetting` |
| `worktree` | `path`, `removed`, `localRefDeleted`, `absenceVerifiedAt` |
| `beads` | `ids`, `ledgerActive` |
| `proof` | `method`, `observedAt`, `evidence` |
| `outcome` | `landed`, `cleaned`, or `partial` |
| `supersedes` | A prior `receiptId` or `null` |

`landing-receipt.ts` is a library used by the landing and cleanup tools. It is not an extension factory and does not appear in the manifest. The manifest declares exactly four factories in this order: `unpushed-work-advisory`, `delivery-land-tool`, `delivery-cleanup-tool`, and `hygiene-orientation`. A continuation receipt carries unknown fields from its predecessor.

## Forge behavior

The adapter supports verified GitHub and GitLab remotes only. It uses `gh` for GitHub and `glab` for GitLab. It passes arguments without a shell and bounds each invocation. It refuses an unknown host, unsupported scheme, unsafe repository path, malformed branch, or unproven response. It observes each forge's source-branch deletion setting separately. A caller must request setup explicitly.

## Extensions

| Factory | Behavior |
| --- | --- |
| `unpushed-work-advisory` | At session stop, reports dirty paths observed from writing tools and unpushed commits since the session baseline. It is advisory, grants no commit or publish authority, and never blocks a tool. It emits at most three reminders per session. After the third reminder, unresolved ambiguity escalates to the report-only `worktree-reaper`. |
| `delivery-land-tool` | Registers `delivery_land`. |
| `delivery-cleanup-tool` | Registers `delivery_cleanup`. |
| `hygiene-orientation` | Registers `delivery_orient` and `delivery_hygiene_report`. |

The `worktree-reaper` inventories residual state and never removes it.

## Agents and workflow actors

| Actor | Responsibility |
| --- | --- |
| `pr-reviewer` | Read-only pull-request reviewer. It returns a `VERDICT:` line and does not edit the checkout. |
| `integrator` | Merge-queue owner. It verifies landing proof before it closes a merge-linked bead. |
| `worktree-reaper` | Report-only escalation after the third ambiguous hygiene reminder. It inventories residual state and never authorizes removal. |

The agent that creates a non-orchestrated PR owns its automated review loop through landing or explicit human escalation. An orchestrated run's `orc-shepherd` owns review rounds. Workers do not request or act on those rounds. The agent that merges a branch owns cleanup. If no merging agent is live, the main agent owns cleanup. The main agent or run lead must orient before a role-restricted step.

## Rules

| Name | When |
| --- | --- |
| `delivery-git-workflow` | Create or review pull requests, run automated-review loops, prove landing, reconcile and clean a landed worktree, or link delivery to Beads. |
| `delivery-main-branch-push-advisory` | A bash call names `main` or `master` as a `git push` destination. The advisory never blocks the command. |
| `delivery-worktree-hygiene` | Hold a worktree, act on a hygiene reminder, or clean up a landed worktree and branch. |
| `delivery-direct-merge-advisory` | A top-level bash call invokes a local `git merge`. Use `delivery_land` for the reviewed landing path and `delivery_cleanup` afterward. |

The main-branch advisory reads command text only. It recognizes explicit destinations such as `origin main`, `HEAD:main`, `refs/heads/main`, `:main`, and `+HEAD:main`. It stays silent on bare `git push`, `git push main` where `main` is the remote, option values, and quoted mentions.

## License

See the repository license.
