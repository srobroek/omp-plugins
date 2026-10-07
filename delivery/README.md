# delivery

The delivery plugin covers pull-request review, landing proof, worktree hygiene, reconciling
and cleaning a landed worktree, and Beads handoff.

## Tools

The plugin registers three tools.

| Tool | Approval | Purpose |
| --- | --- | --- |
| `delivery_hygiene_report` | `read` | Read-only worktree and receipt inventory, on demand. |
| `delivery_land` | `exec` | Prove a pull request landing and write one receipt. |
| `delivery_cleanup` | `exec` | Remove and verify one landed worktree and branch; reconcile first only when `beads.ledgerActive` is true, otherwise clean directly. |

`delivery_land` accepts `pr`, optional `merge_method` (`squash` by default, or `merge` or `rebase`), and, when needed, `repo`, `remote`, `expectHeadSha`, `setupAutoDelete`, `worktree`, and `beadId`. `expectHeadSha` is required whenever the call would merge; it is optional only when proving an already-`MERGED` request. A supplied `worktree` must have its HEAD equal to the PR `headRefOid`, or the tool refuses before any forge mutation. `beadId` names the closed bead when the branch convention does not; a ledger-free repository needs none. A squash merge passes the PR title as the commit subject. The tool reads the pull or merge request and refuses invalid caller inputs. An explicit `merge` request also requires the forge repository policy to allow merge commits; a policy read of `false` refuses before mutation. It merges at most once. If it issues a merge, it rereads the same request and base on that merge-issued path. An already-`MERGED` request uses its initial read as proof. The tool observes the remote branch and writes one validated receipt. It never writes the Beads ledger.

`delivery_cleanup` removes and verifies one landed worktree and branch. When `beads.ledgerActive` is true, it runs after reconciliation; no-ledger or retired receipts skip reconciliation. It accepts `receipt`, `pr`, `branch`, `worktree`, and `remote`. `worktree` is a caller-supplied identity field. Supplied identity fields must equal the selected receipt. The tool performs read-only `bd show` calls. It refuses a dirty target, an unpushed commit, an uncovered tip, or an unsafe identity. It does not infer or enforce a role owner. Repository policy assigns ownership. It removes the worktree identified by the receipt without force, deletes the local branch with `git branch -d`, verifies worktree registration, path absence, local-ref absence, and remote-branch state, and writes one continuation receipt.

## Hygiene lifecycle

Run these steps in order after a reviewed branch lands:
1. **Land.** Call `delivery_land` with the requested pull or merge request. Supply `expectHeadSha` when the call would merge, and `worktree` when recording the landing association.
2. **Reconcile when active.** `beads.ledgerActive` records the ledger classification taken at the repository's canonical root rather than at the invocation directory, because a linked worktree sits outside the checkout. When it is `true`, after `delivery_land` succeeds, close each receipt bead in children-first order with `bd update ID --set-metadata pr=N --set-metadata merge_sha=SHA`, then `bd close ID --reason "PR #N merged as SHA; receipt PATH"`. When it is `false` for a no-ledger or retired repository, skip this step. Delivery tools never write the Beads ledger. `delivery_cleanup` performs read-only `bd show` verification that every receipt bead is closed and `metadata.merge_sha` equals the receipt's `pr.mergeCommitOid`.
3. **Clean.** Call `delivery_cleanup` with the receipt or matching identity fields.

A receipt minted before `beads.ledgerActive` was classified at the canonical root may record `true` for a repository with no `.beads` of its own, because the old classification walked into ancestor directories such as `~/.beads`. `delivery_cleanup` refuses that receipt: its stored verdict disagrees with the recomputed one. Receipts are not migrated. To recover, call `delivery_land` again for the already-merged request with the same `worktree`; it proves the merge without merging and writes a fresh receipt with the recomputed verdict. Then call `delivery_cleanup` with that new receipt.

Cleanup requires exact landing proof. The request must be merged at its recorded base. Its `headRefOid` must cover the branch tip. The merge must reach the final destination. A dirty tree, an unpushed commit, an uncovered tip, a failed identity check, or unknown local absence stops cleanup. The caller supplies the worktree and follows repository ownership policy. Remote absence `unknown` remains unverified. The receipt records that result and never presents it as absence. Never force removal, stash changes to make a tree clean, or remove a worktree or branch by hand.

### Merge method and proof shape

`merge_method` defaults to `squash` for compatibility. `merge` requests a real merge commit, and `rebase` requests a linear/rebased landing. Callers MUST choose the method from the project's documented landing policy; an explicit `merge` is refused when the forge reports `allow_merge_commit: false`, and an ambiguous policy MUST be resolved by the caller rather than guessed by the tool.

