---
name: handover
description: Save a self-contained recovery prompt in the shared handover store. Use when pausing work, switching context, or ending a session with incomplete work.
---

# Handover

Create a durable recovery prompt that `catchup` can read before doing fresh discovery. When the repo uses beads (`bd`), beads is the task-state store and the handover file carries only narrative.

## Workflow

1. Detect repo root, branch, and active worktree. Check for beads: `bd where` exits 0 when a beads workspace is active; if `bd` is not installed or `bd where` fails, skip every beads step below -- the workflow is then identical to a repo without beads.
2. If the session changed architecture, introduced tech debt, or has open corrections → run `session-review` first.
3. Gather the current implementation state:
   - changed areas and incomplete work
   - active spec/task progress
   - architectural decisions made this session
   - open risks or blockers
   - next concrete steps
4. Beads repos only -- flush task state into beads BEFORE writing the handover file:
   - File a bead for each remaining or newly discovered piece of work (`bd create`; add `--deps discovered-from:<active-id>` when it surfaced while working a bead).
   - Update statuses of beads whose state changed this session (`bd update <id> --status <status>`; close finished ones with `bd close`).
   - Add a closing comment on each active bead summarizing exactly where work stopped (`bd comment <id> "..."`).
   - Run `bd dolt push`; tolerate failure or "no remote" offline -- never block the handover on it.
5. Invoke the `new_handover` tool to scaffold the file in `~/.local/state/agentic-tools/handovers/`. Pass `task` when a spec id, issue id, or user-stated task is known; otherwise let the tool use the branch. In beads repos, pass `beads` as `<id1>,<id2>` with the active bead IDs; the tool then emits the narrative-only layout.
6. Replace the older handover for the same project/worktree/branch.
7. Verify the written file exists and is readable.
8. Tell the user where the handover was written and what the next session should load first.

## Rules

MUST The saved handover must be self-contained: no hidden chat context needed to resume. In beads repos, self-contained means narrative plus active bead IDs -- task state is intentionally in beads, not the file.
MUST In beads repos, flush task state into beads before writing the file, and omit task lists, state tables, Complete/Incomplete, and Blockers sections from the file -- point to `bd ready` / `bd list --status in_progress` instead.
MUST In beads repos, list the active bead IDs in the handover so catchup can jump straight to them.
MUST Beads steps degrade silently: if `bd` is missing or `bd where` fails, produce exactly the non-beads handover.
MUST Include enough metadata for selection: repo root, worktree path, branch, timestamp, and task/spec/issue identifiers when present.
MUST Include a copy-pastable Next Session Prompt.
MUST Include Blockers, Verification / Commands, Runtime State, and Avoid / Do Not Redo sections, even when they say `None known`, `Not run`, or `None`.
MUST Before handing off, commit and push completed work to its remote branch -- a handover is not a substitute for pushing. Never leave completed work only as uncommitted local state, especially in a disposable (`/tmp`) worktree.
MUST Record exact file paths and next steps, not vague summaries.
MUST Do not store secrets, tokens, or raw credential values.
MUST Never commit handover files -- they are ephemeral local state.
DEFAULT Include a short Summary section with 2-4 factual bullets.
DEFAULT Use repo-relative plain paths for files inside the repo; absolute paths for repo root, worktree metadata, and external local-state paths.
DEFAULT Include task-local user corrections or latest explicit instructions in Decisions when they affect continuation.
DEFAULT When branch divergence or mid-rebase state would affect the next step, include commit hashes or branch-base details.
- Remove or replace TODO placeholders before reporting the handover complete.
- If work is mid-refactor, explain the incomplete state explicitly.
- Do not store volatile session state in global memory. Handover files are the session bridge.
- Do not write generated runtime copies or compiled agent files as part of handover creation.

## References

When structuring the handover file, LOAD skill://handover/references/template.md.

## Scripts

The `new_handover` tool creates the shared handover directory, generates the filename and frontmatter, and writes the required markdown sections with user-private permissions where supported. `beads` as `<id1>,<id2>` records the active bead IDs in frontmatter and switches the body to the narrative-only beads layout. If the tool is unavailable, create the same file contract manually.
