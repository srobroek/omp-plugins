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

if ! current_hooks="$(git config --path --get core.hooksPath 2>/dev/null)"; then
	current_hooks="$(git rev-parse --git-common-dir)/hooks"
fi
case "$current_hooks" in
/*) current_hooks_dir="$current_hooks" ;;
*) current_hooks_dir="$repo_root/$current_hooks" ;;
esac
current_hook="$current_hooks_dir/pre-commit"

if [[ "$current_hooks_dir" == "$hooks_dir" ]] ||
	{ [[ -f "$current_hook" ]] && cmp -s -- "$current_hook" "$hook"; }; then
	:
else
	git config --worktree agnix.previousHooksPath "$current_hooks"
fi

git config --worktree core.hooksPath .githooks
printf 'Installed agnix pre-commit hook for this worktree.\n'
