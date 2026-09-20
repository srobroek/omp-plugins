#!/usr/bin/env python3
# VENDORED from srobroek/agentic-packages, packages/hooks-close-keywords/scripts/close_keywords.py.
#
# Vendored rather than referenced because a prek `entry:` has to resolve inside this
# repository. An installed package does not: it may live anywhere on the machine, or
# nowhere. The package's own templates/pre-commit-commit-msg.yaml names project-setup as
# the consumer that does this.
#
# NO CHECKER ENFORCES THIS COPY. Both repositories have twin-script checks and neither
# reaches across a repository boundary, so drift here is silent. Re-sync with:
#
#     cp <agentic-packages>/packages/hooks-close-keywords/scripts/close_keywords.py \
#        templates/quality/hooks/template/scripts/close_keywords.py
#
# Fix behaviour upstream and re-copy; editing here is reverted by the next sync.
"""Distribute a GitHub closing keyword across a contiguous list of issue refs.

GitHub binds a closing keyword to only the FIRST reference in a list, so
`Closes #37, #38, #39` closes #37 and leaves the rest open. This rewrites such a
list to `Closes #37, closes #38, closes #39`, which closes all three.

Shared engine for both delivery layers: the pre-commit `commit-msg` hook that
rewrites a message in place, and the `PreToolUse` guard that advises on a
`gh pr create` body.

Scope is deliberately narrow, because a false rewrite of someone's prose costs
more than a missed distribution:

- Only a list IMMEDIATELY following a keyword is distributed. An unrelated `#N`
  later on the line is untouched.
- Separators inside the list are `,`, `, `, ` and `, and `, and `.
- Reference forms are `#N`, `owner/repo#N`, and `GH-N`.
- Distributed copies use the lowercased keyword; the original keeps its case.

Idempotent: a list whose refs each already carry a keyword is left alone,
because a separator followed by a keyword rather than a reference ends the list.
"""

from __future__ import annotations

import re

# GitHub's closing keyword set. Matched case-insensitively, on a word boundary,
# so `closet #1, #2` is prose rather than a close directive.
KEYWORDS = frozenset(
    {
        "close",
        "closes",
        "closed",
        "fix",
        "fixes",
        "fixed",
        "resolve",
        "resolves",
        "resolved",
    }
)

_WORD = re.compile(r"[A-Za-z]+")

# `owner/repo#123` or `#123`, else `GH-123`. Anchored: callers test the position
# directly after a keyword or separator, never search forward from it.
_REF = re.compile(r"(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#[0-9]+|GH-[0-9]+", re.IGNORECASE)

# List separators, longest form first so `, and ` is not read as a bare `,`.
_SEPARATORS = (
    re.compile(r"[^\S\n]*,[^\S\n]+and[^\S\n]+"),
    re.compile(r"[^\S\n]+and[^\S\n]+"),
    re.compile(r"[^\S\n]*,[^\S\n]*"),
)


def _match_at(pattern: re.Pattern[str], text: str, pos: int) -> str | None:
    """Return the text `pattern` matches starting exactly at `pos`, if any."""
    match = pattern.match(text, pos)
    return match.group(0) if match else None


def _separator_at(text: str, pos: int) -> str | None:
    for pattern in _SEPARATORS:
        found = _match_at(pattern, text, pos)
        if found:
            return found
    return None


def normalize_line(line: str) -> str:
    """Distribute close keywords across every contiguous list in one line."""
    out: list[str] = []
    pos = 0
    end = len(line)

    while pos < end:
        # A keyword only counts on a word boundary, which is what stops the
        # `closes` inside `precloses` or `closet` from opening a list.
        at_boundary = not out or not (out[-1][-1:].isalnum() or out[-1].endswith("_"))
        word = _match_at(_WORD, line, pos) if at_boundary else None

        if word is None:
            out.append(line[pos])
            pos += 1
            continue

        if word.lower() not in KEYWORDS:
            out.append(word)
            pos += len(word)
            continue

        after_word = pos + len(word)
        space = _match_at(re.compile(r"[^\S\n]+"), line, after_word) or ""
        first_ref = _match_at(_REF, line, after_word + len(space))
        if first_ref is None:
            out.append(word)
            pos += len(word)
            continue

        # Emit the keyword and its first reference unchanged, then walk the rest
        # of the list, giving each later reference its own keyword.
        keyword = word.lower()
        out.append(word + space + first_ref)
        pos = after_word + len(space) + len(first_ref)

        while True:
            separator = _separator_at(line, pos)
            if separator is None:
                break
            ref = _match_at(_REF, line, pos + len(separator))
            if ref is None:
                # A separator not followed by a reference ends the list. This is
                # also what makes the rewrite idempotent: in
                # `closes #1, closes #2` the `, ` is followed by a keyword.
                break
            out.append(f"{separator}{keyword} {ref}")
            pos += len(separator) + len(ref)

    return "".join(out)


def normalize(text: str) -> str:
    """Normalize every line of `text`, preserving its line structure."""
    return "\n".join(normalize_line(line) for line in text.split("\n"))
