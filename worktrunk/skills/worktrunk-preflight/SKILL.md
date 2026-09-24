---
name: worktrunk-preflight
description: Run deterministic Worktrunk checks before an agent run, merge, or focused test; triggers on "preflight Worktrunk" or "check worktree".
---

# Worktrunk Preflight

Run this skill from the repository cwd before starting work, running focused tests, or merging a branch. It works without Orchestrate and without Beads.

## Invocation

```sh
python3 skills/worktrunk-preflight/preflight.py --json
```

Use `--only ID[,ID...]` to select checks. The script is read-only unless `--apply` is passed. `--apply` runs only `wt config approvals add --yes` when `hook-approvals` fails, then rechecks it.

## Checks and remedies

- `wt-available` — FAIL means `wt --version` cannot run; install or expose Worktrunk on `PATH`.
- `inside-git-repo` — FAIL means the cwd is not inside Git; run from the repository.
- `cwd-is-worktree-not-canonical` — WARN means the cwd is canonical; run `wt switch -y --create --no-cd --base <base-commit> --format json <branch>` and work in the returned linked worktree.
- `hook-approvals` — FAIL means an unapproved project hook would be skipped silently; run `wt config approvals add --yes`. Stale approvals are WARN.
- `config-keys-honoured` — FAIL means project config contains an ignored key; move it to `~/.config/worktrunk/config.toml`, optionally under `[projects."<id>"]`.
- `default-branch-resolves` — FAIL means Worktrunk cannot resolve a default branch; configure a valid default branch.
- `merge-evidence-policy` — FAIL means project `[merge]` keys are ignored; move policy to user config and pass `wt merge --no-squash --no-ff` explicitly on every worker-to-epic merge; an epic-to-default merge may be plain or squashing.
- `provisioning-include` — WARN means ignored dependency directories lack `.worktreeinclude`; run `wt step copy-ignored`.
- `omp-plugin-installed` — WARN means the OMP plugin is absent; run `wt config plugins omp install`.
- `commit-generation` — WARN means generated commits make `wt merge` squash history; pass `wt merge --no-squash` when preserving per-commit history.

Exit status is zero when no check fails. JSON output contains `ok`, a status summary, and each check's `id`, `status`, `detail`, and `fix`.
