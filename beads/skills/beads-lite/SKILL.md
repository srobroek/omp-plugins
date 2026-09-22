---
name: beads-lite
description: Tracks work as beads with dependencies and role labels. Use when asked to track work in beads or show what is ready.
---

# Beads Lite

TRIGGER
+ "track this work in beads"
+ "create the DAG"
+ "what is ready"
- A single edit nobody else coordinates on → skip the ledger

## Workflow

1. Run `bd prime` once per session: it is the single source of truth for operational commands.
2. Locate or create the store, then read existing beads for the project's own conventions.
3. Shape the work: `epic` for a large stream with subtasks, `feature` for new functionality, `task` for a bounded work item, `bug` for something broken, `chore` for maintenance.
4. Express order with `bd dep add <issue> <depends-on>`. Independent work gets no dependency.
5. Label every bead with `role:<name>` so a worker can pull its own work.
6. Pull with `bd ready`, claim atomically with `bd update <id> --claim`, do the work, then `bd close <id>` with evidence.
7. Release a bead you cannot finish with `bd unclaim <id>`.

## Quick reference

```bash
bd prime                              # complete workflow context (SSOT)
bd ready                              # issues ready to work, no blockers
bd list --status=open                 # all open issues
bd create "title" -t task -p 2        # create an issue
bd update <id> --claim                # claim work atomically
bd unclaim <id>                       # release a stuck issue
bd close <id> --reason "<evidence>"   # complete with evidence
bd comment <id> "<finding>"           # record evidence or a verdict
bd dep add <issue> <depends-on>       # add a dependency
bd show <id> --json                   # read one bead's assignment
bd blocked                            # what is waiting and on what
```

Priorities: `0` critical, `1` high, `2` medium default, `3` low, `4` backlog.

## Store safety

the store is embedded and lives in the canonical checkout.
linked worktrees share it.
`BEADS_DIR` does not redirect `bd init` away from canonical.
no Dolt server may be started.
two concurrent writers corrupt the Dolt journal.
a contended `bd` call is retried rather than worked around.

## Rules

MUST track every unit of work as a bead, never as a markdown TODO or a comment list.
MUST create the bead before the work starts.
MUST close a bead with checkable evidence: the command run, the path changed, or the test result.
MUST treat a refused claim as another worker's ownership and pull the next ready bead.
MUST reach for `bd prime` or `bd --help` for an exact flag instead of guessing one.
DEFAULT pick the smallest issue type that describes the work.
DEFAULT treat commit, push, and remote sync as authorized handoff actions, not automatic steps.
NOT force, reclaim, or reassign a bead another actor holds.
NOT record state in prose, in a comment alone, or in an agent's memory.
