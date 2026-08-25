# session

Resume a prior agent session from its own transcript.

The OMP session store is the only source. `history://<id>` resolves agents
registered in the *current* process, so a session persisted by an earlier `omp`
run is unaddressable that way — reading the store is required, not a shortcut.
Sessions are matched to a repository by the `cwd` each transcript records, never by
decoding the store's lossy `<escaped-cwd>` directory names, so worktrees and
symlinked paths resolve without guessing an encoding.

## Skills

- `resume-session` — pick up where a prior session left off, with two hard STOP
  gates: the user chooses the session, and the user confirms before work restarts

## Extensions

- `resume-session-tool` — registers the `resume_session` tool.
  - `mode: "list"` enumerates every worktree of the repo (`git worktree list`),
    scans the store for transcripts whose recorded `cwd` matches one of them, and
    prints newest-first rows: id (lengthened past 8 chars when ids collide),
    last-active, turn count, size, `compacted`/`continued`/`exit` flags, the
    worked-on branch with drift against that worktree's branch now, title, and a
    `↳ left off:` line. A second worktree adds a git-activity block ranked by last
    commit, with a `✎ dirty` mark.
  - `mode: "read"` renders ONE session as turns, newest-first, with tool calls
    folded into the turn that made them, the latest structured todo board as the
    plan anchor, `offset`/`turns` paging, compaction gaps marked, and an estimated
    uncached-token cost. Thinking blocks are dropped unless `include_thinking`.
  - Read-only. Both modes end in the STOP instruction the skill's workflow needs.

No record stores a git branch, so the branch label is recovered from the
transcript in four tiers — a confirmed switch, status output, an unconfirmed
creating command, a bare argument — and anything git did not confirm is labelled
`(inferred)`. `session/skills/resume-session/references/transcript-format.md`
documents the record schema, the tiers, and the measured cost of a scan.

## Rules

None.

## Agents

None.

## Tools

Registered by this plugin's extension module:

- `resume_session`

The legacy `catchup` and `handover` skills were not ported. `resume-session` reads
a session transcript and never a saved handover file.
