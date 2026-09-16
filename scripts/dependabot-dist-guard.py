#!/usr/bin/env python3
"""Gate the privileged half of the generated-dist automation.

dependabot-dist-build.yml rebuilds the committed `dist/` bundles from the pull
request head. That build runs pull-request code, so it holds no credentials and
its only product is an uploaded artifact. dependabot-dist.yml then publishes
those bytes with the release App token. `workflow_run` resolves both that
workflow file and the checkout it runs from on the default branch, so every line
this script executes is trusted; the artifact and the branch it lands on are not.

Four subcommands, in the order the publish job runs them:

- `event-branch` prints the head branch out of the workflow_run event after
  proving it is a Dependabot ref with a safe name, because the publish job
  interpolates that value into an API path.
- `verify-context` proves the run and the pull request agree on the exact
  Dependabot actor, on this repository for both the run and the head, and on the
  head ref and head commit. It runs before any token is minted.
- `verify-artifact` reduces the downloaded artifact to the generated output this
  automation may publish: regular files under an existing plugin's `dist/`, plus
  browser-tools' notices. Symlinks, hard links, traversal, device nodes and
  anything outside the allowlist are rejected, never skipped.
- `apply` writes the verified bytes into the head checkout. It copies bytes; it
  never imports, sources, installs, evaluates or executes anything from the
  artifact or from the checkout.

Deterministic: no network, no repository history, no environment beyond the
arguments.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from pathlib import Path

# The pull request author that this automation exists for. A human push onto a
# Dependabot branch deliberately falls outside it: the rebuild is skipped and the
# bundle-drift gate stays red, which is the fail-closed direction for a job that
# holds a write token.
ACTOR = "dependabot[bot]"
BRANCH_PREFIX = "dependabot/"
REF_CHARS = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._/-]*\Z")
SHA = re.compile(r"\A[0-9a-f]{40}\Z")

# The exact generated output patterns. `build-extensions.py` writes
# `<plugin>/dist/<source stem>.js` and nothing else; the notices file is the only
# other generated artifact. Lockfiles are excluded on purpose: the build installs
# with --frozen-lockfile, so a lockfile can never legitimately change here, and
# publishing one would let a compromised build stage feed the next install.
BUNDLE = re.compile(r"\A(?P<plugin>[a-z0-9][a-z0-9-]*)/dist/[A-Za-z0-9._-]+\.js\Z")
NOTICES = "browser-tools/THIRD_PARTY_NOTICES.txt"
METADATA = "dependabot-dist.json"

MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_FILES = 256


class GuardError(Exception):
    """Every rejection reason found, so one run reports the whole picture."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = reasons


def reject(reasons: list[str]) -> None:
    if reasons:
        raise GuardError(reasons)


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GuardError([f"{path}: unreadable JSON: {error}"]) from error


def dig(value: object, *keys: str) -> object:
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def safe_ref(ref: object) -> list[str]:
    """A ref that is about to be interpolated into an API path and a git refspec."""
    if not isinstance(ref, str) or not ref:
        return [f"head ref is not a string: {ref!r}"]
    reasons = []
    if not ref.startswith(BRANCH_PREFIX):
        reasons.append(f"head ref {ref!r} is not a {BRANCH_PREFIX!r} branch")
    if not REF_CHARS.match(ref):
        reasons.append(f"head ref {ref!r} carries characters outside [A-Za-z0-9._/-]")
    if ".." in ref or "//" in ref or ref.endswith((".lock", "/", ".")):
        reasons.append(f"head ref {ref!r} is not a valid git ref name")
    return reasons


def event_run(event_path: Path) -> dict:
    payload = read_json(event_path)
    run = dig(payload, "workflow_run")
    if not isinstance(run, dict):
        raise GuardError([f"{event_path}: no workflow_run payload"])
    return run