The receipt's `proof.evidence` records `mergeMethod`, the observed `mergePolicy` when available, and `mergeShape`. A squash proof has one parent; a merge proof has two parents with the reviewed head as the second parent; a rebase proof has one parent and ordered patch-id equivalence: the `git patch-id --stable` sequence of the reviewed commits (base..reviewed head) equals, in order, that of the landed commits ending at the merge commit, because rebase-and-merge rewrites commit SHAs. Patch ids are computed from zero-context diffs (`git diff-tree -p -U0`), so a clean rebase whose hunk context changed on the base still compares equal. For an already-`MERGED` request, no merge method was issued in this call, so the proof accepts one parent or two parents with the reviewed head second and records the observed shape. The tool refuses a shape that does not match the selected method when it issues the merge.

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

The writer creates the receipt in an exclusively created `0600` temporary file in the receipt directory, then atomically links that file into its final name. Link publication is intentionally no-clobber: an existing byte-identical regular `0600` receipt is idempotent success, while differing or unsafe content refuses. The temporary file is removed only by the writer that created it.

`landing-receipt.ts` is a library used by the landing and cleanup tools. It is not an extension factory and does not appear in the manifest. The manifest declares exactly three factories in this order: `delivery-land-tool`, `delivery-cleanup-tool`, and `hygiene-orientation`. A continuation receipt carries unknown fields from its predecessor.

## Forge behavior

The adapter supports verified GitHub and GitLab remotes only. It uses `gh` for GitHub and `glab` for GitLab`. It passes arguments without a shell and bounds each invocation. Invalid caller fields or identity mismatches refuse before mutation. An unknown host or unsupported scheme becomes `unknown`. Malformed, unavailable, permission-failed, or otherwise undetermined remote reads also return `unknown`; delivery never promotes that result to absence or success. `delivery_land` rereads the same request and base only after it issues a merge. An already-`MERGED` request uses only its initial read. The adapter observes each forge's source-branch deletion setting separately. A caller must request setup explicitly.

## Extensions

| Factory | Behavior |
| --- | --- |
| `delivery-land-tool` | Registers `delivery_land`. |
| `delivery-cleanup-tool` | Registers `delivery_cleanup`. |


## Agents and workflow actors

| Actor | Responsibility |
| --- | --- |
| `pr-reviewer` | Read-only pull-request reviewer. It returns a `VERDICT:` line and does not edit the checkout. |
| `implementer` | Default implementation tier. Implements one assigned bead in its own linked worktree, records evidence, and reports its branch head; it does not review, merge, or close. |
| `implementer-high` | Reasoning-heavy implementation tier for root-cause, concurrency or data-integrity, cross-module contract, numeric-precision, or design-judgment work; records its diagnosis with the evidence. |
| `researcher` | Researcher. Answers one assigned question with cited observations and inferences. It makes no product-code edits and may use forge tools. |
| `operator` | Mechanical worker. Runs one exact bounded command over explicit targets and records the observed result. |
| `shepherd` | Lands one reviewed PR after an exact-head approval artifact on the PR (an `APPROVED` review, or a reviewer `VERDICT: APPROVE` comment naming the head SHA when reviewer and author share one account) and green checks via `delivery_land`, closes receipt beads, runs `delivery_cleanup`, and sends refusals to the dispatcher, who routes the PR back to its author. It owns the merge queue: `pr:merge` beads labeled `agent:shepherd`. When `beads.ledgerActive` is true, it verifies completed reconciliation before cleanup; retired or no-ledger receipts skip directly to cleanup. Landing serializes only when the dispatcher runs at most one shepherd at a time per target branch, queueing approved PRs and dispatching the next shepherd after the previous returns. |
| `worktree-reaper` | Report-only inventory of residual worktree state, invoked by the main agent or run lead. It mutates nothing and never authorizes removal. |

The agent that creates a PR owns its automated review loop until approval or explicit human escalation. When the dispatcher hands an approved PR to a shepherd, landing and cleanup ownership pass to the shepherd, and refusals come back to the creator through the dispatcher. Workers dispatched by a lead do not request or act on review rounds for the lead's PR. The agent that merges a branch owns cleanup under repository policy. If no merging agent is live, the main agent owns cleanup. The main agent or run lead must orient before a role-restricted step. `delivery_cleanup` does not enforce actor identity or require the caller to run from a linked worktree; it validates the caller-supplied receipt target. Repository policy assigns ownership.

## Rules

| Name | When |
| --- | --- |
| `delivery-git-workflow` | Create or review pull requests, run automated-review loops, prove landing, reconcile and clean a landed worktree, or link delivery to Beads. |
| `delivery-fan-out` | Every task (always on): split test, one-batch `task` dispatch capped at 8, helper choice, worktree isolation, and single post-integration verification. Always on because, loaded lazily, it was never opened in a full user environment. |
| `delivery-worktree-hygiene` | Hold a worktree, act on a `delivery_hygiene_report` finding, or clean up a landed worktree and branch. |

## License

See the repository license.
