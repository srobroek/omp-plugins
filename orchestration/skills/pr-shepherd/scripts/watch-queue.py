#!/usr/bin/env python3
"""pr-shepherd: read-only merge-queue dashboard.

Discovers required CI contexts from branch protection, classifies open PRs,
ranks them by the beads merge queue (``bd ready --label pr:merge``), and
recommends the next merge candidate. Fail-closed: no required contexts means no
merge.

Environment:
  PRSHEP_REPO               owner/repo (auto-detected from the git remote)
  PRSHEP_DEFAULT_BRANCH     base branch (auto-detected via gh)
  PRSHEP_REQUIRED_CONTEXTS  override: newline-separated context names
  PRSHEP_RELEASE_PATTERN    regex excluding release branches
                            (default: ^release-please--)
  PRSHEP_FCFS=1             first-come-first-served: skip beads ranking
  PRSHEP_STRICT_RANKING=1   hold the gate on unranked READY PRs
                            (also --strict-ranking)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from urllib.parse import urlsplit

# Bucket precedence. This ordering is the tool's contract: it decides both the
# section order in the dashboard and which label a PR carries when several
# conditions hold at once.
BUCKET_ORDER = ("READY", "FAILING", "STUCK", "CONFLICT", "WAITING", "HELD")

RELEASE_TITLE = re.compile(r"^chore(\(.*\))?: release", re.IGNORECASE)
SHA40 = re.compile(r"^[0-9a-fA-F]{40}$")
TITLE_WIDTH = 52


class Failure(Exception):
    """A fail-closed condition, carrying the message and exit status."""

    def __init__(self, message: str, status: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def die(message: str, status: int = 1) -> None:
    raise Failure(message, status)


def gh(*args: str) -> str:
    """Run `gh` and return stdout, or "" when it fails."""
    try:
        completed = subprocess.run(
            ["gh", *args], capture_output=True, text=True, check=False
        )
    except OSError:
        return ""
    return completed.stdout.strip() if completed.returncode == 0 else ""


def gh_required(*args: str) -> str:
    """Run `gh` and fail closed when it does."""
    try:
        completed = subprocess.run(
            ["gh", *args], capture_output=True, text=True, check=False
        )
    except OSError as exc:
        die(f"ERROR: cannot run gh: {exc}")
    if completed.returncode != 0:
        die(f"ERROR: gh {' '.join(args)} failed: {completed.stderr.strip()}")
    return completed.stdout.strip()


# --- discovery --------------------------------------------------------------


def discover_repo() -> str:
    override = os.environ.get("PRSHEP_REPO", "")
    if override:
        return override
    try:
        completed = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        completed = None
    url = completed.stdout.strip() if completed and completed.returncode == 0 else ""
    if not url:
        die("ERROR: cannot discover repo \u2014 no git remote and PRSHEP_REPO unset")
    return parse_remote(url)


def parse_remote(url: str) -> str:
    """owner/repo from a git remote URL.

    The shell predecessor used `sed -E 's|^.*github\\.com[:/]||'`, a greedy
    match that any path segment named `github.com` could hijack. Both remote
    forms are parsed structurally here: `scp`-style `git@host:owner/repo` has no
    URL scheme, so it is split on the first colon rather than by urlsplit.
    """
    trimmed = url.strip().removesuffix(".git")
    if "://" in trimmed:
        path = urlsplit(trimmed).path
    elif ":" in trimmed and not trimmed.startswith("/"):
        # git@github.com:owner/repo
        path = trimmed.split(":", 1)[1]
    else:
        path = trimmed
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        die(f"ERROR: cannot parse owner/repo from remote: {url}")
    return "/".join(parts[-2:])


def discover_default_branch(repo: str) -> str:
    override = os.environ.get("PRSHEP_DEFAULT_BRANCH", "")
    if override:
        return override
    branch = gh("api", f"repos/{repo}", "--jq", ".default_branch")
    if not branch:
        die(f"ERROR: cannot discover the default branch for {repo}")
    return branch


def discover_required_contexts(repo: str, branch: str) -> list[str]:
    """Required contexts, or fail closed when none can be discovered."""
    override = os.environ.get("PRSHEP_REQUIRED_CONTEXTS")
    if override is not None:
        contexts = [line.strip() for line in override.splitlines() if line.strip()]
        if not contexts:
            die("ERROR: required contexts list is empty. Fail-closed.")
        return contexts

    raw = gh(
        "api",
        f"repos/{repo}/branches/{branch}/protection/required_status_checks",
        "--jq",
        ".contexts[]",
    )
    if not raw:
        raw = gh(
            "api",
            f"repos/{repo}/rules/branches/{branch}",
            "--jq",
            "[.[] | select(.type == \"required_status_checks\") "
            "| .parameters.required_status_checks[].context] | unique | .[]",
        )
    contexts = [line.strip() for line in raw.splitlines() if line.strip()]
    if not contexts:
        die(
            "ERROR: no required contexts found (branch protection, rulesets, or "
            "PRSHEP_REQUIRED_CONTEXTS). Fail-closed."
        )
    return contexts


def main_sha(repo: str, branch: str, label: str) -> str:
    sha = gh_required("api", f"repos/{repo}/commits/{branch}", "--jq", ".sha")
    if not SHA40.match(sha):
        die(f"ERROR: GitHub returned an invalid {label}: {sha}")
    return sha


# --- classification ---------------------------------------------------------


def check_state(rollup: list, name: str) -> str:
    """One required context's state: ABSENT, AMBIGUOUS, RUNNING, OK, or FAIL."""
    matches = [
        entry
        for entry in rollup
        if isinstance(entry, dict) and entry.get("name") == name
    ]
    if not matches:
        return "ABSENT"
    if len(matches) > 1:
        # Two runs reporting the same context name: which one gates the merge is
        # undecidable, so it is not treated as passing.
        return "AMBIGUOUS"
    match = matches[0]
    if match.get("status") != "COMPLETED":
        return "RUNNING"
    if match.get("conclusion") in ("SUCCESS", "SKIPPED"):
        return "OK"
    return "FAIL"