def verify_context(run: dict, pulls: object, repository: str, default_branch: str) -> tuple[str, str]:
    """Prove the run and the pull request describe the same Dependabot head."""
    reasons: list[str] = []

    if run.get("event") != "pull_request":
        reasons.append(f"run event must be 'pull_request', got {run.get('event')!r}")
    if run.get("conclusion") != "success":
        reasons.append(f"run conclusion must be 'success', got {run.get('conclusion')!r}")
    if dig(run, "repository", "full_name") != repository:
        reasons.append(f"run repository is {dig(run, 'repository', 'full_name')!r}, expected {repository!r}")
    if dig(run, "head_repository", "full_name") != repository:
        reasons.append(
            f"run head repository is {dig(run, 'head_repository', 'full_name')!r}, expected {repository!r}"
        )
    for field in ("actor", "triggering_actor"):
        login = dig(run, field, "login")
        if login != ACTOR:
            reasons.append(f"run {field} is {login!r}, expected {ACTOR!r}")

    run_sha = run.get("head_sha")
    if not isinstance(run_sha, str) or not SHA.match(run_sha):
        reasons.append(f"run head_sha is not a full commit id: {run_sha!r}")
    run_ref = run.get("head_branch")
    reasons.extend(safe_ref(run_ref))

    candidates = pulls if isinstance(pulls, list) else []
    if not isinstance(pulls, list):
        reasons.append("pull request lookup did not return a list")
    elif len(candidates) != 1:
        reasons.append(f"expected exactly one open pull request for the head ref, found {len(candidates)}")
    pull = candidates[0] if len(candidates) == 1 and isinstance(candidates[0], dict) else {}
    if candidates and not pull:
        reasons.append("pull request record is not an object")

    if pull:
        if pull.get("state") != "open":
            reasons.append(f"pull request state must be 'open', got {pull.get('state')!r}")
        author = dig(pull, "user", "login")
        if author != ACTOR:
            reasons.append(f"pull request author is {author!r}, expected {ACTOR!r}")
        if dig(pull, "head", "repo", "full_name") != repository:
            reasons.append(
                f"pull request head repository is {dig(pull, 'head', 'repo', 'full_name')!r}, "
                f"expected {repository!r}"
            )
        if dig(pull, "base", "ref") != default_branch:
            reasons.append(
                f"pull request base is {dig(pull, 'base', 'ref')!r}, expected {default_branch!r}"
            )
        pull_ref = dig(pull, "head", "ref")
        reasons.extend(safe_ref(pull_ref))
        if pull_ref != run_ref:
            reasons.append(f"pull request head ref {pull_ref!r} does not match the run's {run_ref!r}")
        pull_sha = dig(pull, "head", "sha")
        if not isinstance(pull_sha, str) or not SHA.match(pull_sha):
            reasons.append(f"pull request head sha is not a full commit id: {pull_sha!r}")
        elif pull_sha != run_sha:
            reasons.append(f"pull request head sha {pull_sha} does not match the run's {run_sha!r}")

    reject(reasons)
    return str(run_ref), str(run_sha)


def classify(relative: str, trusted: Path) -> str | None:
    """The rejection reason for a path, or None when it is publishable output."""
    if relative == NOTICES:
        return None
    match = BUNDLE.match(relative)
    if not match:
        return f"{relative}: not a generated output path"
    plugin = match.group("plugin")
    if not (trusted / plugin / "package.json").is_file():
        return f"{relative}: {plugin}/ is not a plugin in the default branch"
    return None


