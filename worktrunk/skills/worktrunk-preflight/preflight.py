#!/usr/bin/env python3
"""Read-only Worktrunk preflight checks for linked-worktree runs."""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Any, Callable


APPROVALS_FIX = "wt config approvals add --yes"
MERGE_FIX = "wt merge --no-squash --no-ff"
WORKTREE_FIX = "wt switch -y --create --no-cd --base <base-commit> --format json <branch>"


@dataclass
class Result:
    status: str
    detail: str
    fix: str | None = None

    def as_dict(self, check_id: str) -> dict[str, Any]:
        return {
            "id": check_id,
            "status": self.status,
            "detail": self.detail,
            "fix": self.fix,
        }


@dataclass
class CommandResult:
    returncode: int | None
    stdout: str = ""
    stderr: str = ""
    error: str | None = None

    @property
    def output(self) -> str:
        return "\n".join(part for part in (self.stdout, self.stderr) if part)


class Context:
    def __init__(self) -> None:
        self.cwd = Path.cwd()
        self._cache: dict[tuple[str, ...], CommandResult] = {}
        self.git_root: Path | None = None
        self.git_root_error: str | None = None
        self.ignored_config_keys: list[str] = []

    def run(
        self,
        *args: str,
        cwd: Path | None = None,
        timeout: int = 60,
        use_cache: bool = True,
    ) -> CommandResult:
        key = tuple(args) + (("--cwd", str(cwd)) if cwd else ())
        if use_cache and key in self._cache:
            return self._cache[key]
        try:
            completed = subprocess.run(
                list(args),
                cwd=str(cwd or self.cwd),
                text=True,
                capture_output=True,
                check=False,
                timeout=timeout,
            )
            result = CommandResult(completed.returncode, completed.stdout, completed.stderr)
        except FileNotFoundError as exc:
            result = CommandResult(None, error=f"command not found: {args[0]} ({exc})")
        except subprocess.TimeoutExpired as exc:
            result = CommandResult(None, error=f"timed out after {timeout}s: {' '.join(args)}")
        except OSError as exc:
            result = CommandResult(None, error=f"could not run {' '.join(args)}: {exc}")
        if use_cache:
            self._cache[key] = result
        return result

    def require_git_root(self) -> Path | None:
        if self.git_root is not None or self.git_root_error is not None:
            return self.git_root
        result = self.run("git", "rev-parse", "--show-toplevel")
        root = first_nonempty_line(result.stdout)
        if result.returncode == 0 and root:
            self.git_root = Path(root).resolve()
        else:
            self.git_root_error = command_error(result, "git rev-parse --show-toplevel")
        return self.git_root

    def full_config(self) -> CommandResult:
        return self.run("wt", "config", "show", "--full", timeout=90)


def first_nonempty_line(text: str) -> str:
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def one_line(text: str) -> str:
    return " ".join(text.split())


def command_error(result: CommandResult, command: str) -> str:
    if result.error:
        return result.error
    output = one_line(result.output)
    if output:
        return f"{command} failed ({result.returncode}): {output}"
    return f"{command} failed ({result.returncode})"


def unavailable(result: CommandResult) -> bool:
    return result.returncode is None


def check_wt_available(ctx: Context) -> Result:
    result = ctx.run("wt", "--version")
    if result.returncode == 0:
        return Result("pass", f"{one_line(result.stdout or result.stderr)}")
    if unavailable(result):
        return Result("fail", "wt is absent from PATH")
    return Result("fail", command_error(result, "wt --version"))


def check_inside_git_repo(ctx: Context) -> Result:
    root = ctx.require_git_root()
    if root is not None:
        return Result("pass", f"git repository root is {root}")
    return Result("fail", ctx.git_root_error or "git repository root could not be determined")


def resolve_git_path(raw: str, cwd: Path) -> Path:
    path = Path(raw)
    return (path if path.is_absolute() else cwd / path).resolve()


def check_cwd_is_worktree(ctx: Context) -> Result:
    git_dir = ctx.run("git", "rev-parse", "--git-dir")
    common_dir = ctx.run("git", "rev-parse", "--git-common-dir")
    git_raw = first_nonempty_line(git_dir.stdout)
    common_raw = first_nonempty_line(common_dir.stdout)
    if git_dir.returncode != 0 or common_dir.returncode != 0 or not git_raw or not common_raw:
        details = "; ".join(
            part
            for part in (
                command_error(git_dir, "git rev-parse --git-dir") if git_dir.returncode != 0 else None,
                command_error(common_dir, "git rev-parse --git-common-dir")
                if common_dir.returncode != 0
                else None,
            )
            if part
        )
        return Result("fail", details or "git directory topology could not be determined")

    git_path = resolve_git_path(git_raw, ctx.cwd)
    common_path = resolve_git_path(common_raw, ctx.cwd)
    if os.path.normcase(str(git_path)) == os.path.normcase(str(common_path)):
        return Result(
            "warn",
            f"cwd is the canonical checkout ({ctx.require_git_root() or ctx.cwd}); work belongs in a linked worktree",
            WORKTREE_FIX,
        )
    return Result("pass", f"cwd is a linked worktree (git-dir {git_path}; common-dir {common_path})")


