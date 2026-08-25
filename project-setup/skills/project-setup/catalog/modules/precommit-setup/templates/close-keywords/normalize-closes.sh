#!/usr/bin/env bash
set -euo pipefail

# normalize-closes.sh
#
# Fix the GitHub "comma-list close" quirk: a closing keyword binds to ONLY the
# first issue in a list, so `Closes #37, #38, #39` closes just #37 and leaves
# #38/#39 open. This distributes the keyword across every ref in a CONTIGUOUS
# list directly following it:
#   `Closes #37, #38 and #39`  ->  `Closes #37, closes #38, closes #39`
#
# Reads text on stdin, writes the normalized text on stdout. Idempotent: a list
# whose refs already each carry a keyword is left unchanged. Shared engine for
# the commit-msg hook and the PR-body PreToolUse guard.
#
# Scope (deliberately conservative — lowest false-rewrite risk):
#   - Only a list IMMEDIATELY following a keyword is distributed. A later,
#     unrelated `#N` mention elsewhere on the line is NOT touched.
#   - Separators inside the list: `, ` / `,` / ` and ` / `, and `.
#   - Ref forms: #N, owner/repo#N, GH-N (case-insensitive GH-).
#   - The distributed keyword copies use the lowercased keyword word; the
#     original (first) keyword keeps its case.
#
# Keywords (GitHub's closing set, case-insensitive):
#   close closes closed fix fixes fixed resolve resolves resolved
#
# Portability floor: bash 3.2.57 + BSD awk. POSIX awk only (no gensym, no
# length-of-array tricks); regex via match()/substr().

# Read all of stdin.
input="$(cat 2>/dev/null || true)"

# The whole transform is one awk program operating per line. We process a line
# left to right, copying through text, and whenever we see <keyword><sep><ref>
# starting a list, we rewrite the rest of that contiguous list.
printf '%s' "$input" | awk '
# Is token (lowercased) a GitHub closing keyword?
function is_kw(w,    lw) {
  lw = tolower(w)
  return (lw=="close"||lw=="closes"||lw=="closed"||lw=="fix"||lw=="fixes"||lw=="fixed"||lw=="resolve"||lw=="resolves"||lw=="resolved")
}
# Match an issue ref at the start of string s. Sets REF to the matched text and
# returns its length, or 0 if none. Forms: optional owner/repo then #N, or GH-N.
function ref_at(s,    m) {
  # owner/repo#123  or  #123
  if (match(s, /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[0-9]+/)) {
    REF = substr(s, RSTART, RLENGTH); return RLENGTH
  }
  # GH-123  (case-insensitive prefix)
  if (match(s, /^[Gg][Hh]-[0-9]+/)) {
    REF = substr(s, RSTART, RLENGTH); return RLENGTH
  }
  return 0
}
# Match a list separator at the start of s: ", " "," " and " ", and " (and
# surrounding spaces). Sets SEP to the literal matched text; returns length or 0.
function sep_at(s,    m) {
  if (match(s, /^[[:space:]]*,[[:space:]]+and[[:space:]]+/)) { SEP=substr(s,RSTART,RLENGTH); return RLENGTH }
  if (match(s, /^[[:space:]]+and[[:space:]]+/))              { SEP=substr(s,RSTART,RLENGTH); return RLENGTH }
  if (match(s, /^[[:space:]]*,[[:space:]]*/))                { SEP=substr(s,RSTART,RLENGTH); return RLENGTH }
  return 0
}
{
  line = $0
  out = ""
  n = length(line)
  i = 1
  while (i <= n) {
    rest = substr(line, i)
    # Try to recognize a keyword word starting here, on a word boundary: the
    # previous output char must be a non-word char (or start of line).
    prevok = (out == "" || out ~ /[^A-Za-z0-9_]$/)
    if (prevok && match(rest, /^[A-Za-z]+/)) {
      word = substr(rest, RSTART, RLENGTH)   # RSTART==1
      if (is_kw(word)) {
        # Look for whitespace then a first ref right after the keyword.
        after = substr(rest, length(word)+1)
        wsmatch = match(after, /^[[:space:]]+/) ? RLENGTH : 0
        ws = wsmatch ? substr(after, 1, wsmatch) : ""
        afterws = substr(after, wsmatch+1)
        if (ref_at(afterws) > 0) {
          firstref = REF
          consumed = length(word) + wsmatch + length(firstref)
          # Emit the keyword + ws + first ref unchanged.
          kwlower = tolower(word)
          out = out word ws firstref
          pos = i + consumed            # absolute position after first ref
          # Now greedily consume a contiguous list, distributing the keyword.
          tail = substr(line, pos)
          while (1) {
            sl = sep_at(tail)
            if (sl == 0) break
            sep = SEP
            aftersep = substr(tail, sl+1)
            rl = ref_at(aftersep)
            if (rl == 0) break          # separator not followed by a ref -> stop
            ref = REF
            # If this ref is ALREADY preceded by its own keyword, do not double
            # it: check whether the separator itself ends with a keyword word.
            # (Our seps never contain a keyword, so a ref that already had a
            # keyword would not have matched sep_at after the previous ref; the
            # idempotence case is: "closes #1, closes #2" -> the ", " sep is
            # followed by "closes" not a ref, so rl==0 and we stop — correct.)
            out = out sep kwlower " " ref
            tail = substr(aftersep, rl+1)
          }
          # Advance i past everything we consumed (first ref + the list).
          i = i + consumed + (length(substr(line, pos)) - length(tail))
          continue
        }
      }
      # Not a keyword-with-list: emit the word verbatim, advance past it.
      out = out word
      i = i + length(word)
      continue
    }
    # Default: copy one character.
    out = out substr(line, i, 1)
    i = i + 1
  }
  print out
}
'
