#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

hooks_dir="$repo_root/.githooks"
hook="$hooks_dir/pre-commit"
if [[ ! -x "$hook" ]]; then
	printf 'missing executable hook: %s\n' "$hook" >&2
	exit 1
fi

# Worktree config keeps one checkout from changing another checkout's hooks.
git config extensions.worktreeConfig true

if ! previous_hooks="$(git config --get core.hooksPath 2>/dev/null)"; then
	previous_hooks="$(git rev-parse --git-common-dir)/hooks"
fi

if ! git config --worktree --get agnix.previousHooksPath >/dev/null 2>&1; then
	git config --worktree agnix.previousHooksPath "$previous_hooks"
fi

git config --worktree core.hooksPath .githooks
printf 'Installed agnix pre-commit hook for this worktree.\n'
