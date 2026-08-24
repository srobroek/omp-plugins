#!/usr/bin/env bash
# pr-shepherd: deterministic merge-readiness probe.
#
# `conflicts` is a trimmed copy of packages/orchestrate/.apm/skills/orchestrate/
# scripts/conflict-probe.sh (git merge-tree prediction, no tree mutation);
# `pr` adds the gh PR state the shepherd's decision table needs.
#
# Usage:
#   merge-probe.sh conflicts <base-ref> <branch-ref>
#       -> prints conflicting paths (one per line); exit 0 clean, 1 conflicts,
#          2 error/unknown (bad refs, or old git without merge-tree --write-tree)
#   merge-probe.sh pr <pr-number>
#       -> prints gh pr view JSON: state, mergeability, review, checks; exit follows gh
#   merge-probe.sh eligibility
#       -> reads gh PR JSON on stdin; prints eligible|draft|release|closed
#
# Review-bot rounds are a separate probe: bot-review-probe.py (Python, because
# each bot signals actionability differently and that belongs in an adapter
# table, not in jq).
#
# Portability floor: bash 3.2 + BSD coreutils.
set -euo pipefail

die() { echo "merge-probe: $*" >&2; exit 2; }
command -v git >/dev/null || die "git not found"

cmd="${1:-}"; shift || true

case "$cmd" in
  eligibility)
    command -v jq >/dev/null || die "jq not found (needed for eligibility)"
    jq -er '
      if (.headRefName | startswith("release-please--branches--"))
        or any(.labels[]?; .name == "autorelease: pending") then "release"
      elif .state == "MERGED" then "merged"
      elif .state != "OPEN" then "closed"
      elif .isDraft == true then "draft"
      else "eligible"
      end
    '
    ;;

  conflicts)
    base="${1:?base ref}"; branch="${2:?branch ref}"
    base_sha="$(git rev-parse --verify "$base^{commit}" 2>/dev/null)" || die "bad base $base"
    br_sha="$(git rev-parse --verify "$branch^{commit}" 2>/dev/null)" || die "bad branch $branch"
    # Modern merge-tree predicts the merge without touching the tree.
    # --name-only output: line 1 = tree OID, then conflicted paths, then a
    # blank line and informational messages. Exit 1 = conflicts.
    # -z separates paths with NUL and emits them RAW. Without it git C-quotes any
    # unusual path -- a tab becomes the eleven characters "wei\trd.txt", quotes and
    # a literal backslash-t included -- and that quoted form flowed into
    # landing-contract.py's content-addressed `failure-key`, silently changing the
    # key and breaking bounce deduplication for that PR. Verified against real git.
    #
    # The output goes to a FILE, not a command substitution: bash strips NUL bytes
    # from "$(...)", which would undo -z entirely and silently re-join every path.
    zout="$(mktemp -t merge-probe.XXXXXX)"
    trap 'rm -f "$zout"' EXIT
    set +e
    git merge-tree --write-tree --name-only -z "$base_sha" "$br_sha" >"$zout" 2>/dev/null
    rc=$?
    set -e
    out="$(tr '\0' '\n' <"$zout")"
    if [ -z "$out" ]; then
      # Older git: cannot predict the merge. Exit 2 (error/unknown), NOT 0 --
      # 0 would report "clean" for a merge nobody probed. Still list the
      # branch's changed files so the caller can reason manually.
      mb="$(git merge-base "$base_sha" "$br_sha" 2>/dev/null || echo "$base_sha")"
      git diff --name-only "$mb" "$br_sha"
      echo "merge-probe: merge-tree unavailable; conflict state UNKNOWN (listed changed files only)" >&2
      exit 2
    fi
    if [ "$rc" -ne 0 ]; then
      # Records are NUL-separated: the tree OID first, then the conflicted paths,
      # then an empty record before the informational block. Split on NUL in Python
      # rather than shell: BSD awk cannot take NUL as RS (it stops after record 1),
      # and `tr '\0' '\n'` would corrupt a path that legitimately contains a
      # newline -- git leaves those raw under -z, verified against real git.
      #
      # Sorted bytewise, because landing-contract.py's failure-key hashes this list
      # in order and a locale-dependent collation would change the key.
      python3 -c '
import sys
data = open(sys.argv[1], "rb").read().split(b"\0")
paths = []
for record in data[1:]:
    if record == b"":
        break
    paths.append(record)
for path in sorted(set(paths)):
    sys.stdout.buffer.write(path + b"\n")
' "$zout"
      exit 1
    fi
    echo "clean"
    exit 0
    ;;

  pr)
    pr="${1:?pr number}"
    command -v gh >/dev/null || die "gh not found (needed for pr)"
    gh pr view "$pr" --json \
      number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,baseRefName,headRefName,headRefOid,mergeCommit,labels,body,url
    ;;

  *)
    die "usage: conflicts <base> <branch> | pr <number> | eligibility (got '${cmd:-}')"
    ;;
esac
