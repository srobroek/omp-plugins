# session

Resume a prior agent session from its own transcript.

The OMP session store is the only source. Sessions are matched to a repository by
the `cwd` each transcript records, not by decoding the store's directory names, so
worktrees and unusual paths resolve without guessing an encoding.

## Skills

- `resume-session` — pick up where a prior session left off, with two hard STOP
  gates: the user chooses the session, and the user confirms before work restarts

## Extensions

- `resume-session-tool` — registers the `resume_session` tool. `mode: "list"`
  enumerates every worktree of the repo (`git worktree list`), scans the store for
  transcripts whose recorded `cwd` matches one of them, and prints newest-first
  rows with turn count, worked-on branch, drift against the checkout's current
  branch, title, and a `↳ left off:` line. `mode: "read"` renders one session as
  turns, newest-first, with the latest structured todo state, `offset`/`turns`
  paging, and an estimated uncached-token cost. Thinking blocks are dropped unless
  `include_thinking` is set.

## Rules

None.

## Agents

None.

## Tools

Registered by this plugin's extension module:

- `resume_session`

Only `catchup`'s and `handover`'s predecessors were retired; this plugin does not
port them. `resume-session` reads a session transcript and never a handover file.