def parse_json_object(text: str) -> dict[str, Any] | None:
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def check_hook_approvals(ctx: Context, fresh: bool = False) -> Result:
    result = ctx.run("wt", "config", "approvals", "list", "--format=json", use_cache=not fresh)
    if result.returncode != 0:
        if unavailable(result):
            return Result("skip", "wt is unavailable; hook approvals cannot be inspected")
        return Result("skip", command_error(result, "wt config approvals list --format=json"))
    data = parse_json_object(result.output)
    if data is None:
        return Result("skip", "Worktrunk returned no parseable approvals JSON")

    state = data.get("state")
    commands = data.get("commands")
    if not isinstance(commands, list):
        commands = []
    unapproved: list[str] = []
    for command in commands:
        if isinstance(command, dict) and command.get("approved") is False:
            phase = str(command.get("phase", "?"))
            name = str(command.get("name", "?"))
            unapproved.append(f"{phase}/{name}")

    stale = data.get("stale")
    stale_items = stale if isinstance(stale, list) else []
    stale_detail = f"; stale entries: {one_line(json.dumps(stale_items, sort_keys=True))}" if stale_items else ""
    if state == "approval_required":
        names = ", ".join(unapproved) if unapproved else "unlisted commands"
        return Result("fail", f"approval_required; unapproved project hooks: {names}{stale_detail}", APPROVALS_FIX)
    if state in {"no_commands", "approved"}:
        if stale_items:
            return Result("warn", f"state={state}; no unapproved hooks{stale_detail}")
        return Result("pass", f"state={state}")
    return Result("skip", f"unrecognized approvals state {state!r}{stale_detail}")


def ignored_config_keys(text: str) -> list[str]:
    pattern = re.compile(r"\bkey\s+([A-Za-z0-9_.-]+)\s+which belongs in user config \(will be ignored\)", re.I)
    return list(dict.fromkeys(match.group(1) for match in pattern.finditer(text)))


def check_config_keys(ctx: Context) -> Result:
    result = ctx.run("wt", "config", "show")
    keys = ignored_config_keys(result.output)
    ctx.ignored_config_keys = keys
    if keys:
        names = ", ".join(keys)
        return Result(
            "fail",
            f"ignored project-config key(s): {names}",
            'Move the setting to ~/.config/worktrunk/config.toml, optionally scoped under [projects."<id>"]',
        )
    if result.returncode == 0:
        return Result("pass", "no project-config keys are being discarded")
    if unavailable(result):
        return Result("skip", "wt is unavailable; config warnings cannot be inspected")
    return Result("skip", command_error(result, "wt config show"))


def check_default_branch(ctx: Context) -> Result:
    result = ctx.run("wt", "config", "state", "default-branch")
    branch = one_line(result.stdout)
    if result.returncode == 0 and branch:
        return Result("pass", f"default branch is {branch}")
    if unavailable(result):
        return Result("skip", "wt is unavailable; default branch cannot be resolved")
    return Result("fail", command_error(result, "wt config state default-branch"))


def parse_section(path: Path, wanted: str) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return values
    section: str | None = None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        section_match = re.match(r"^\[([^\]]+)\]$", stripped)
        if section_match:
            section = section_match.group(1).strip()
            continue
        if section != wanted:
            continue
        key_match = re.match(r"^([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$", stripped)
        if key_match:
            values[key_match.group(1)] = key_match.group(2)
    return values


def repository_project_id(ctx: Context) -> str | None:
    result = ctx.run("git", "config", "--get", "remote.origin.url")
    remote = first_nonempty_line(result.stdout)
    if result.returncode != 0 or not remote:
        return None
    if remote.startswith("git@") and ":" in remote:
        host, path = remote[4:].split(":", 1)
        remote = f"{host}/{path}"
    else:
        remote = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://", "", remote)
        remote = re.sub(r"^[^@/]+@", "", remote)
    remote = remote.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    if remote.endswith(".git"):
        remote = remote[:-4]
    return remote or None


def project_merge_values(path: Path, project_id: str | None) -> dict[str, str]:
    if project_id is None:
        return {}
    values = parse_section(path, f'projects."{project_id}"')
    return {
        key.removeprefix("merge."): value
        for key, value in values.items()
        if key.removeprefix("merge.") in {"squash", "ff"}
    }


