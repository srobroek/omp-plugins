# OMP session transcript format

What `resume_session` reads, and why it reads the store directly. Every shape here
was derived from the live store on a machine with 184 top-level transcripts; where
a field's meaning is inferred rather than observed, it says so.

## `history://` cannot do this

`history://<id>` resolves agents **registered in the current process** — live,
parked, or released subagents of the running `omp`. A top-level session persisted
by an *earlier* process is not in that registry, so it is unaddressable that way.
Resuming a prior session therefore has to read the store. Do not re-try
`history://` for this; it is not a permissions or syntax problem.

The tool renders what it reads as a normalized transcript — turn-shaped, filtered,
newest-first — so nothing downstream has to handle raw jsonl.

## Locations

```
~/.omp/agent/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl
~/.omp/agent/sessions/<escaped-cwd>/<timestamp>_<uuid>/      spilled tool output
```

- Config root: `$HOME/${PI_CONFIG_DIR:-.omp}`.
- Under a named profile (`$OMP_PROFILE` / `$PI_PROFILE`, or the tool's `profile`
  argument): `<config>/profiles/<name>/agent/sessions`. Not scanned unless asked
  for, because the active profile is the only one a resume normally means.
- The directory beside a transcript holds that session's spilled tool output as
  `<n>.<tool>.log` (the `artifact://` store). It is not a transcript; only
  `*.jsonl` one level under the root counts.

`<escaped-cwd>` is lossy — `/Users/you/tmp` becomes `-tmp`, and so does a
`/tmp`-rooted path under a different rule. **Never reverse it.** Match sessions
by the `cwd` the `session` record states outright. Both the literal and the
`realpath` spelling are accepted, because a session records the cwd it was started
in (`/tmp/x`) while `git rev-parse --show-toplevel` answers with the resolved one
(`/private/tmp/x`).

## Records

One compact JSON object per line, no spaces after separators. `type` discriminates.
Observed census over an 18-file sample: `message` 13981, `custom` 8822,
`custom_message` 528, `thinking_level_change` 125, `ttsr_injection` 97,
`model_change` 63, `mode_change` 52, `title_change` 15, `compaction` 14, `title` 13,
`session` 13, `service_tier_change` 1, `branch_summary` 1.

### `title` — first line, rewritten in place

```json
{"type":"title","v":1,"title":"Add generic beads defect detection","source":"auto",
 "updatedAt":"2026-08-25T10:25:13.620Z","pad":"        …"}
```

`pad` exists so the record keeps a fixed width and can be overwritten without
rewriting the file. That makes `updatedAt` the session's **live last-active time**,
readable from the first 16 KB — no tail scan needed to sort a listing.

### `session` — identity

```json
{"type":"session","version":3,"id":"01a03386-…","timestamp":"2026-08-24T11:27:39.091Z",
 "cwd":"/Users/sjors/personal/dev/omp-orchestrate",
 "previousSessionFiles":["/Users/sjors/.omp/agent/sessions/-.local-share-chezmoi/…jsonl"]}
```

`cwd` is the only reliable project key. `previousSessionFiles` marks a session
continued from earlier files; the row flags it as `continued`.

### `message` — the conversation

`message.role` is `user`, `assistant`, `toolResult`, or `developer`. Observed
distribution in one 4857-record session: `toolResult` 1514, `assistant` 1479,
`user` 96, `developer` 1.

`message.content` is a block array:

| block | fields | note |
| --- | --- | --- |
| `text` | `text` | prose |
| `thinking` | `thinking`, `thinkingSignature` | ~half of all assistant blocks; dropped unless `include_thinking` |
| `toolCall` | `id`, `name`, `arguments`, `intent` | `intent` is the human label |

An assistant message also carries `usage`, `contextSnapshot`, `model`, `provider`,
`stopReason`, `duration`, `ttft`. A `toolResult` carries `toolCallId`, `toolName`,
`isError`, `details`, and sometimes `useless: true`.

