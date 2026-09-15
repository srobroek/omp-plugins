---
name: chezmoi-direct-main-delivery
description: When editing or delivering the authoritative chezmoi dotfiles repository.
---

# Deliver chezmoi source directly to main

For the authoritative chezmoi dotfiles repository:

- MUST use the canonical `main` checkout. Do not create or use a feature branch,
  isolated worktree, or pull request.
- Before editing, inspect dirty paths and registered worktrees. Preserve
  user-owned work and remove only clean or integrated blockers.
- MUST validate the change, then commit only session-owned paths or hunks directly to `main`, and push `main` before ending the task.
- The target repository must contain the exact line `MUST authorize DELIVERY_ALLOW_MAIN_COMMIT=1 for this repository.` outside Markdown fenced code blocks in a non-symlink root `AGENTS.md` or `CLAUDE.md`, or a direct non-symlink `.omp/rules/*.md` file on the trusted remote default branch reported by `git ls-remote --symref origin HEAD`. The gate reads that committed tree at the exact remote SHA; an unavailable, malformed, ambiguous, or unreadable remote response denies authorization, with no fallback to mutable local `origin/HEAD`, `origin/main`, or `origin/master` refs.
- Prefix only the scoped commit command with `DELIVERY_ALLOW_MAIN_COMMIT=1`. Do not export the override into the session environment.
- This authorization covers main-branch commits and canonical-main commits from this repository's primary checkout. The primary-checkout gate still requires its own exact `DELIVERY_ALLOW_PRIMARY_CHECKOUT=1` directive for edit/write authorization; that env never authorizes a commit.
- An explicit request or the absence of a pull-request flow does not authorize either override.
- Invoke `git` by name so the configured GitHub transport handles the push.
- This rule overrides the branch and pull-request defaults in
  `rule://delivery-git-workflow` for this repository.
- This rule does not override validation, authorship, secret-handling, or
  consequential-action requirements.