def include_covers_dependency(pattern: str, dependency: str) -> bool:
    normalized = pattern.strip()
    if not normalized or normalized.startswith("#") or normalized.startswith("!"):
        return False
    normalized = normalized.removeprefix("./").lstrip("/").rstrip("/")
    if normalized.startswith("**/"):
        normalized = normalized[3:]
    candidates = (dependency, f"{dependency}/", f"{dependency}/placeholder")
    return any(fnmatch.fnmatchcase(candidate, normalized) for candidate in candidates)


def include_patterns(path: Path) -> list[str] | None:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return None


def format_values(values: dict[str, str]) -> str:
    if not values:
        return "no [merge] keys"
    return ", ".join(f"{key}={value}" for key, value in sorted(values.items()))


def check_merge_evidence(ctx: Context) -> Result:
    root = ctx.require_git_root()
    if root is None:
        return Result("skip", "git repository root is unavailable; merge policy cannot be inspected")

    project_path = root / ".config" / "wt.toml"
    project_values = parse_section(project_path, "merge")
    # wt's warning remains authoritative when a config was changed between reads.
    if not project_values and "merge" in ctx.ignored_config_keys:
        project_values = {"merge": "declared by Worktrunk warning"}
    user_path = Path.home() / ".config" / "worktrunk" / "config.toml"
    user_values = parse_section(user_path, "merge")
    project_id = repository_project_id(ctx)
    scoped_values = project_merge_values(user_path, project_id)
    user_values = {**user_values, **scoped_values}
    user_detail = f"user config: {format_values(user_values)}"
    if scoped_values:
        user_detail += f" (project {project_id})"
    invocation_detail = (
        "Reliable control: explicit wt merge --no-squash --no-ff on every worker-to-epic merge; "
        "an epic-to-default merge may be plain or squashing."
    )

    if project_values:
        return Result(
            "fail",
            f"project config [merge] keys are ignored ({format_values(project_values)}); {user_detail}. {invocation_detail}",
            MERGE_FIX,
        )
    squash = user_values.get("squash", "").strip().lower()
    ff = user_values.get("ff", "").strip().lower()
    if squash == "false" and ff == "false":
        return Result("pass", f"{user_detail}; merge evidence is configured. {invocation_detail}")
    return Result("warn", f"{user_detail}; merge evidence is not guaranteed. {invocation_detail}", MERGE_FIX)


def check_provisioning_include(ctx: Context) -> Result:
    root = ctx.require_git_root()
    if root is None:
        return Result("skip", "git repository root is unavailable; ignored dependencies cannot be inspected")
    ignored: list[str] = []
    for dependency in ("node_modules", "target", ".venv"):
        result = ctx.run("git", "check-ignore", "-q", dependency, cwd=root)
        if result.returncode == 0:
            ignored.append(dependency)
        elif result.returncode not in (1,):
            return Result("skip", command_error(result, f"git check-ignore -q {dependency}"))
    include = root / ".worktreeinclude"
    if ignored and not include.exists():
        names = ", ".join(ignored)
        return Result(
            "warn",
            f"ignored dependency directories: {names}; no .worktreeinclude exists. A fresh worktree will fail a focused test run with a missing-module error that reads as broken code",
            "wt step copy-ignored",
        )
    if ignored:
        patterns = include_patterns(include)
        if patterns is None:
            return Result("warn", f".worktreeinclude exists but cannot be read; ignored dependency directories: {', '.join(ignored)}", "repair .worktreeinclude, then run wt step copy-ignored")
        missing = [dependency for dependency in ignored if not any(include_covers_dependency(pattern, dependency) for pattern in patterns)]
        if missing:
            return Result(
                "warn",
                f"ignored dependency directories not matched by {include}: {', '.join(missing)}; a fresh worktree may have incomplete dependencies",
                "add matching <directory>/ patterns to .worktreeinclude, then run wt step copy-ignored",
            )
        return Result("pass", f"ignored dependency directories {', '.join(ignored)} are covered by {include}")
    return Result("pass", "node_modules, target, and .venv are not ignored dependency directories")

def check_node_modules_integrity(ctx: Context) -> Result:
    root = ctx.require_git_root()
    if root is None:
        return Result("skip", "git repository root is unavailable; node_modules integrity cannot be inspected")
    node_modules = root / "node_modules"
    if not node_modules.is_dir():
        return Result("skip", "node_modules is absent; run the provisioning include check first")
    bun_types = node_modules / "@types" / "bun"
    if bun_types.exists() and not (bun_types / "index.d.ts").is_file():
        return Result("warn", "node_modules/@types/bun exists but index.d.ts is missing; this skeleton can make tsc report TS2688 while bun test passes", "bun install --frozen-lockfile, then rerun the Worktrunk preflight")
    return Result("pass", "node_modules type packages are not skeleton directories")