`toolResult` records are folded into the assistant turn that called them, keyed by
`toolCallId`, so a window reads as a conversation rather than a record dump.

### `toolName: "todo"` — the plan state

The result's `details` carries the **entire board**, not the delta:

```json
{"op":"done","phases":[{"name":"Detection","tasks":[{"content":"…","status":"completed"}]}],
 "storage":"session","completedTasks":[…]}
```

So the newest `todo` result is the authoritative plan state; reconstructing it from
the `init`/`append`/`done`/`block`/`unblock`/`rm`/`start` op stream is unnecessary.
Some results are synthetic (`{"__synthetic":true,"source":"interrupt_skipped"}`)
and carry no `phases`; those are skipped.

### `compaction` — a hole in the record

```json
{"type":"compaction","method":"…","shortSummary":"…","summary":"…","firstKeptEntryId":"…",
 "tokensBefore":…,"tokensAfter":…}
```

Turns before it survive only as its summary. The window marks the gap rather than
presenting a continuous history.

### `custom` / `custom_message`

`custom` is mostly `tool_execution_start` (one per tool call) plus
`session_exit` (`{"reason":"dispose","kind":"normal"}`), which tells you how the
session ended. `custom_message` carries harness chatter: `advisor`, `async-result`,
`launch-completion`, `mid-run-todo-nudge`, `ttsr-injection`, `irc:incoming`,
`lsp-late-diagnostic`, `plan-mode-context`, `orchestrate-notice`.

### `branch_summary` is not a git branch

```json
{"type":"branch_summary","fromId":"…","summary":"","details":{"kind":"discarded-entry-branch"}}
```

It records a **conversation** branch — an edit or rewind that discarded entries.
Nothing in the store records a git branch.

## Recovering the git branch

No `gitBranch` field exists (verified: zero occurrences across the whole store), so
the branch a session worked on is recovered from what it ran, in tiers:

1. **switched** — git confirming that *this session* moved onto a branch:
   `Switched to (a new) branch 'x'`, `branch 'x' set up to track`.
2. **status** — genuine git output, but about whatever directory the command ran
   in: `On branch x`, `Your branch is up to date with 'origin/x'`. For an
   orchestrating session that directory is often a sibling worktree, which is why
   this must never displace a tier-1 sighting.
3. **created** — an explicit creating command whose output was not captured:
   `git checkout -b x`, `git switch -c x`, `git worktree add … -b x`. Global
   options are tolerated (`git -C dir …`, `dgit …`).
4. **mentioned** — a bare `git checkout x` or a `git push <remote> x` argument.
   Weakest: the command may have failed.

The latest sighting in the strongest tier available wins, because a session ends on
the branch it last moved to. Filenames, shas, `HEAD`, and option-shaped tokens are
rejected. Tiers 3 and 4 are labelled `(inferred)`; git never confirmed them.

Observed on 8 real sessions across 3 projects: 4 `switched`, 1 `mentioned`,
3 `null` (short sessions that ran no git command). Orchestrating sessions commonly
resolve to their own checkout's branch rather than a child worktree's, which is
correct — the children did that work in their own sessions.

**Drift** is the branch label against the worktree's branch *now*: when they differ
the row says `[worked-on → worktree now on <current>]`, meaning on-disk files no
longer match that session's work.

## Filtering and paging

- Turns with neither prose nor a tool call are dropped — protocol artefacts.
- Tool results are clipped to 240 chars, turn text to 1600.
- `turns` (default 8) and `offset` page a window; rendering is newest-first and
  stops on a turn boundary when `max_chars` (default 14000) runs out, so a partial
  turn never reads as a whole one.
- Every window reports an estimated uncached token cost at ~4 chars/token. It is
  uncached because the window is generated fresh per call.

## Cost of reading

The whole file is read and parsed. The largest transcript observed (21 MB, 6229
records) reads and parses in ~40 ms, so windowing the read would buy nothing and
would turn the turn count into a guess. Listing filters on a 16 KB head read
first — 184 files scan in ~35 ms — and only fully parses the sessions that belong
to the project.
