# Catchup Selection Judgment

Call `handover_select` first. It ranks the shared store by project match, worktree/repo path, recency, and named beads. Use this file only after the ranked list exists.

## After ranking

- If multiple candidates remain close at the top, ask one question with 2-4 choices (project/branch/task/updated) and recommend the highest-ranked one.
- If the selected handover branch differs from the current branch and the user did not name a matching task/branch, ask before editing.
- Treat placeholder-only scaffolds (`placeholder: true` in tool details) as incomplete, not as recovery prompts.
- If the recorded `repo_root` no longer exists and the only match is project name, ask before using it unless the user explicitly named the matching task or branch.
- Treat stale handovers as usable evidence, but verify paths, branch names, and commands before acting.

## No Handover Found

In a beads repo (`bd where` exits 0), recover from beads first: `bd list --status in_progress --json`, `bd ready --json`, then `bd show` on the in-progress beads. Report that recovery came from beads without a handover narrative, so Avoid/Do-Not-Redo context may be missing.

Otherwise inspect only enough context to orient the next step:

- `git branch --show-current`
- `git status --short`
- Recent commits and changed files
- Active spec artifacts when `.specify/`, `specs/`, or similar workflow folders exist
- Repo-local steering or handover conventions
- Memory, only after live repo evidence and labeled as memory-derived unless verified

Report that no matching handover was found before continuing from discovered evidence.
