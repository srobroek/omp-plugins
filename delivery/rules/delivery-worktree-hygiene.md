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

MUST WH-5: act on the first hygiene reminder. A session receives at most three. Keep an actionable third reminder with the session; invoke the report-only `worktree-reaper` only when ambiguity remains after the third reminder. The reaper never mutates; its report provides an inventory and does not authorize removal.

## Remove landed state

MUST WH-6: remove landed state only through `delivery_cleanup`, after running `bd_reconcile` when the receipt has `beads.ledgerActive: true`; no-ledger or retired receipts (`false`) go directly from landing to `delivery_cleanup`. That tool removes one worktree. Then it deletes the local ref. Then it verifies absence. For an active ledger, `delivery_cleanup` refuses while the ledger stays unreconciled and names `bd_reconcile` in the refusal. Provenance obligations for a destructive ref mutation stay in `rule://worktrunk-destructive-branch-provenance`.

WH-6 has preconditions and stopping conditions:

- Start from exact landing proof for that branch (`rule://delivery-git-workflow` GW-3). An exact merged pull request is the only proof that closes a bead automatically. It names the recorded base, a `headRefOid` equal to the branch tip, and that merge commit reached in the base. An intermediate merge is not the final destination.
- Where there is no pull request, `git cherry` or a stable patch ID proves one equivalent patch, never a multi-commit squash. That proof supports a reconciliation the owner states explicitly. It never closes a bead automatically.
- If the receipt has `beads.ledgerActive: true`, cleanup runs only after `bd_reconcile` has reconciled the ledger; if it is `false`, skip reconciliation and run cleanup directly.
- Verify absence, never infer it. `delivery_cleanup` stamps a verified-absence time for the removed worktree and for the remote branch. It never promotes `unknown` to a verified absence. A successful mutation is not its own proof.
- Fail closed on any of these, and hold the work for the user:
  - a dirty tree
  - an unpushed commit
  - a tip that landing proof does not cover
  - an ambiguous owner
- Report the worktree path, the branch tip SHA, and the unmet condition.
- Never force a removal, and never stash to make a tree look clean.
- Orient first. `ExtensionContext` carries no role identity. Nothing tells a session whether it is the main agent, a run lead, or a worker. Call `delivery_orient` before you claim a main-agent-only or lead-only step. Call `delivery_hygiene_report` for the on-demand inventory. Both tools are read-only.
- Clean only the bead you own. Another actor's worktrees and uncommitted state are not yours to inventory, to report, or to remove (`rule://coexistence-worktree`).
- Switch worktrees only when the work requires it. Each one carries its own provisioning and build output from `wt step copy-ignored`. Re-pointing a worktree at another branch discards both.
