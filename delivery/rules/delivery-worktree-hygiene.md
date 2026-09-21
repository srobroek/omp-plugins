---
name: delivery-worktree-hygiene
description: When holding a worktree, acting on a hygiene reminder, or cleaning up a worktree and branch after work lands.
---

# Worktree Hygiene

LEGEND: Rules carry stable IDs (WH-n).

## Ownership

MUST WH-1: cleanup of a landed branch's worktree and local ref belongs to the agent that merged that branch; when no merging agent is live, the main agent owns it. Name the owner by the capability the session holds — it reads the merge proof, writes the governing bead, and runs the cleanup tool — never by a role this repository does not ship.

## Holding a worktree

MUST WH-2: hold one working worktree at a time. A second live worktree is a signal to finish or hand off the first; keeping both needs a reason recorded on the governing bead. The discipline is advisory: no gate enforces it, and nothing prunes a worktree on its own.

MUST WH-3: commit and push in small atomic steps, so a worktree is never the only copy of the work.

MUST WH-4: keep scratch files, logs, dumps, and repro scripts outside every worktree. A file written inside one dirties the tree or lands in a commit, and a dirty or unpushed tree blocks landing and therefore blocks cleanup.

MUST WH-5: act on the first hygiene reminder. A session receives at most three; after the third, the main agent or the run lead invokes the report-only `worktree-reaper` agent, which never mutates — its report is an inventory, not authorization to remove anything.

## Removing landed state

MUST WH-6: remove landed state only through `bd_reconcile`, then `delivery_cleanup`, which removes one worktree, then its local ref, and verifies absence. The order is fixed: `delivery_cleanup` refuses while the ledger is unreconciled, and names `bd_reconcile` in the refusal. Provenance obligations for a destructive ref mutation stay in `rule://worktrunk-destructive-branch-provenance`.

Preconditions and stopping conditions for WH-6:

- Start from exact landing proof for that branch (`rule://delivery-git-workflow` GW-3): a `MERGED` PR whose `headRefOid` equals the branch tip, plus its merge commit in the base. An intermediate merge is not the final destination.
- Absence is verified, never inferred. `delivery_cleanup` records a verified-absence timestamp for the removed worktree and for the remote branch; `unknown` is never promoted to a verified absence, and a successful mutation is not its own proof.
- Fail closed. A dirty tree, an unpushed commit, a tip that landing proof does not cover, or an ambiguous owner is held for the user: name the worktree path, the branch, the tip SHA, and the one unmet condition. Do not force, and do not stash.
- Orient first. `ExtensionContext` carries no role identity, so nothing tells a session whether it is the main agent, a run lead, or a worker. Call `delivery_orient` to establish that before claiming a main-agent-only or lead-only step, and `delivery_hygiene_report` for the on-demand inventory; both are read-only.
- Clean only the work item you own. Another actor's worktrees, branches, and uncommitted state are not yours to inventory, report, or remove (`rule://coexistence-worktree`).
- Switch worktrees only when the work requires it. Each one carries its own provisioning and build output from `wt step copy-ignored`; re-pointing a worktree at another branch discards both.