def check_plugin_installed(ctx: Context) -> Result:
    result = ctx.full_config()
    output = result.output
    if re.search(r"Plugin not installed\. To install, run wt config plugins omp install", output, re.I):
        return Result("warn", "Oh-My-Pi plugin is not installed", "wt config plugins omp install")
    if re.search(r"OH-MY-PI[\s\S]{0,500}Plugin installed", output, re.I):
        return Result("pass", "Oh-My-Pi plugin is installed")
    if unavailable(result):
        return Result("skip", "wt is unavailable; Oh-My-Pi plugin status cannot be inspected")
    return Result("skip", "wt config show --full did not identify Oh-My-Pi plugin status")


def check_commit_generation(ctx: Context) -> Result:
    result = ctx.full_config()
    output = result.output
    if re.search(r"Commit generation working", output, re.I):
        return Result(
            "warn",
            "commit generation is configured and working; wt merge squashes into one generated commit by default, destroying per-commit history unless --no-squash is passed",
            "wt merge --no-squash",
        )
    if re.search(r"\[commit\.generation\]", output, re.I):
        return Result(
            "warn",
            "commit generation is configured; wt merge squashes into one generated commit by default, destroying per-commit history unless --no-squash is passed",
            "wt merge --no-squash",
        )
    if result.returncode == 0:
        return Result("pass", "commit generation is not configured")
    if unavailable(result):
        return Result("skip", "wt is unavailable; commit generation cannot be inspected")
    return Result("skip", "wt config show --full did not identify commit generation status")


CHECKS: list[tuple[str, Callable[[Context], Result]]] = [
    ("wt-available", check_wt_available),
    ("inside-git-repo", check_inside_git_repo),
    ("cwd-is-worktree-not-canonical", check_cwd_is_worktree),
    ("hook-approvals", check_hook_approvals),
    ("config-keys-honoured", check_config_keys),
    ("default-branch-resolves", check_default_branch),
    ("merge-evidence-policy", check_merge_evidence),
    ("provisioning-include", check_provisioning_include),
    ("node-modules-integrity", check_node_modules_integrity),
    ("omp-plugin-installed", check_plugin_installed),
    ("commit-generation", check_commit_generation),
]


def summary(results: list[dict[str, Any]]) -> str:
    counts = {status: sum(item["status"] == status for item in results) for status in ("pass", "warn", "fail", "skip")}
    parts = [f"{counts['pass']} pass", f"{counts['warn']} warn", f"{counts['fail']} fail"]
    if counts["skip"]:
        parts.append(f"{counts['skip']} skip")
    return ", ".join(parts)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run read-only Worktrunk preflight checks")
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--only", help="comma-separated check ids")
    parser.add_argument("--apply", action="store_true", help="approve pending hooks, only when hook-approvals fails")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    by_id = dict(CHECKS)
    if args.only:
        selected_ids = [item.strip() for item in args.only.split(",") if item.strip()]
        unknown = [item for item in selected_ids if item not in by_id]
        if unknown:
            raise SystemExit(f"unknown check id(s): {', '.join(unknown)}")
        selected = [(check_id, by_id[check_id]) for check_id in selected_ids]
    else:
        selected = CHECKS

    ctx = Context()
    results: list[dict[str, Any]] = []
    for check_id, check in selected:
        results.append(check(ctx).as_dict(check_id))

    approval_index = next((index for index, item in enumerate(results) if item["id"] == "hook-approvals"), None)
    if args.apply and approval_index is not None and results[approval_index]["status"] == "fail":
        print(APPROVALS_FIX, file=sys.stderr, flush=True)
        apply_result = ctx.run("wt", "config", "approvals", "add", "--yes")
        refreshed = check_hook_approvals(ctx, fresh=True)
        if apply_result.returncode not in (0,):
            refreshed.detail = f"approval command failed: {command_error(apply_result, APPROVALS_FIX)}; {refreshed.detail}"
        results[approval_index] = refreshed.as_dict("hook-approvals")

    strict = bool(args.only)
    report = {"ok": not any(
        item["status"] == "fail" or (strict and item["status"] != "pass") for item in results
    ), "summary": summary(results), "checks": results}
    if args.as_json:
        print(json.dumps(report, separators=(",", ":")))
    else:
        for item in results:
            fix = f"; fix: {item['fix']}" if item["fix"] else ""
            print(f"{item['id']:<32} {item['status']:<4} {one_line(item['detail'])}{fix}")
        print(report["summary"])
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
