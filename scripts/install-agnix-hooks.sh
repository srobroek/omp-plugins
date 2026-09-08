#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

tracked_hooks_dir="$repo_root/.githooks"
tracked_pre_commit="$tracked_hooks_dir/pre-commit"
if [[ ! -x "$tracked_pre_commit" ]]; then
	printf 'missing executable hook: %s\n' "$tracked_pre_commit" >&2
	exit 1
fi

# Worktree config keeps one checkout from changing another checkout's hooks.
git config extensions.worktreeConfig true

git_dir="$(git rev-parse --git-dir)"
case "$git_dir" in
/*) ;;
*) git_dir="$repo_root/$git_dir" ;;
esac
agnix_hooks_dir="$git_dir/agnix-hooks"
default_hooks="$(git rev-parse --git-common-dir)/hooks"

if ! current_hooks="$(git config --path --get core.hooksPath 2>/dev/null)"; then
	current_hooks="$default_hooks"
fi
case "$current_hooks" in
/*) current_hooks_dir="$current_hooks" ;;
*) current_hooks_dir="$repo_root/$current_hooks" ;;
esac
current_hook="$current_hooks_dir/pre-commit"

installer_active=0
recorded_hooks_dir="$(git config --worktree --get agnix.hooksPath 2>/dev/null || true)"
if [[ "$current_hooks_dir" == "$tracked_hooks_dir" ||
	(-n "$recorded_hooks_dir" && "$current_hooks_dir" == "$recorded_hooks_dir") ]]; then
	installer_active=1
fi

if ((installer_active)); then
	previous_hooks="$(git config --worktree --get agnix.previousHooksPath 2>/dev/null || true)"
	[[ -n "$previous_hooks" ]] || previous_hooks="$default_hooks"
else
	previous_hooks="$current_hooks"
	git config --worktree agnix.previousHooksPath "$previous_hooks"
fi
case "$previous_hooks" in
/*) previous_hooks_dir="$previous_hooks" ;;
*) previous_hooks_dir="$repo_root/$previous_hooks" ;;
esac

rm -rf "$agnix_hooks_dir"
mkdir -p "$agnix_hooks_dir"
ln -s "$tracked_pre_commit" "$agnix_hooks_dir/pre-commit"
if [[ -d "$previous_hooks_dir" && "$previous_hooks_dir" != "$agnix_hooks_dir" ]]; then
	for existing_hook in "$previous_hooks_dir"/*; do
		[[ -f "$existing_hook" ]] || continue
		hook_name="${existing_hook##*/}"
		[[ "$hook_name" == "pre-commit" ]] && continue
		ln -s "$existing_hook" "$agnix_hooks_dir/$hook_name"
	done
fi

git config --worktree agnix.hooksPath "$agnix_hooks_dir"
git config --worktree core.hooksPath "$agnix_hooks_dir"
printf 'Installed agnix pre-commit hook for this worktree.\n'
