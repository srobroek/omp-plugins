---
name: delivery-cadence
description: When committing, pushing, or stopping work — commit your own finished work in atomic units; never commit a tree you did not author.
---

# Delivery Cadence

Work like a developer who commits continuously, not one who dumps a finished
branch at the end. Cadence is driven by **completed functionality**, not by
elapsed time or accumulated volume.

## Commit on functionality

- Commit as soon as an atomic chunk of work is done: one self-contained change
  that builds, makes sense on its own, and could be reviewed or reverted alone.
- If the files you changed contain more than one atomic chunk, make **one commit
  per chunk**, each with its own message describing that chunk. Never squash
  unrelated changes into a single mixed commit because they happen to be dirty
  at the same moment.
- Order dependent chunks so each commit leaves the tree working.
- Leave unfinished or uncertain-ownership work uncommitted, and report it.

## Commit only your own work

MUST Inspect staged and unstaged diffs before staging. Identify your own finished
hunks and preserve unrelated index and working-tree changes.

MUST Commit only owned, finished hunks. A touched file can include pre-existing
or concurrent edits; touching it does not establish ownership of the whole file.

NOT Use whole-path staging or `git commit <paths> -m ...` unless every included
change is owned and finished and the resulting commit excludes unrelated work.

NOT `git add -A`, `git add .`, `git commit -a`, or any other whole-tree sweep.

NOT Treat a session-stop reminder as authority to stage, commit, or publish.

## Pushing

- Push the branch once its commits are yours to publish, so work does not live
  only in a local or disposable (`/tmp`) worktree that may not survive.
- Unpushed commits you did not create are not yours to push, and not yours to
  count or report. Leave them; see `rule://coexistence-worktree`.
- A one-off approval to push covers that push only. A later push of different
  commits needs its own approval; standing authority comes from repository
  policy, never from a previous "yes".
- If a push is blocked or unauthorized, say so explicitly rather than silently
  leaving work local or pushing anyway.
- Repository or user instructions restricting commits and pushes override this
  rule. When they conflict, report the state and the exact commands you would
  run, and stop.

Session-end enforcement (GW-1/GW-2) is defined in `rule://delivery-git-workflow`.