def collect(artifact: Path) -> tuple[list[str], list[str], int]:
    """Every artifact entry, as (publishable candidates, rejections, total bytes)."""
    reasons: list[str] = []
    files: list[str] = []
    total = 0
    if artifact.is_symlink() or not artifact.is_dir():
        raise GuardError([f"{artifact}: artifact root is not a directory"])
    for dirpath, dirnames, filenames in os.walk(artifact, followlinks=False):
        here = Path(dirpath)
        for name in sorted(dirnames):
            if (here / name).is_symlink():
                reasons.append(f"{(here / name).relative_to(artifact)}: symlinked directory")
        dirnames[:] = [name for name in sorted(dirnames) if not (here / name).is_symlink()]
        for name in sorted(filenames):
            path = here / name
            relative = str(path.relative_to(artifact))
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                reasons.append(f"{relative}: symlink")
                continue
            if not stat.S_ISREG(info.st_mode):
                reasons.append(f"{relative}: not a regular file")
                continue
            if info.st_nlink > 1:
                reasons.append(f"{relative}: hard link with {info.st_nlink} names")
                continue
            if info.st_size > MAX_FILE_BYTES:
                reasons.append(f"{relative}: {info.st_size} bytes exceeds the {MAX_FILE_BYTES} byte cap")
                continue
            total += info.st_size
            files.append(relative)
    return files, reasons, total


def verify_artifact(
    artifact: Path, trusted: Path, repository: str, head_ref: str, head_sha: str
) -> list[str]:
    entries, reasons, total = collect(artifact)
    if total > MAX_TOTAL_BYTES:
        reasons.append(f"artifact is {total} bytes, over the {MAX_TOTAL_BYTES} byte cap")
    if len(entries) > MAX_FILES:
        reasons.append(f"artifact holds {len(entries)} files, over the {MAX_FILES} file cap")

    payload = [entry for entry in entries if entry != METADATA]
    for entry in payload:
        problem = classify(entry, trusted)
        if problem:
            reasons.append(problem)
    if not payload:
        reasons.append("artifact carries no generated output; the build stage uploads only on drift")

    if METADATA not in entries:
        reasons.append(f"artifact is missing {METADATA}")
    else:
        metadata = read_json(artifact / METADATA)
        if not isinstance(metadata, dict):
            reasons.append(f"{METADATA}: not an object")
        else:
            for key, expected in (
                ("repository", repository),
                ("head_ref", head_ref),
                ("head_sha", head_sha),
            ):
                if metadata.get(key) != expected:
                    reasons.append(f"{METADATA}: {key} is {metadata.get(key)!r}, expected {expected!r}")
            claimed = metadata.get("files")
            if not isinstance(claimed, list) or sorted(str(f) for f in claimed) != sorted(payload):
                reasons.append(f"{METADATA}: files does not match the uploaded payload {sorted(payload)!r}")

    reject(reasons)
    return sorted(payload)


def apply(artifact: Path, manifest: Path, target: Path, trusted: Path) -> list[str]:
    """Copy verified bytes into the head checkout, re-checking the allowlist."""
    reasons: list[str] = []
    root = target.resolve(strict=True)
    written: list[str] = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        relative = line.strip()
        if not relative:
            continue
        problem = classify(relative, trusted)
        if problem:
            reasons.append(problem)
            continue
        source = artifact / relative
        if source.is_symlink() or not source.is_file():
            reasons.append(f"{relative}: no longer a regular file in the artifact")
            continue
        destination = root / relative
        if os.path.commonpath([root, Path(os.path.normpath(destination))]) != str(root):
            reasons.append(f"{relative}: resolves outside the head checkout")
            continue
        if destination.is_symlink():
            reasons.append(f"{relative}: destination is a symlink in the head checkout")
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())
        destination.chmod(0o644)
        written.append(relative)
    reject(reasons)
    return written


