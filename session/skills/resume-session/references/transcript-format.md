# OMP transcript reading

The `resume_session` tool extracts selected context from an earlier top-level OMP session. It does not restore that session or append its full history to the current conversation.

## Native APIs

The extension uses these public OMP APIs:

| API | Purpose |
| --- | --- |
| `listSessionsReadOnly` | Discover session identities without repairing backups or changing files. |
| `visitEntriesFromFileStream` | Visit JSONL records without retaining the full file. |
| `FileSessionStorage` | Supply the native filesystem backend for discovery. |

The plugin adds worktree matching, branch evidence, and handoff formatting. Native `history://` serves agent transcripts from the registry and artifact directories. It does not discover arbitrary top-level sessions.

## Store locations

The default store is:

```text
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

A directory beside each transcript holds spilled tool output:

```text
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>/
```

Discovery examines transcript files inside each project directory. It does not descend into artifact directories.

`PI_CONFIG_DIR` overrides `.omp`. A named profile uses `<config>/profiles/<name>/agent/sessions`. The explicit `profile` argument takes precedence over `OMP_PROFILE` and `PI_PROFILE`.

Encoded directory names can collide. Match the `cwd` in session metadata instead of reversing that encoding. Accept both the literal path and its filesystem-resolved spelling.

## Identity and titles

The native loader understands the fixed title slot and legacy JSON title records. A session header supplies identity:

```json
{"type":"session","version":3,"id":"example-id","timestamp":"2026-08-24T11:27:39.091Z","cwd":"/repo/main","previousSessionFiles":[]}
```

Relevant fields:

| Field | Meaning |
| --- | --- |
| `id` | Session identity, independent of the current process. |
| `cwd` | Directory where the session began. |
| `timestamp` | Session creation time. |
| `previousSessionFiles` | Earlier files in a continued session. |
| `title` | Title supplied by the header or native title slot. |

Legacy title records can contain `title`, `updatedAt`, and padding for an in-place update. The tool also checks record timestamps when computing activity time.

## Conversation records

A `message` record wraps a message with a `role` and `content`. Content can be text or an array of blocks.

| Block type | Handoff treatment |
| --- | --- |
| `text` | Keep the text, with an explicit rendering limit. |
| `thinking` | Omit unless `include_thinking` is true. |
| `toolCall` | Keep the tool name and a brief argument or intent summary. |
| Image or attachment | Omit from the handoff. |

Keep user and assistant messages that contain visible text or a tool call. Exclude developer messages, protocol noise, and empty turns.

Tool-result messages use `toolCallId` to identify their assistant call. Keep a clipped result and its error flag with that call. A result can occur after other messages without losing its association.

## Latest plan

The `todo` tool's result carries a complete board in `message.details.phases`:

```json
{"phases":[{"name":"Delivery","tasks":[{"content":"Confirm release approval","status":"blocked"}]}]}
```

Use the latest actual board, not a reconstruction from operation names. A later empty board clears earlier tasks. Ignore synthetic results that contain no board.

Rendering limits the plan to 6,000 characters and reports clipping. This limit does not change the stored task state.

## Compaction and exit records

A `compaction` record marks a context boundary. Count its position after filtering empty turns. Include up to three recent `shortSummary` values, each limited to 400 characters.

A custom `session_exit` entry supplies `data.kind` and `data.reason`. This entry describes how the previous session ended. It does not authorize further actions.

A `branch_summary` entry describes a conversation branch, not a Git branch.

## Git branch evidence

Recover the branch from transcript evidence in this priority order:

1. A confirmed Git switch or tracking-branch setup.
2. Git status output.
3. A branch-creation command without confirmed output.
4. A command that only mentions a branch.

Within one priority level, the latest evidence wins. Label the last two levels as inferred. Reject filenames, commit hashes, and `HEAD` as branch names.

Status output can describe a child worktree. It must not override a confirmed switch in the session. If the worktree now uses a different branch, show that difference separately.

## Window selection

`turns` defaults to eight. `offset` skips that many newest filtered turns. Output runs newest-first, while displayed turn numbers remain chronological.

The first streaming pass computes exact metadata and the latest plan. The second pass retains only the requested turn window and its tool-result associations. Neither pass creates an array of all historical turns.

`max_chars` limits rendered turns and their compaction markers. Stop between rendered turns rather than cutting a turn in half. Long text bodies and tool results carry explicit clipping notices.

The plan and other metadata sit outside the turn budget. Title and compaction-summary limits prevent large metadata fields from dominating the response.

Paging instructions include the selected file path. A later page must not resolve a different transcript because of an ambiguous id prefix or a changed project directory.

## Read safety and cost

Only read regular files. Bound each streaming pass by its starting file size. If the source changes during a read, return an error rather than mix two snapshots.

Skip malformed JSONL records and values that are not objects. A truncated final record must not hide earlier valid records. Cancellation ends the read without reporting partial success.

The tool does not open `SessionManager`, acquire a writer lock, migrate sessions, or resolve image blobs. Current user instructions remain authoritative over transcript content.

Report the output's estimated token cost separately from the source's byte-based token estimate. Sum output costs across discovery and read windows. These estimates do not measure provider billing or cache hits.
