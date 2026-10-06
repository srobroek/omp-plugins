---
name: delivery-worktree-hygiene
description: When holding a worktree, acting on a `delivery_hygiene_report` finding, or cleaning up a worktree and branch after work lands.
---

# Worktree hygiene

LEGEND: Rules carry stable IDs (WH-n).

## Own the cleanup

MUST WH-1: cleanup of a landed branch's worktree and local ref belongs to the agent that merged that branch. When no merging agent is live, the main agent owns it. Name that owner by the capability the session holds: it reads the merge proof, writes the governing bead, and runs the cleanup tool. Never name it by a role this repository does not ship.

## Hold one worktree

MUST WH-2: one linked worktree per bead, shared by every agent that touches it. A retry, a review round, and a handoff all adopt that bead's existing worktree and branch. None of them opens a second tree, a second tip, or a second owner. Record an exceptional reason on the governing bead before you create a concurrent second tree. The discipline is advisory: no gate enforces it, and nothing prunes a worktree on its own.

MUST WH-3: commit and push only owned, finished, authorized work, one bounded coherent change at a time; leave unfinished or uncertain-ownership work uncommitted and report it. An uncommitted edit or an unpushed commit blocks landing, and therefore blocks cleanup.

MUST WH-4: keep scratch files, logs, and repro scripts outside every worktree. A file written inside one dirties the tree or lands in a commit.

MUST WH-5: act on the first `delivery_hygiene_report` finding for a worktree you own: a nonzero dirty count, an unpushed commit, or a landing receipt for a branch whose worktree remains. The report runs only on demand and nothing repeats a finding, so a later call is not a second chance. The report-only `worktree-reaper` mutates nothing, so its report authorizes nothing.

## Inventory backup directories

MUST WH-7: treat every `<worktree>.bak.<timestamp>` directory under the worktree root as an independent hygiene row, not a Git worktree, even when it contains a Git checkout or resembles a listed worktree. Record its exact path, owner, branch, dirty count, unpushed count, and landing-receipt evidence; each value is `UNKNOWN` unless a bounded probe proves it. Never select one for removal by name, age, emptiness, absence from `git worktree list`, or a successful `wt step prune --dry-run`. Removal requires per-path proof of no live process cwd, no unmerged unique commits, no dirty tracked changes, and no untracked or ignored files holding unique content, then point-of-risk human approval for that exact path; the lead records the path and proof on the governing bead and performs one deliberate filesystem removal of that named path. No sweep, `rm` loop, `git worktree remove`, `wt step prune --min-age 0`, or `delivery_cleanup` call removes a backup. A failed, timed-out, or ambiguous probe, or missing approval, leaves the row `UNKNOWN` with recommendation `none`.

## Remove landed state

Remove landed state only through `delivery_cleanup`, after `delivery_land` proves the landing; the tool's contract states the close-out order and refuses unmet preconditions. Never remove a worktree or delete a branch by hand.

- Clean only the bead you own. Another actor's worktrees and uncommitted state are not yours to inventory, to report, or to remove (`rule://coexistence-worktree`).
- Switch worktrees only when the work requires it. Each one carries its own provisioning and build output from the post-start hook. Re-pointing a worktree at another branch discards both.
