---
name: delivery-worktree-hygiene
description: When holding a worktree, acting on a hygiene reminder, or cleaning up a worktree and branch after work lands.
---

# Worktree hygiene

LEGEND: Rules carry stable IDs (WH-n).

## Own the cleanup

MUST WH-1: cleanup of a landed branch's worktree and local ref belongs to the agent that merged that branch. When no merging agent is live, the main agent owns it. Name that owner by the capability the session holds: it reads the merge proof, writes the governing bead, and runs the cleanup tool. Never name it by a role this repository does not ship.

## Hold one worktree

MUST WH-2: one linked worktree per bead, shared by every agent that touches it. A retry, a review round, and a handoff all adopt that bead's existing worktree and branch. None of them opens a second tree, a second tip, or a second owner. Record an exceptional reason on the governing bead before you create a concurrent second tree. The discipline is advisory: no gate enforces it, and nothing prunes a worktree on its own.

MUST WH-3: commit after each bounded coherent change. Push before every session boundary. An uncommitted edit or an unpushed commit blocks landing, and therefore blocks cleanup.

MUST WH-4: keep scratch files, logs, and repro scripts outside every worktree. A file written inside one dirties the tree or lands in a commit.

MUST WH-5: act on the first hygiene reminder. A session receives at most three, and proved progress resets the count. The third reminder escalates whether the residual was measured or only suspected: it instructs the main agent or run lead to invoke the report-only `worktree-reaper` to inspect and report the residual, and it names the lifecycle that removes state. When the residual could not be measured, report it rather than act on it. The reaper mutates nothing, so its inventory authorizes no removal; removal happens only through `delivery_cleanup` under WH-6, after a landing is proved.

## Inventory backup directories

MUST WH-7: treat every `<worktree>.bak.<timestamp>` directory under the worktree root as an independent hygiene row. A backup directory is not a Git worktree, even when it contains a Git checkout or resembles a listed worktree. The report records its exact path and owner, branch, dirty count, unpushed count, and landing-receipt evidence; each value is `UNKNOWN` unless a bounded probe proves it.

MUST WH-8: never remove a backup directory by name, age, emptiness, path absence from `git worktree list`, or a successful `wt step prune --dry-run`. Authorized removal requires per-directory proof of no live process cwd, no unmerged unique commits, and no dirty tracked changes, plus exact landing evidence or explicit authorization recorded on the governing bead. A failed, timed-out, or ambiguous probe stops the action and leaves the directory reported as `UNKNOWN`.
MUST WH-9: the report-only `worktree-reaper` never authorizes backup removal. When WH-8 proof and explicit bead authorization are present, the lead records the exact backup path and proof in the governing bead, obtains point-of-risk human approval, and performs one deliberate filesystem removal of that named path outside the reaper; no sweep, name-based selection, `rm` loop, `git worktree remove`, or `wt step prune --min-age 0` is permitted. Without that approval, leave the row `UNKNOWN` with recommendation `none`. `delivery_cleanup` remains limited to receipt-identified landed worktrees and branches and is never used for an arbitrary backup path.

## Remove landed state

MUST WH-6: after `delivery_land` proves a branch landed, remove landed state only through `delivery_cleanup`, after closing each receipt bead in children-first order for an active ledger with `bd update ID --set-metadata pr=N --set-metadata merge_sha=SHA`, then `bd close ID --reason "PR #N merged as SHA; receipt PATH"`; no-ledger or retired receipts (`false`) go directly from landing to `delivery_cleanup`. Delivery tools never write the Beads ledger. `delivery_cleanup` performs read-only `bd show` verification that every receipt bead is closed and `metadata.merge_sha` equals the receipt's `pr.mergeCommitOid`; it refuses while an active ledger remains unreconciled. That tool removes one worktree. Then it deletes the local ref. Then it verifies absence. Provenance obligations for a destructive ref mutation stay in `rule://worktrunk-destructive-branch-provenance`.

WH-6 has preconditions and stopping conditions:

- Start from exact landing proof for that branch (`rule://delivery-git-workflow` GW-3). An exact merged pull request is the only proof that closes a bead automatically. It names the recorded base, a `headRefOid` equal to the branch tip, and that merge commit reached in the base. An intermediate merge is not the final destination.
- Where there is no pull request, `git cherry` or a stable patch ID proves one equivalent patch, never a multi-commit squash. That proof supports a reconciliation the owner states explicitly. It never closes a bead automatically.
- The tool classifies `beads.ledgerActive` at the repository checkout root, never at the Git metadata directory or invocation directory. For normal and linked layouts, it confirms that the common `.git` directory belongs to the checkout, then uses its parent. For separate-git-dir and submodule layouts, it uses Git's observed top level. A linked worktree sits outside the checkout. An upward `.beads` walk from it would report every worktree session as ledger-free. Only a regular-file `.beads/RETIRED` marker retires a ledger.
- Verify absence, never infer it. `delivery_cleanup` stamps a verified-absence time for the removed worktree and for the remote branch. It never promotes `unknown` to a verified absence. A successful mutation is not its own proof.
- Fail closed on any of these, and hold the work for the user:
  - a dirty tree
  - an unpushed commit
  - a tip that landing proof does not cover
  - an ambiguous owner
- Report the worktree path, the branch tip SHA, and the unmet condition.
- Never force a removal, and never stash to make a tree look clean.
- `ExtensionContext` carries no role identity. Nothing tells a session whether it is the main agent, a run lead, or a worker, so role-restricted ownership remains a convention no tool verifies. `delivery_hygiene_report` inventories the repository on demand, one row per worktree, and names no holder it cannot observe. It is read-only.
- Clean only the bead you own. Another actor's worktrees and uncommitted state are not yours to inventory, to report, or to remove (`rule://coexistence-worktree`).
- Switch worktrees only when the work requires it. Each one carries its own provisioning and build output from `wt step copy-ignored`. Re-pointing a worktree at another branch discards both.
