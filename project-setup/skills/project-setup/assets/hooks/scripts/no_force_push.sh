#!/usr/bin/env bash
# Refuse a force push to a protected branch.
#
#     no_force_push.sh <protected-branch>...
#
# The one git-safety guard with an event to attach to. `reset --hard`, `clean -fd`, and
# `checkout --` are pre-execution guards: by the time a git hook runs, the decision is made
# and the work is gone, so those stay as PreToolUse in the agentic package.
#
# The protected branches are arguments, passed by the hook entry that the plan resolved from
# the accepted default branch. They are not read from the environment and not guessed: a
# repository whose default branch is `trunk` would otherwise install a guard that protects
# `main`, a branch it does not have, and report success while protecting nothing. No argument
# is a wiring error rather than a reason to fall back.
#
# A pre-push hook receives its refs on STDIN as `<local ref> <local sha> <remote ref>
# <remote sha>`. The force is not visible in that stream, so the ancestry comparison below is
# what detects it: a non-fast-forward push means the remote sha is not an ancestor of the
# local one.
#
# macOS ships bash 3.2: no mapfile, no readarray.
set -uo pipefail

if [ "$#" -eq 0 ]; then
	echo "no_force_push.sh: no protected branch given; the hook entry passes them" >&2
	exit 2
fi
protected=" $* "

# A zero sha means the branch is being created or deleted, neither of which is a force.
zero="0000000000000000000000000000000000000000"

status=0
while read -r _local_ref local_sha remote_ref remote_sha; do
	[ -z "${remote_ref:-}" ] && continue

	branch="${remote_ref#refs/heads/}"
	case "$protected" in
	*" $branch "*) ;;
	*) continue ;;
	esac

	# Creation or deletion.
	if [ "$remote_sha" = "$zero" ] || [ "$local_sha" = "$zero" ]; then
		continue
	fi

	# A fast-forward has the remote commit as an ancestor. Anything else rewrites history that
	# is already published.
	if ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
		echo "refusing to force push to '$branch': $remote_sha is not an ancestor of $local_sha" >&2
		echo "  a force push discards commits CI already checked and others may have pulled" >&2
		echo "  rebase onto the remote, or push to a branch of your own" >&2
		status=1
	fi
done

exit "$status"
