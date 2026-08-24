#!/usr/bin/env bash
# orchestrate: deterministic merge-conflict + CI probe for the Shepherd.
#
# Predicts whether a branch merges cleanly into a base WITHOUT mutating any tree
# (git merge-tree), and reports CI status for its PR if one exists. The Shepherd
# leaves merge ordering to successful merge-slot acquisition and pushback from
# these facts instead of guessing.
#
# This script is self-contained on purpose: orchestrate and pr-shepherd are separate
# tools, so nothing here may reach into another package's scripts at runtime. The two
# merge actors coordinate through the `integration_owner` metadata contract instead.
#
# Usage:
#   conflict-probe.sh conflicts <base-ref> <branch-ref>
#       -> prints conflicting paths (one per line); exit 0 clean, 1 conflicts, 2 error
#   conflict-probe.sh pairwise <base-ref> <branch-a> <branch-b>
#       -> do A and B touch overlapping files vs base? exit 0 disjoint, 1 overlap
#   conflict-probe.sh ci <pr-number|branch>
#       -> prints `gh pr checks` summary; exit follows gh (needs gh + network)
set -euo pipefail

die() {
  printf 'conflict-probe: %s\n' "$*" >&2
  exit 2
}
command -v git >/dev/null || die "git not found"

cmd="${1:-}"
shift || true

case "$cmd" in
conflicts)
  base="${1:?base ref}"
  branch="${2:?branch ref}"
  base_sha="$(git rev-parse --verify "$base^{commit}" 2>/dev/null)" || die "bad base $base"
  br_sha="$(git rev-parse --verify "$branch^{commit}" 2>/dev/null)" || die "bad branch $branch"
  # Modern merge-tree predicts the merge without touching the tree.
  # --name-only output: line 1 = tree OID, then conflicted paths, then a
  # blank line and informational messages. Exit 1 = conflicts. Any nonzero
  # result without conflict paths is unknown and must not be reported clean.
  set +e
  out="$(git merge-tree --write-tree --name-only "$base_sha" "$br_sha" 2>/dev/null)"
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    paths="$(printf '%s\n' "$out" | sed -n '2,/^$/p' | sed '/^$/d' | sort -u)"
    tree_oid="$(printf '%s\n' "$out" | sed -n '1p')"
    if [[ "$tree_oid" =~ ^[0-9a-fA-F]{40,64}$ && -n "$paths" ]]; then
      printf '%s\n' "$paths"
      exit 1
    fi
    die "merge-tree could not classify $base and $branch"
  fi
  printf 'clean\n'
  exit 0
  ;;

pairwise)
  base="${1:?base}"
  a="${2:?branch a}"
  b="${3:?branch b}"
  mba="$(git merge-base "$base" "$a" 2>/dev/null)" || die "cannot find merge base for $base and $a"
  mbb="$(git merge-base "$base" "$b" 2>/dev/null)" || die "cannot find merge base for $base and $b"
  fa="$(git diff --name-only "$mba" "$a" | sort -u)" || die "cannot diff $a"
  fb="$(git diff --name-only "$mbb" "$b" | sort -u)" || die "cannot diff $b"
  overlap="$(comm -12 <(printf '%s\n' "$fa") <(printf '%s\n' "$fb") || true)"
  if [[ -n "$overlap" ]]; then
    printf 'overlap:\n%s\n' "$overlap"
    exit 1
  fi
  printf 'disjoint\n'
  exit 0
  ;;

ci)
  ref="${1:?pr number or branch}"
  command -v gh >/dev/null || die "gh not found (needed for ci)"
  gh pr checks "$ref"
  ;;




*)
  die "usage: conflicts|pairwise|ci (got '${cmd:-}')"
  ;;
esac
