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
- MUST validate the change, commit only session-owned paths or hunks directly to
  `main`, and push `main` before ending the task.
- Prefix only the scoped commit command with `DELIVERY_ALLOW_MAIN_COMMIT=1`.
  Do not export the override into the session environment.
- Invoke `git` by name so the configured GitHub transport handles the push.
- This rule overrides the branch and pull-request defaults in
  `rule://delivery-git-workflow` for this repository.
- This rule does not override validation, authorship, secret-handling, or
  consequential-action requirements.