def bucket_for(release: bool, draft: bool, ready: bool, merge_state: str, checks: list[str]) -> str:
    """The PR's bucket, in the precedence order the dashboard depends on."""
    if release or draft:
        return "HELD"
    if ready:
        return "READY"
    if merge_state == "DIRTY":
        return "CONFLICT"
    if "FAIL" in checks:
        return "FAILING"
    if "RUNNING" in checks:
        return "WAITING"
    if "ABSENT" in checks or "AMBIGUOUS" in checks:
        return "STUCK"
    return "WAITING"


def classify(prs: list, required: list[str], release_pattern: str) -> list[dict]:
    try:
        release_re = re.compile(release_pattern)
    except re.error as exc:
        die(f"ERROR: invalid PRSHEP_RELEASE_PATTERN: {exc}", 2)
    out: list[dict] = []
    for pr in prs:
        if not isinstance(pr, dict):
            continue
        number = pr.get("number")
        # A PR with no usable number cannot be merged by number, and letting it
        # through made `str(None)` a merge candidate: the dashboard recommended
        # `#None`. bool is an int subclass, so it is excluded explicitly.
        if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
            continue
        rollup = pr.get("statusCheckRollup")
        if not isinstance(rollup, list):
            rollup = []
        # Coerced rather than defaulted: a non-string title made `title[:52]`
        # raise TypeError, and a non-string branch did the same inside
        # `release_re.search`, aborting the whole dashboard over one bad record.
        title = pr.get("title") if isinstance(pr.get("title"), str) else ""
        branch = pr.get("headRefName") if isinstance(pr.get("headRefName"), str) else ""
        release = bool(release_re.search(branch)) or bool(RELEASE_TITLE.match(title))
        draft = bool(pr.get("isDraft"))
        merge_state = pr.get("mergeStateStatus") or ""
        checks = [check_state(rollup, name) for name in required]
        ready = (
            not release
            and not draft
            and merge_state == "CLEAN"
            # `all()` is vacuously true on an empty list, so a caller reaching
            # classify() with zero required contexts marked every clean PR READY
            # and recommended a merge gated by nothing. The documented rule is
            # fail-closed: no required contexts means no merge.
            and bool(checks)
            and all(state == "OK" for state in checks)
        )
        out.append(
            {
                "number": number,
                "title": title[:TITLE_WIDTH],
                "draft": draft,
                "release": release,
                "mergeState": merge_state,
                "checks": checks,
                "done": sum(1 for state in checks if state == "OK"),
                "total": len(required),
                "ready": ready,
                "bucket": bucket_for(release, draft, ready, merge_state, checks),
            }
        )
    return out


# --- ranking ----------------------------------------------------------------


