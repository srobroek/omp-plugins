# Handover Structure

Write handovers to `~/.local/state/agentic-tools/handovers/` unless repo-local instructions define another untracked local-state handover path. Create the directory if missing. Use user-private permissions where supported, such as directory mode `0700` and file mode `0600`. Use `<project-slug>__<branch-or-task-slug>.md` and replace the prior file for the same project/worktree/branch.

Prefer `scripts/new-handover.py` when available; it creates the directory, normalizes slugs, writes frontmatter, and scaffolds the body sections. Pass `--beads <id1>,<id2>` in beads repos to get the narrative-only layout below.

Use YAML frontmatter for selection:

```yaml
---
project: project-slug
repo_root: /absolute/repo/root
worktree: /absolute/worktree/path
branch: branch-name
task: task-or-spec-id
beads: ["bd-1", "bd-2"]   # beads repos only: active bead IDs
updated: <ISO-8601 timestamp>
---
```

## Beads repos (narrative-only layout)

When `bd where` succeeds in the repo, task state lives in beads, not the file. Flush state into beads first (create/update/close/comment, then `bd dolt push` best-effort), then write a reduced body that keeps only the Summary, Read First, Decisions, Runtime State, Avoid / Do Not Redo, and Next Session Prompt items from the full layout below, plus:

- Active Beads: each active bead ID with one line on where its work stopped
- Next Session Prompt additionally directs the next session to `bd show <ids>`, `bd ready`, and `bd list --status in_progress`

Omit Changed Areas, Complete, Incomplete, Blockers, and Verification sections -- those are bead state. Do not duplicate task lists or status tables into the file.

## Non-beads repos (full layout)

The body should capture:

- Summary: 2-4 factual bullets
- what the next session should read first
- Changed Areas: paths, modules, or domains touched
- dirty working tree context when relevant, without recording old git status as durable truth
- what is already complete
- what is still incomplete
- Blockers: external dependencies, access issues, missing decisions, or `None known`
- the important design decisions already made, including task-local user corrections or latest explicit instructions that affect continuation
- Verification / Commands: material commands and outcomes, or `Not run`
- Runtime State: stable URLs, ports, containers, tunnels, or `None known`
- Avoid / Do Not Redo: failed attempts, stale assumptions, and what to do instead
- Next Session Prompt: copy-pastable instructions with exact files to inspect or edit

Use repo-relative plain paths for files inside the repo. Use absolute paths for repo root, worktree metadata, and external local-state paths.

Do not record exact git status as durable truth; `catchup` should check fresh git state. Include commit hashes or branch-base details only when the next session materially depends on them.

Do not include secrets, tokens, private keys, one-time codes, session cookies, or raw credential values. Reference secret locations or profiles instead.

Good handovers are implementation-directed, not narrative, and are never committed by default.
