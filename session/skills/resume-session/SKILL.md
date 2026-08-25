---
name: resume-session
description: Resume a prior agent session from its transcript. Triggers on "resume my session", "resume session <id>", "continue my last session".
---

# Resume Session

Reconstruct where a prior OMP session left off using the `resume_session` tool for
ALL discovery and reading, with two mandatory stops: **the user chooses the
session**, and **the user confirms before any work resumes**.

## Non-negotiable rules

MUST Use `resume_session` for everything. Never identify sessions by reading `.jsonl` files under `~/.omp/agent/sessions`, running `cat`/`tail`/`grep` on transcripts, or running `git log` yourself.
MUST Load **exactly one** session -- the one the user picks. Never read a second session's transcript.
MUST The two STOP gates below are hard. Until gate 1 is cleared, only `mode: "list"` is allowed. Until gate 2 is cleared, do not read files, run git, or start work.
MUST Session cwd in a different worktree than yours → confirm target worktree with the user before reading or editing any files.

## Workflow

1. **List sessions -- your first and only action so far.** Call
   `resume_session` with `mode: "list"` (defaults to the git repo root of the
   session cwd; pass `path` for another repo). It prints a newest-first summary:
   id, last-active, turns, branch, `worktree:`, title, and a `↳ left off:` line.
   - **Worktree-aware by default.** Enumerates every worktree (`git worktree list`)
     and matches transcripts by their recorded `cwd`. Pass `worktrees: false` to
     scan only the current checkout.
   - **Git-activity overview.** When the repo has more than one worktree, also
     prints a "Worktree git activity" block (most-recently-committed first) with
     branch, last-commit time + subject, and a `✎ dirty` mark. Pass `git: false` to skip.
   - **Branch label = the branch the session worked on** (recovered from its
     transcript), not the checkout's branch now. If the worktree has since
     switched, the row shows `[worked-on → worktree now on current]` -- a drift
     warning that on-disk files no longer match that session. Don't read the
     second branch as the session's work.

2. **STOP. Present the list and let the user choose.** Show the newest few rows
   including `worktree:` and `↳ left off:` lines, and ask which to resume.
   You may recommend, but **wait for their answer** -- do not pick for them.
   - Only exception: if the user already gave a session id, skip to step 3.

3. **Read that one session.** Call `resume_session` with `mode: "read"` and
   `session: "<id>"` (newest 8 turns, filtered, newest-first; an id prefix is
   enough). Anchor on the **Latest plan / todo state** block. Stop reading when
   you can state what was being done and what remains. Page back with
   `offset` + `turns` if still unclear. Never open another session.

4. **STOP. Summarize, surface ambiguities, and ask.** State: the goal, the last
   action, current todo/plan state, branch/cwd, and what is incomplete. List
   unrecorded decisions, half-done work, or paths that may be stale. Ask for
   confirmation and any new direction. **Wait.**

5. **Resume.** Only after the user confirms: run a quick reality check
   (`git status`, branch, referenced files exist), then continue from the agreed
   next step.

## Notes

- Current user instructions override anything in the transcript; it is evidence of the past.
- Do not silently re-run destructive or outward-facing actions (commits, pushes, deploys) -- reconfirm first.
- Each call prints an estimated uncached-token cost; report the total used vs. full transcript size.
- Set `include_thinking: true` only when the text record shows a logic gap, incomplete sentence, or unexplained branch that tool calls alone cannot resolve.
- A `compaction` marker in the window means earlier turns were summarized away in the original run; the summary is the only record of them.
- This skill resumes a session transcript; it does not read saved handover files.

See `references/transcript-format.md` for store locations, record schema, and filtering/paging.
