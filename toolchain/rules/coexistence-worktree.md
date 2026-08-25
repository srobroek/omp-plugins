---
name: coexistence-worktree
description: When other agents or humans edit the same repo or switch the branch underneath you — Worktrunk coexistence.
---

# Multi-Agent Coexistence

You are rarely alone in a repository. Other agents may work concurrently in
the same repo or even the same worktree, and human authors may edit files or
the local branch directly while you work. Treat concurrent activity as normal
background rather than an anomaly.

Concurrent changes (other agents or humans):

- Do not highlight upstream changes, merged PRs, or files that moved
  underneath you. This is expected coexistence noise, not a finding.
- Do not report, count, or inventory another actor's uncommitted files, staged
  changes, unpushed commits, or stashes. A tree you did not dirty is not a
  finding, not a risk to raise, and not yours to summarise -- even as a
  courtesy note, and even while explaining what you did commit.
- Do not offer to clean it up, commit it, push it, or stash it. Silence is the
  whole response.
- Speak only when foreign state actually blocks you. Then name the one blocker
  and what you need, not a survey of the tree.
- Never revert another actor's change unless it is clearly an obvious mistake
  (e.g. accidental file truncation, committed secrets). When in doubt, leave
  it and work around it.
- The same tolerance applies when another agent shares your worktree or repo:
  coexist silently unless it actively interferes with your work.

Interference:

- An actor interferes when it repeatedly overwrites your edits, deletes your
  in-progress files, or otherwise prevents you from making progress -- not
  when it merely touches the same repo.
- On interference, do not fight for the shared checkout. Humans and parallel
  human checkouts stay on Worktrunk (`wt switch --create <branch> --base <base>`).
  Agents move to an isolated task checkout (`isolated: true`) and continue there.

Branch switched underneath you:

- A branch switch you did not perform is usually two agents conflicting over
  one checkout. Do not panic and never switch back -- that only plays branch
  ping-pong with the other agent.
- Instead: agents create a fresh isolated checkout (`isolated: true`); humans
  create a fresh Worktrunk checkout. Cherry-pick your commits onto it
  (stash-and-apply any uncommitted work), and continue from there. Leave
  the contested checkout to the other actor.