def ranked_pr_numbers() -> list[str]:
    """PR numbers from the beads merge queue, in priority order."""
    if os.environ.get("PRSHEP_FCFS", "0") == "1" or not shutil.which("bd"):
        return []
    try:
        completed = subprocess.run(
            ["bd", "ready", "--label", "pr:merge", "--json"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return []
    if completed.returncode != 0:
        return []
    try:
        beads = json.loads(completed.stdout or "[]")
    except ValueError:
        return []
    if not isinstance(beads, list):
        return []
    numbers: list[str] = []
    for bead in beads:
        if not isinstance(bead, dict):
            continue
        metadata = bead.get("metadata")
        pr = metadata.get("pr") if isinstance(metadata, dict) else None
        if pr not in (None, ""):
            numbers.append(str(pr))
    return numbers


# --- output -----------------------------------------------------------------


def render_dashboard(classified: list[dict], required_count: int) -> None:
    for bucket in BUCKET_ORDER:
        members = [pr for pr in classified if pr["bucket"] == bucket]
        if not members:
            continue
        print(f"-- {bucket}  ({len(members)}) --")
        for pr in sorted(members, key=lambda p: p["number"] or 0, reverse=True):
            if pr["release"]:
                tag = " [RELEASE]"
            elif pr["draft"]:
                tag = " [draft]"
            else:
                tag = ""
            print(
                f"   #{pr['number']}{tag}  {pr['done']}/{required_count}  {pr['title']}"
            )


def run() -> int:
    strict = os.environ.get("PRSHEP_STRICT_RANKING", "0") == "1"
    for arg in sys.argv[1:]:
        if arg == "--strict-ranking":
            strict = True
        else:
            print(f"watch-queue: unknown argument: {arg}", file=sys.stderr)
            return 2

    for command in ("gh", "git"):
        if not shutil.which(command):
            print(f"ERROR: required command not found: {command}", file=sys.stderr)
            return 127

    repo = discover_repo()
    branch = discover_default_branch(repo)
    release_pattern = os.environ.get("PRSHEP_RELEASE_PATTERN") or "^release-please--"
    required = discover_required_contexts(repo, branch)

    snapshot_sha = main_sha(repo, branch, f"{branch} SHA")

    raw = gh_required(
        "pr",
        "list",
        "-R",
        repo,
        "--state",
        "open",
        "--base",
        branch,
        "--limit",
        "100",
        "--json",
        "number,title,isDraft,headRefName,mergeStateStatus,statusCheckRollup",
    )
    try:
        prs = json.loads(raw or "[]")
    except ValueError as exc:
        die(f"ERROR: gh returned unparsable PR JSON: {exc}")
    if not isinstance(prs, list):
        die("ERROR: gh returned a non-list PR payload")

    classified = classify(prs, required, release_pattern)

    stamp = datetime.now(UTC).strftime("%H:%M:%SZ")
    print(f"== {stamp}  {repo}/{branch} ==")
    render_dashboard(classified, len(required))
    print("   note: STUCK = a required context is absent or ambiguous.")
    print("   note: HELD = release or draft. Never rank or merge these.")

    fcfs = os.environ.get("PRSHEP_FCFS", "0") == "1"
    ready_numbers = [
        str(pr["number"]) for pr in sorted(classified, key=lambda p: p["number"] or 0)
        if pr["ready"]
    ]
    ranked = ranked_pr_numbers()

    print("-- MERGE ORDER --")
    if fcfs:
        print("   (FCFS mode \u2014 no ranking enforced)")
    elif not ranked:
        print("   (no merge beads found \u2014 queue empty)")

    candidate = ""
    for number in ranked:
        if number in ready_numbers:
            candidate = candidate or number
            print(f"   ranked #{number}  READY")
        else:
            print(f"   ranked #{number}  (not ready or no longer open)")

    unranked_ready: list[str] = []
    for number in ready_numbers:
        if fcfs:
            candidate = candidate or number
        elif number not in ranked:
            unranked_ready.append(number)

    if unranked_ready:
        print("   !! UNRANKED AND READY:" + "".join(f" #{n}" for n in unranked_ready))
        if strict:
            print("   !! STRICT: gate held until all READY PRs have merge beads.")
        else:
            print(
                "   !! WARNING: create merge beads for these PRs. "
                "Auto-appended to queue back."
            )
            # Default mode appends unranked ready PRs after the ranked ones.
            for number in unranked_ready:
                candidate = candidate or number

    confirmed_sha = main_sha(repo, branch, "confirmation SHA")

    print("-- MERGE GATE --")
    if confirmed_sha != snapshot_sha:
        print(
            f"   HOLD \u2014 {branch} moved during inspection "
            f"({snapshot_sha[:8]} -> {confirmed_sha[:8]}). No merge candidate."
        )
    elif strict and unranked_ready:
        print(
            "   HOLD \u2014 READY PRs are missing merge beads (strict mode). "
            "No merge candidate."
        )
    elif candidate:
        print(f"   CLEAR \u2014 next merge is #{candidate}")
        print(
            "          verify the required checks on its HEAD SHA immediately "
            "before merging."
        )
        print("          Only one merge may be in flight at a time.")
    else:
        print("   CLEAR \u2014 but nothing ranked is READY.")

    print(f"-- {branch} --")
    print(f"   {confirmed_sha[:8]}")
    return 0


def main() -> int:
    try:
        return run()
    except Failure as failure:
        print(failure.message, file=sys.stderr)
        return failure.status


if __name__ == "__main__":
    sys.exit(main())
