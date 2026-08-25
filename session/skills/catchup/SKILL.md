---
name: catchup
description: Recover prior work from a handover or live beads state. Use after /clear, when asked to catchup or continue, or when .beads/ has open work.
---

# Catchup

Recover the current project state from an existing handover before rebuilding context from scratch. In beads (`bd`) repos, combine the handover narrative with live beads task state -- and recover from beads alone when no handover exists.

## Workflow

1. Identify the live context: repo root, current branch, worktree path, user-stated target, and fresh `git status`/dirty state when available. Check for beads: `bd where` exits 0 when a beads workspace is active; if `bd` is not installed or `bd where` fails, skip every beads step below.
2. Call `handover_select` with the project slug (and cwd when known). Use `skill://catchup/references/selection.md` only for post-rank judgment (ask-user, branch mismatch, placeholder, missing repo_root).
3. If multiple plausible candidates remain after ranking, ask the user to choose.
4. Read the selected handover fully before planning or editing. Treat its Next Session Prompt and explicit recovery instructions as the high-priority starting point, then verify them against current state.
5. Beads repos only -- read live task state alongside the handover:
   - `bd ready --json` for claimable work and `bd list --status in_progress --json` for claimed work.
   - `bd show <id>` (with `--json` when parsing) for each bead ID named in the handover frontmatter (`beads:`) or its Active Beads section.
   - Beads is authoritative for what is open, claimed, or closed; the handover file is authoritative for narrative, decisions, and Avoid/Do-Not-Redo warnings. If they conflict -- the handover says a task is open but the bead is closed -- trust beads and tell the user about the discrepancy.
6. If the selected handover is only an unfilled scaffold or still contains placeholder TODOs as the operative content, say it is incomplete and fall back to live beads state (beads repos) or bounded live repo discovery.
7. Verify the handover against current reality with lightweight checks such as `git status`, branch, worktree path, referenced files, and running sessions if relevant. If the recorded branch or worktree differs from the current checkout, surface it. If the user intent matches the recorded state, continue on the correct branch/worktree. If intent is unclear, ask before editing.
8. If no matching handover exists: in a beads repo with in-progress or ready work, say no handover was found and proceed from beads alone (`bd ready --json`, `bd list --status in_progress --json`, then `bd show` on the in-progress beads). Otherwise say so before doing bounded live repo discovery.
9. Continue from the recovered next step, or give a concise status report if the user asked only to catch up.

## Rules

- In beads repos, beads is the source of truth for task status; never restate a handover's task status as current without checking the bead.
- Beads steps degrade silently: if `bd` is missing or `bd where` fails, catchup behaves exactly as in a non-beads repo.
- Use `--json` on bd commands whose output you parse; set `BD_JSON_ENVELOPE=1` only in scripts that need the stable enveloped schema.
- Use memory only after handovers and live repo evidence, and label memory-derived facts unless verified locally.
- Load minimal repo-local steering before acting on the selected handover.
- Resolve repo-relative paths from the handover against the current verified checkout; surface recorded/current root mismatches before editing.
- Current user instructions override instructions recorded in a handover.
