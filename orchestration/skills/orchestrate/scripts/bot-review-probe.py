#!/usr/bin/env python3
"""Classify a PR review-bot round for one exact head SHA.

Review bots (CodeRabbit, Copilot review, Greptile, ...) post findings outside
every status check the merge decision already reads, and each signals
actionability its own way. This script keeps that per-bot knowledge in one
adapter table so adding a bot is a table entry, not a parser change.

`fetch` performs the three gh reads; `classify` is pure and reads that JSON on
stdin, so every classification path is testable without a network.

Exit codes match the landing contract's vocabulary:
  0  absent  no configured bot on this PR; merge decision unchanged
  0  clean   the bot's latest round at this head reports nothing actionable
  10 pending check still running, or no review at this head yet
  11 stale   the bot reviewed an older head only
  12 actionable
  13 declined the bot refused the round (quota/rate limit); re-trigger, do not wait
  2  unknown malformed or unreadable evidence -- never treated as clean
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, NamedTuple

EXIT_UNKNOWN = 2
EXIT_WAITING = 10
EXIT_STALE = 11
EXIT_ACTIONABLE = 12
EXIT_DECLINED = 13

DEFAULT_BOTS = "coderabbitai"
# A bot slug is matched against check names and details URLs by alphanumeric
# containment in either direction ("CodeRabbit" vs "coderabbitai"). The floor
# keeps a short slug from matching unrelated checks.
MIN_SLUG_MATCH = 4


class Round(NamedTuple):
    """One bot review round at the probed head."""

    actionable: int | None  # None = the adapter found no count in this body
    changes_requested: bool
    url: str
    at: str


# A decline notice is matched LOOSELY ON PURPOSE, in two independent halves: an
# indicator that the bot refused, and -- separately -- any duration figure
# anywhere in the body. A downstream script once matched the bot's exact
# sentence ("next review available in: N minutes"); the bot reworded it to "your
# next included review will be available in N minutes", the match returned
# empty, the caller read that as "no limit notice" and reported the quota window
# as reopened while it was exhausted, burning four re-triggers. Tightening
# either half into one sentence pattern reintroduces that bug: word order,
# "included", "will be", bold markers, and minutes-vs-hours all vary.
DECLINE_INDICATORS = re.compile(
    r"limit\s+(?:is\s+)?(?:currently\s+)?reached"
    r"|fair\s+usage"
    r"|rate[-\s]?limit"
    r"|quota"
    r"|usage\s+limit"
    r"|review\s+skipped",
    re.IGNORECASE,
)
WAIT_FIGURE = re.compile(r"(\d+)\s*\**\s*(minute|hour)s?", re.IGNORECASE)


def indicates_decline(body: str) -> bool:
    return DECLINE_INDICATORS.search(body or "") is not None


class Adapter(NamedTuple):
    """Per-bot knowledge: how this bot says "here is what you must fix"."""

    slug: str
    # Returns the actionable-finding count for a review body, or None when this
    # body carries no verdict the adapter recognises.
    count: Callable[[str], int | None]
    note: str
    # True when this body is the bot saying it refused the round. Defaults to
    # the cross-bot indicator set; override only to ADD wording, never to
    # narrow it to one sentence.
    declined: Callable[[str], bool] = indicates_decline


def _regex_count(pattern: str) -> Callable[[str], int | None]:
    compiled = re.compile(pattern, re.IGNORECASE)

    def read(body: str) -> int | None:
        match = compiled.search(body or "")
        return int(match.group("n")) if match else None

    return read


def wait_minutes(body: str) -> int | None:
    """Minutes until the bot says it will review again, from any wording."""
    match = WAIT_FIGURE.search(body or "")
    if not match:
        return None
    value = int(match.group(1))
    return value * 60 if match.group(2).lower() == "hour" else value


def reopen_instant(at: str, minutes: int) -> datetime | None:
    """Absolute reopen time, or None when the notice has no usable timestamp.

    The bot's figure is relative to when it POSTED the notice, so it decays; a
    stored figure alone cannot say whether the window is open.
    """
    try:
        posted = datetime.fromisoformat((at or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    if posted.tzinfo is None:
        posted = posted.replace(tzinfo=UTC)
    # CLAMP: the figure comes from the bot's own prose, so it is data this tool does
    # not control. `timedelta` raises OverflowError past its range, and main() catches
    # only ValueError/JSONDecodeError, so "retry in 999999999999999999999999 minutes"
    # exited 1 with a traceback instead of the documented exit 2. A week is far past
    # any real backoff, and anything beyond it means the same thing operationally.
    minutes = max(0, min(minutes, 7 * 24 * 60))
    return posted + timedelta(minutes=minutes)


# CodeRabbit posts one summary review per round whose body carries
# "Actionable comments posted: N". Every fix suggestion hangs under that
# summary, so N is the actionability signal and a long nitpick-only body with
# N=0 merges.
ADAPTERS: dict[str, Adapter] = {
    "coderabbitai": Adapter(
        slug="coderabbitai",
        count=_regex_count(r"actionable comments posted:\s*(?P<n>\d+)"),
        note='CodeRabbit summary line "Actionable comments posted: N"',
    ),
}

# A bot with no adapter still gets classified: its check and review presence
# are visible, and a CHANGES_REQUESTED verdict is actionable everywhere. Only
# the count is unavailable, which reads as "no recognised verdict yet".
GENERIC_ADAPTER = Adapter(
    slug="",
    count=lambda _body: None,
    note="no adapter: review state only",
)


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def related(left: str, right: str) -> bool:
    if len(left) < MIN_SLUG_MATCH or len(right) < MIN_SLUG_MATCH:
        return False
    return left in right or right in left


def configured_slugs(raw: str | None) -> list[str]:
    source = raw if raw is not None else os.environ.get("PR_REVIEW_BOTS", DEFAULT_BOTS)
    return [part.strip().lower() for part in source.split(",") if part.strip()]


def adapter_for(slug: str) -> Adapter:
    if slug in ADAPTERS:
        return ADAPTERS[slug]
    for known, adapter in ADAPTERS.items():
        if related(normalize(slug), normalize(known)):
            return adapter
    return GENERIC_ADAPTER._replace(slug=slug)


def is_bot_check(check: dict[str, Any], slugs: list[str]) -> bool:
    name = normalize(str(check.get("name") or ""))
    url = normalize(str(check.get("detailsUrl") or ""))
    return any(
        related(name, normalize(slug)) or related(url, normalize(slug)) for slug in slugs
    )


def login_slug(login: str, slugs: list[str]) -> str | None:
    """Return the configured slug this review author is, or None."""
    actual = (login or "").lower()
    for slug in slugs:
        if actual in (slug, f"{slug}[bot]"):
            return slug
    return None


# The Checks API reports `status: completed`; the older commit-status API reports
# `state: SUCCESS|FAILURE|PENDING|ERROR` and has no `status` at all. Only "completed"
# counted as finished, so a status-API bot reporting SUCCESS read as "still running"
# and the probe returned EXIT_WAITING forever -- a bot that had already answered kept
# the merge waiting indefinitely.
STATUS_API_TERMINAL = frozenset({"success", "failure", "error"})


def check_state(check: dict[str, Any]) -> str:
    """The check's state, normalized to the Checks API vocabulary.

    A commit-status `state` is mapped onto `completed` when it is terminal, so the one
    caller comparing against "completed" treats both APIs alike. `pending` stays
    itself, because it means the same thing in both.
    """
    status = str(check.get("status") or "").lower()
    if status:
        return status
    state = str(check.get("state") or "").lower()
    return "completed" if state in STATUS_API_TERMINAL else state


def declines(
    notices: list[Any], slugs: list[str], now: datetime
) -> dict[str, Any] | None:
    """The bot's newest refusal notice, or None.

    Advisory only: the caller must consult this AFTER evidence of a real review,
    because a refusal notice stays in the comment history forever and would
    otherwise mask the genuine review that landed after it.
    """
    found = []
    for notice in notices:
        if not isinstance(notice, dict):
            raise ValueError("each notice must be an object")
        slug = login_slug(str(notice.get("login") or ""), slugs)
        body = str(notice.get("body") or "")
        if slug is None or not adapter_for(slug).declined(body):
            continue
        found.append((str(notice.get("at") or ""), body))
    if not found:
        return None
    at, body = max(found)
    minutes = wait_minutes(body)
    if minutes is None:
        return {"wait": "UNKNOWN", "detail": "bot declined the round; re-check before re-trigger"}
    reopen = reopen_instant(at, minutes)
    if reopen is None:
        return {"wait": f"{minutes}m", "detail": f"bot declined the round for {minutes}m from an unreadable timestamp; re-check before re-trigger"}
    if reopen <= now:
        return {"wait": reopen.isoformat(), "detail": f"bot declined the round; window reopened at {reopen.isoformat()}, re-trigger"}
    return {"wait": reopen.isoformat(), "detail": f"bot declined the round; retry after {reopen.isoformat()}"}


def classify(
    payload: dict[str, Any], head: str, slugs: list[str], now: datetime | None = None
) -> dict[str, Any]:
    """Pure classification. Raises ValueError on evidence it cannot read.

    `now` is injected so decline-window arithmetic stays deterministic in tests.
    """
    now = now or datetime.now(UTC)
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    checks = payload.get("checks") or []
    reviews = payload.get("reviews") or []
    comments = payload.get("comments") or []
    notices = payload.get("notices") or []
    if (
        not isinstance(checks, list)
        or not isinstance(reviews, list)
        or not isinstance(comments, list)
        or not isinstance(notices, list)
    ):
        raise ValueError("checks, reviews, comments, and notices must be arrays")

    bot_checks = [c for c in checks if isinstance(c, dict) and is_bot_check(c, slugs)]
    bot_reviews = []
    refusals = list(notices)
    for review in reviews:
        if not isinstance(review, dict):
            raise ValueError("each review must be an object")
        slug = login_slug(str(review.get("login") or ""), slugs)
        if slug is None:
            continue
        # A refusal is not a review round. Left in `bot_reviews` it would read as
        # `pending`/`stale` -- "keep waiting" -- exactly the ambiguity that cost
        # the wasted re-triggers.
        if adapter_for(slug).declined(str(review.get("body") or "")):
            refusals.append(review)
        else:
            bot_reviews.append((slug, review))

    result: dict[str, Any] = {
        "head": head,
        "bots": ",".join(slugs),
        "check": ",".join(
            f"{c.get('name') or '?'}/{check_state(c) or '?'}" for c in bot_checks
        )
        or "none",
        "actionable": 0,
        "changes_requested": 0,
        "summary": "none",
        "wait": "none",
        "files": [],
    }

    decline = declines(refusals, slugs, now)
    if not bot_checks and not bot_reviews and decline is None:
        return {**result, "state": "absent", "code": 0,
                "detail": "no configured review bot on this PR"}

    # A PR check rollup always describes the current head, so a running bot
    # check needs no head comparison of its own.
    if any(state != "completed" for state in map(check_state, bot_checks)):
        return {**result, "state": "pending", "code": EXIT_WAITING,
                "detail": "bot check still running"}

    at_head = [
        (slug, review)
        for slug, review in bot_reviews
        if str(review.get("commit") or "") == head
    ]
    at_head.sort(key=lambda pair: str(pair[1].get("at") or ""))

    # A REAL REVIEW ALWAYS BEATS A NOTICE. The decline notice is only consulted
    # where there is no review to read at all: with a review at this head the
    # count decides, and with a review at an older head only the answer is
    # `stale`. A refusal notice from an earlier commit must never mask either.
    if not at_head:
        if not bot_reviews:
            if decline is not None:
                return {**result, "state": "declined", "code": EXIT_DECLINED,
                        "wait": decline["wait"], "detail": decline["detail"]}
            return {**result, "state": "pending", "code": EXIT_WAITING,
                    "detail": "bot check complete, no review posted yet"}
        return {**result, "state": "stale", "code": EXIT_STALE,
                "detail": "bot reviewed an older head only"}

    rounds: list[Round] = []
    for slug, review in at_head:
        rounds.append(
            Round(
                actionable=adapter_for(slug).count(str(review.get("body") or "")),
                changes_requested=str(review.get("state") or "") == "CHANGES_REQUESTED",
                url=str(review.get("url") or ""),
                at=str(review.get("at") or ""),
            )
        )

    # A re-review at the same head supersedes the earlier one, so read the
    # LATEST round with a recognised count. Taking the maximum would let a
    # resolved round block the PR forever.
    # The latest review round supersedes every earlier round.  If its adapter
    # cannot read a count, report pending rather than reusing an older clean
    # count and treating an unrecognized review as approval.
    latest = rounds[-1]
    changes = 1 if rounds[-1].changes_requested else 0
    result["changes_requested"] = changes
    result["summary"] = latest.url or "none"
    result["files"] = sorted(
        f"{c.get('path') or '?'}:{c.get('line') or c.get('original_line') or 0} {c.get('url') or ''}".strip()
        for c in comments
        if isinstance(c, dict)
        and login_slug(str(c.get("login") or ""), slugs) is not None
        and str(c.get("commit") or "") == head
    )

    if latest.actionable is None:
        if changes:
            return {**result, "state": "actionable", "code": EXIT_ACTIONABLE,
                    "detail": "changes requested without a summary count"}
        return {**result, "state": "pending", "code": EXIT_WAITING,
                "detail": "no actionable-comment summary at head yet"}

    result["actionable"] = latest.actionable
    if changes or latest.actionable > 0:
        return {**result, "state": "actionable", "code": EXIT_ACTIONABLE,
                "detail": f"{latest.actionable} actionable comment(s)"}
    return {**result, "state": "clean", "code": 0, "detail": "0 actionable comments"}


def render(result: dict[str, Any]) -> str:
    lines = [
        "BOT_REVIEW {state} bots={bots} head={head} check={check} "
        "actionable={actionable} changes_requested={changes_requested} "
        'summary={summary} wait={wait} detail="{detail}"'.format(**result)
    ]
    lines.extend(f"COMMENT {entry}" for entry in result["files"])
    return "\n".join(lines)


# Per-call bound on a `gh` read. None of the four sequential reads had a timeout, so a
# wedged `gh` -- an auth prompt, a hung proxy -- hung the shepherd indefinitely rather
# than failing. Verified: a `sleep 30` shim was still running when the harness killed
# it.
#
# FIVE SECONDS, not thirty. Four reads run per probe, so the bound has to leave the
# whole probe inside a caller's patience; a paginated GitHub read that has not answered
# in five seconds is not about to. Overridable for a genuinely slow link.
GH_TIMEOUT_SECONDS = int(os.environ.get("PR_SHEPHERD_GH_TIMEOUT", "5"))


def gh_json(*args: str) -> Any:
    try:
        completed = subprocess.run(
            ["gh", *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=GH_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(
            f"gh {' '.join(args)} timed out after {GH_TIMEOUT_SECONDS}s"
        ) from error
    if completed.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {completed.stderr.strip()}")
    # EMPTY STDOUT IS NOT "no data". `gh` exiting 0 with nothing on stdout turned into
    # `null`, which built a payload with an empty head and all-empty review arrays --
    # and that classifies as `absent`, exit 0, clearing the merge as though the bot
    # gate had been satisfied. Silence from an upstream read cannot be evidence that a
    # check passed.
    if not completed.stdout.strip():
        raise RuntimeError(
            f"gh {' '.join(args)} exited 0 with empty output; refusing to read silence "
            f"as an answer"
        )
    return json.loads(completed.stdout)


def gh_paginated_json(*args: str) -> list[dict[str, Any]]:
    """Read and flatten REST pages emitted by ``gh api --paginate --slurp``."""
    payload = gh_json("api", "--paginate", "--slurp", *args)
    if not isinstance(payload, list):
        raise RuntimeError("paginated gh response must be an array of pages")
    rows: list[dict[str, Any]] = []
    for page in payload:
        if not isinstance(page, list) or not all(isinstance(row, dict) for row in page):
            raise RuntimeError("paginated gh response contains a malformed page")
        rows.extend(page)
    return rows


def fetch(repo: str, pr: str) -> dict[str, Any]:
    """Three reads, no classification.

    `gh pr view` omits each review's commit id, so the reviews and their inline
    comments come from REST, paginated because one bot round can exceed a page.
    Issue comments are read as well because a quota refusal arrives there, not as
    a review.
    """
    view = gh_json("pr", "view", pr, "--repo", repo, "--json", "headRefOid,statusCheckRollup")
    # A `null` or head-less view is not a PR with no reviews -- it is a read that did
    # not answer. Without this the payload carried head="" and empty review arrays,
    # which classifies as `absent` and exit 0, clearing the bot gate as though it had
    # been satisfied. The head is the one field every downstream comparison needs, so
    # its absence is the honest place to stop.
    if not isinstance(view, dict) or not view.get("headRefOid"):
        raise RuntimeError(
            f"gh pr view {pr} returned no headRefOid; refusing to treat an "
            f"unanswered read as an absent review"
        )
    reviews = gh_paginated_json(f"repos/{repo}/pulls/{pr}/reviews")
    comments = gh_paginated_json(f"repos/{repo}/pulls/{pr}/comments")
    notices = gh_paginated_json(f"repos/{repo}/issues/{pr}/comments")
    return {
        "notices": [
            {
                "login": (n.get("user") or {}).get("login") or "",
                "body": n.get("body") or "",
                "at": n.get("created_at") or "",
            }
            for n in (notices or [])
        ],
        "head": (view or {}).get("headRefOid") or "",
        "checks": (view or {}).get("statusCheckRollup") or [],
        "reviews": [
            {
                "login": (r.get("user") or {}).get("login") or "",
                "state": r.get("state") or "",
                "body": r.get("body") or "",
                "commit": r.get("commit_id") or "",
                "url": r.get("html_url") or "",
                "at": r.get("submitted_at") or "",
            }
            for r in (reviews or [])
        ],
        "comments": [
            {
                "login": (c.get("user") or {}).get("login") or "",
                "path": c.get("path") or "",
                "line": c.get("line") or c.get("original_line") or 0,
                "commit": c.get("commit_id") or "",
                "url": c.get("html_url") or "",
            }
            for c in (comments or [])
        ],
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    fetch_cmd = sub.add_parser("fetch", help="read PR checks, reviews, and comments")
    fetch_cmd.add_argument("repo")
    fetch_cmd.add_argument("pr")
    classify_cmd = sub.add_parser("classify", help="classify fetched JSON on stdin")
    classify_cmd.add_argument("head", help="exact head SHA the round must match")
    classify_cmd.add_argument("--bots", help="comma-separated bot slugs (default $PR_REVIEW_BOTS)")
    sub.add_parser("bots", help="list configured bots and their adapters")
    args = parser.parse_args(argv)

    if args.command == "fetch":
        try:
            print(json.dumps(fetch(args.repo, args.pr)))
        except (RuntimeError, json.JSONDecodeError) as error:
            print(f"bot-review-probe: {error}", file=sys.stderr)
            return EXIT_UNKNOWN
        return 0

    if args.command == "bots":
        for slug in configured_slugs(None):
            print(f"{slug}\t{adapter_for(slug).note}")
        return 0

    try:
        payload = json.load(sys.stdin)
        result = classify(payload, args.head, configured_slugs(args.bots))
    except (ValueError, json.JSONDecodeError) as error:
        print(f"bot-review-probe: cannot classify: {error}", file=sys.stderr)
        return EXIT_UNKNOWN
    print(render(result))
    return int(result["code"])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