def stage(
    repo: Path, changed: Path, out: Path, repository: str, head_ref: str, head_sha: str
) -> list[str]:
    """Build stage: copy the rebuilt output into the upload directory.

    Shares `classify` and the metadata shape with the publish stage, so the two
    halves cannot drift into disagreeing about what is publishable. This half runs
    from the pull request head and holds no credentials; the publish half re-derives
    every one of these judgements from the default branch.
    """
    reasons: list[str] = []
    out.mkdir(parents=True, exist_ok=True)
    staged: list[str] = []
    for line in changed.read_text(encoding="utf-8").splitlines():
        relative = line.strip()
        if not relative:
            continue
        problem = classify(relative, repo)
        if problem:
            reasons.append(problem)
            continue
        source = repo / relative
        if source.is_symlink() or not source.is_file():
            reasons.append(f"{relative}: the rebuild removed it; this automation only publishes bytes")
            continue
        destination = out / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())
        destination.chmod(0o644)
        staged.append(relative)
    reject(reasons)
    staged.sort()
    (out / METADATA).write_text(
        json.dumps(
            {
                "repository": repository,
                "head_ref": head_ref,
                "head_sha": head_sha,
                "files": staged,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return staged


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    branch = sub.add_parser("event-branch", help="print the validated head branch")
    branch.add_argument("--event", type=Path, required=True)

    context = sub.add_parser("verify-context", help="prove the run and the pull request agree")
    context.add_argument("--event", type=Path, required=True)
    context.add_argument("--pulls", type=Path, required=True)
    context.add_argument("--repository", required=True)
    context.add_argument("--default-branch", required=True)
    context.add_argument("--github-output", type=Path)

    verify = sub.add_parser("verify-artifact", help="reduce the artifact to publishable output")
    verify.add_argument("--artifact", type=Path, required=True)
    verify.add_argument("--trusted", type=Path, required=True)
    verify.add_argument("--repository", required=True)
    verify.add_argument("--head-ref", required=True)
    verify.add_argument("--head-sha", required=True)
    verify.add_argument("--manifest", type=Path, required=True)

    write = sub.add_parser("apply", help="copy verified bytes into the head checkout")
    write.add_argument("--artifact", type=Path, required=True)
    write.add_argument("--manifest", type=Path, required=True)
    write.add_argument("--target", type=Path, required=True)
    write.add_argument("--trusted", type=Path, required=True)

    build = sub.add_parser("stage", help="collect the rebuilt output for upload")
    build.add_argument("--repo", type=Path, required=True)
    build.add_argument("--changed", type=Path, required=True)
    build.add_argument("--out", type=Path, required=True)
    build.add_argument("--repository", required=True)
    build.add_argument("--head-ref", required=True)
    build.add_argument("--head-sha", required=True)
    build.add_argument("--github-output", type=Path)

    args = parser.parse_args(argv)
    try:
        if args.command == "event-branch":
            run = event_run(args.event)
            reject(safe_ref(run.get("head_branch")))
            print(run["head_branch"])
        elif args.command == "verify-context":
            ref, sha = verify_context(
                event_run(args.event),
                read_json(args.pulls),
                args.repository,
                args.default_branch,
            )
            if args.github_output:
                with args.github_output.open("a", encoding="utf-8") as handle:
                    handle.write(f"head-ref={ref}\nhead-sha={sha}\n")
            print(f"OK dependabot context: {ACTOR} on {args.repository} {ref} at {sha}")
        elif args.command == "verify-artifact":
            payload = verify_artifact(
                args.artifact, args.trusted, args.repository, args.head_ref, args.head_sha
            )
            args.manifest.write_text("".join(f"{path}\n" for path in payload), encoding="utf-8")
            print(f"OK generated output: {len(payload)} file(s)")
            for path in payload:
                print(f"  {path}")
        elif args.command == "apply":
            written = apply(args.artifact, args.manifest, args.target, args.trusted)
            print(f"OK applied {len(written)} file(s) as bytes")
        else:
            staged = stage(
                args.repo, args.changed, args.out, args.repository, args.head_ref, args.head_sha
            )
            if args.github_output:
                with args.github_output.open("a", encoding="utf-8") as handle:
                    handle.write(f"staged={'true' if staged else 'false'}\n")
            print(f"OK staged {len(staged)} generated file(s)")
            for path in staged:
                print(f"  {path}")
    except GuardError as error:
        for reason in error.reasons:
            print(f"FAIL {reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
