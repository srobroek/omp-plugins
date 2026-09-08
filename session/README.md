# session

Resume a prior agent session from its own transcript.

The tool reads the OMP session store directly. `history://<id>` does not expose every persisted session, including unregistered top-level sessions from earlier runs.

The tool matches sessions to repositories using each transcript's recorded `cwd`, not the store's lossy `<escaped-cwd>` directory names. This supports worktrees and symlinked paths without guessing a directory-name encoding.

## Skills

- `resume-session`: resume a prior session with two STOP gates. First, the user chooses the session. Before work restarts, the user confirms.

## Tools

The `resume-session-tool` extension registers the read-only `resume_session` tool. Both modes end with the STOP instruction required by the skill's workflow.

### List sessions

`mode: "list"` enumerates the repository's worktrees through `git worktree list`. It scans the store for transcripts whose recorded `cwd` matches a worktree.

Rows appear newest-first and contain:

- Session id. When ids collide, the tool lengthens them beyond eight characters.
- Last-active timestamp, turn count, and size.
- `compacted`/`continued`/`exit` flags.
- Worked-on branch and drift against that worktree's checked-out branch.
- Title and a `↳ left off:` line.

When the repository has a second worktree, output also includes a git-activity block ranked by last commit, with a `✎ dirty` mark.

### Read a session

`mode: "read"` renders one session as turns, newest-first. Each turn includes its tool calls.

The output includes:

- The latest structured todo board as the plan anchor; an empty board clears earlier tasks.
- `offset`/`turns` paging pinned to the selected transcript's absolute file path, retaining the read window and thinking settings.
- Marked compaction gaps.
- An estimated uncached-token cost.

Unless you set `include_thinking: true`, the tool omits thinking blocks.

`max_chars` caps complete turn text, including compaction markers; metadata is
outside that budget. If the next turn does not fit, the tool reports the
minimum required budget without emitting a partial turn.

### Inputs and limits

`file` accepts an explicit transcript outside the store with read approval. `profile` accepts a single profile name, not a path.

Reads accept only regular files no larger than 64 MiB. Listings scan at most 20,000 directory entries and 256 MiB of matching transcripts. Output is limited to 1,000,000 characters.

Exceeding a bound produces an actionable error rather than silently dropping metadata. Depending on the bound:

- Use a smaller exported transcript with `file`.
- Reduce output windows.
- Archive older sessions.

Listing order uses parsed last-active timestamps, not filesystem time.

### Branch inference

Session records have no dedicated git-branch field. The tool recovers the branch label from transcript content in this priority order:

1. A confirmed switch.
2. Status output.
3. An unconfirmed branch-creation command.
4. A bare argument.

The tool labels anything git did not confirm as `(inferred)`.

`session/skills/resume-session/references/transcript-format.md` documents the record schema, inference tiers, and measured scan cost.

The plugin does not provide the legacy `catchup` and `handover` skills. `resume-session` reads a session transcript, never a saved handover file.
