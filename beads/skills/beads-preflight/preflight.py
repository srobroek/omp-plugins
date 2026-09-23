#!/usr/bin/env python3
"""Read-only preflight checks for a Beads ledger."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

CHECK_IDS = (
    "bd-available",
    "bd-version-supported",
    "store-reachable",
    "store-is-embedded",
    "actor-identity",
    "ready-work-readable",
    "no-stale-lease-on-open-work",
    "remote-sync-configured",
)

DEFAULT_TIMEOUT_SECONDS = 5.0
STALE_LEASE_LIMIT = 50


class CommandResult:
    def __init__(
        self,
        returncode: int,
        stdout: str,
        stderr: str,
        *,
        command: tuple[str, ...] = (),
        timeout_seconds: float | None = None,
        timed_out: bool = False,
    ):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.command = command
        self.timeout_seconds = timeout_seconds
        self.timed_out = timed_out


def timeout_for(state: dict[str, Any]) -> float:
    return float(state.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS))


def command_text(command: CommandResult) -> str:
    return " ".join(command.command) or "bd command"


def timeout_detail(command: CommandResult) -> str:
    seconds = command.timeout_seconds
    rendered = f"{seconds:g}" if seconds is not None else "the configured limit"
    return f"{command_text(command)} timed out after {rendered} seconds"


def timeout_result(command: CommandResult, *, store_reachable: bool = False, note: str | None = None) -> dict[str, Any]:
    detail = timeout_detail(command)
    if note:
        detail = f"{detail}; {note}"
    status = "fail" if store_reachable else "warn"
    return result(status, detail, "rerun with --timeout SECONDS or inspect the .beads store")


def run_bd(args: list[str], timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> CommandResult:
    env = os.environ.copy()
    env.setdefault("BD_NO_PAGER", "1")
    env.setdefault("BD_NON_INTERACTIVE", "1")
    env.setdefault("PAGER", "cat")
    env.setdefault("GIT_PAGER", "cat")
    command = ("bd", *args)
    try:
        result = subprocess.run(
            list(command),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except FileNotFoundError:
        return CommandResult(127, "", "bd was not found on PATH", command=command, timeout_seconds=timeout_seconds)
    except subprocess.TimeoutExpired:
        return CommandResult(124, "", "", command=command, timeout_seconds=timeout_seconds, timed_out=True)
    return CommandResult(
        result.returncode,
        result.stdout,
        result.stderr,
        command=command,
        timeout_seconds=timeout_seconds,
    )


def detail_error(result: CommandResult) -> str:
    if result.timed_out:
        return timeout_detail(result)
    text = (result.stderr or result.stdout).strip().replace("\n", " ")
    return text or f"command exited {result.returncode}"



def result(status: str, detail: str, fix: str | None = None) -> dict[str, Any]:
    return {"status": status, "detail": detail, "fix": fix}


def version_from(text: str) -> tuple[int, int, int, str | None] | None:
    match = re.search(
        r"(?<![0-9A-Za-z])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?![0-9A-Za-z.-])",
        text,
    )
    if not match:
        return None
    return (
        int(match.group(1)),
        int(match.group(2)),
        int(match.group(3)),
        match.group(4),
    )


def parse_json(text: str) -> Any:
    return json.loads(text.strip())


def rows_from(value: Any) -> list[dict[str, Any]] | None:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if not isinstance(value, dict):
        return None
    for key in ("items", "issues", "ready", "results", "data"):
        candidate = value.get(key)
        if isinstance(candidate, list):
            return [row for row in candidate if isinstance(row, dict)]
    if "id" in value:
        return [value]
    if not value:
        return []
    return None


def item_count(value: Any) -> int | None:
    rows = rows_from(value)
    return None if rows is None else len(rows)


def first_nonblank(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def assigned_to(item: dict[str, Any]) -> str | None:
    metadata = item.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    return first_nonblank(
        item.get("assignee"),
        item.get("assigned_to"),
        item.get("owner"),
        metadata.get("assignee"),
        metadata.get("assigned_to"),
        metadata.get("owner"),
    )


def lease_expiry(item: dict[str, Any]) -> tuple[Any, dt.datetime] | None:
    expiry_names = {
        "leaseexpiresat",
        "leaseexpiry",
        "leaseexpires",
        "leaseexpiration",
        "leaseexpirationat",
        "leaseuntil",
        "leaseuntilat",
    }

    def walk(value: Any) -> tuple[Any, dt.datetime] | None:
        if isinstance(value, dict):
            for key, child in value.items():
                normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
                if normalized in expiry_names:
                    parsed = parse_timestamp(child)
                    if parsed is not None:
                        return child, parsed
                nested = walk(child)
                if nested is not None:
                    return nested
        elif isinstance(value, list):
            for child in value:
                nested = walk(child)
                if nested is not None:
                    return nested
        return None

    return walk(item)


def parse_timestamp(value: Any) -> dt.datetime | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = float(value)
        if seconds > 10_000_000_000:
            seconds /= 1000
        try:
            return dt.datetime.fromtimestamp(seconds, tz=dt.timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)




def check_bd_available(state: dict[str, Any]) -> dict[str, Any]:
    path = shutil.which("bd")
    if path is None:
        state["bd_available"] = False
        return result(
            "fail",
            "bd does not resolve on PATH",
            "export PATH='<directory-containing-bd>:$PATH'",
        )
    command = run_bd(["--version"], timeout_for(state))
    state["version_command"] = command
    if command.timed_out:
        state["bd_available"] = False
        return timeout_result(command)
    if command.returncode != 0:
        state["bd_available"] = False
        return result("fail", f"bd resolves to {path}, but bd --version failed: {detail_error(command)}")
    state["bd_available"] = True
    version = version_from(command.stdout)
    state["version"] = version
    rendered = command.stdout.strip().splitlines()[0] if command.stdout.strip() else "unknown version"
    return result("pass", f"bd resolves to {path}; {rendered}")


def check_bd_version_supported(state: dict[str, Any]) -> dict[str, Any]:
    if "version_command" not in state:
        check_bd_available(state)
    command = state.get("version_command")
    if isinstance(command, CommandResult) and command.timed_out:
        return timeout_result(command)
    if not state.get("bd_available"):
        return result("skip", "bd is unavailable, so its version cannot be checked")
    version = state.get("version")
    if version is None:
        return result("fail", "bd --version did not contain a parseable semantic version")
    major, minor, patch, prerelease = version
    rendered = f"{major}.{minor}.{patch}"
    if prerelease:
        return result(
            "fail",
            f"bd version {rendered}-{prerelease} is a prerelease; stable 1.3.0 or later is required",
            None,
        )
    if (major, minor, patch) < (1, 3, 0):
        return result(
            "fail",
            f"bd version {rendered} is older than stable 1.3.0",
            None,
        )
    return result("pass", f"bd version {rendered} is stable and supported")


def load_info(state: dict[str, Any]) -> tuple[Any | None, CommandResult]:
    if "info_command" in state:
        return state.get("info_json"), state["info_command"]
    command = run_bd(["info", "--json"], timeout_for(state))
    state["info_command"] = command
    if command.returncode != 0:
        return None, command
    try:
        value = parse_json(command.stdout)
    except (TypeError, json.JSONDecodeError):
        return None, command
    state["info_json"] = value
    return value, command


def check_store_reachable(state: dict[str, Any]) -> dict[str, Any]:
    value, command = load_info(state)
    if command.timed_out:
        return timeout_result(command, store_reachable=True)
    if command.returncode != 0:
        return result("fail", f"bd info --json failed: {detail_error(command)}", None)
    if not isinstance(value, dict):
        return result("fail", "bd info --json returned JSON that is not an object", None)
    config = value.get("config")
    prefix = config.get("issue_prefix") if isinstance(config, dict) else None
    if not isinstance(prefix, str) or not prefix.strip():
        return result("fail", "bd info --json has no config.issue_prefix", None)
    return result("pass", f"store reachable; config.issue_prefix={prefix.strip()}")


def check_store_embedded(state: dict[str, Any]) -> dict[str, Any]:
    value, command = load_info(state)
    if command.timed_out:
        return timeout_result(command)
    if command.returncode != 0 or not isinstance(value, dict):
        return result("skip", "bd info --json was not available, so store mode cannot be determined")
    mode = str(value.get("mode", "")).strip().lower()
    database_path = value.get("database_path")
    path_text = str(database_path).strip() if database_path is not None else ""
    path_parts = {part.lower() for part in Path(path_text).parts}
    config = value.get("config")
    config = config if isinstance(config, dict) else {}
    server_modes = {"server", "shared", "proxied", "proxy", "sql-server", "global"}
    server_configured = mode in server_modes or any("server" in str(key).lower() for key in config)
    if server_configured:
        return result("warn", f"server configuration detected (mode={mode or 'unspecified'}); an embedded .beads store is expected")
    if ".beads" in path_parts and mode in {"", "direct", "embedded", "local"}:
        return result("pass", f"embedded .beads store: yes (mode={mode or 'unspecified'}, database_path={path_text})")
    if path_text or mode:
        return result("warn", f"embedded .beads store: no or unconfirmed (mode={mode or 'unspecified'}, database_path={path_text or 'unspecified'}); an embedded .beads store is expected")
    return result("skip", "bd info --json omitted mode and database_path, so store mode cannot be determined")


def check_actor_identity(_: dict[str, Any]) -> dict[str, Any]:
    for name in ("BEADS_ACTOR", "BD_ACTOR"):
        value = os.environ.get(name, "")
        if value.strip():
            return result("pass", f"{name} is set")
    return result("fail", "BEADS_ACTOR and BD_ACTOR are both unset or blank", "export BEADS_ACTOR='your-name'")


def check_ready_work(state: dict[str, Any]) -> dict[str, Any]:
    command = run_bd(["ready", "--json"], timeout_for(state))
    state["ready_command"] = command
    if command.timed_out:
        return timeout_result(command)
    if command.returncode != 0:
        return result("fail", f"bd ready --json failed: {detail_error(command)}", "bd ready --json")
    try:
        value = parse_json(command.stdout)
    except (TypeError, json.JSONDecodeError):
        return result("fail", "bd ready --json returned unparseable JSON", "bd ready --json")
    count = item_count(value)
    if count is None:
        return result("fail", "bd ready --json returned an unrecognized JSON shape", "bd ready --json")
    return result("pass", f"bd ready --json is readable; {count} ready items returned")


def check_stale_leases(state: dict[str, Any]) -> dict[str, Any]:
    if not state.get("run_stale_leases", False):
        return result(
            "skip",
            "no-stale-lease-on-open-work is opt-in for cost; pass --include-slow or select it with --only no-stale-lease-on-open-work",
        )
    help_command = run_bd(["list", "--help"], timeout_for(state))
    if help_command.timed_out:
        return timeout_result(help_command)
    if help_command.returncode != 0:
        return result("skip", f"bd list --help failed, so --json and a result bound cannot be verified: {detail_error(help_command)}")
    help_text = f"{help_command.stdout}\n{help_command.stderr}"
    if "--json" not in help_text:
        return result("skip", "bd list --help does not advertise --json; stale leases cannot be inspected and no result bound can be verified")
    has_limit = "--limit" in help_text
    if has_limit:
        limit_note = f"capped at {STALE_LEASE_LIMIT} rows with --limit"
    else:
        limit_note = "bd list --help advertises no result bound; relies on --timeout"
    list_args = ["list", "--status=open"]
    if has_limit:
        list_args.extend(["--limit", str(STALE_LEASE_LIMIT)])
    list_args.append("--json")
    command = run_bd(list_args, timeout_for(state))
    state["list_command"] = command
    command_name = command_text(command)
    if command.timed_out:
        return timeout_result(command, note=limit_note)
    if command.returncode != 0:
        return result("fail", f"{command_name} failed: {detail_error(command)}; {limit_note}", command_name)
    try:
        value = parse_json(command.stdout)
    except (TypeError, json.JSONDecodeError):
        return result("fail", f"{command_name} returned unparseable JSON; {limit_note}", command_name)
    rows = rows_from(value)
    if rows is None:
        return result("fail", f"{command_name} returned an unrecognized JSON shape; {limit_note}", command_name)
    now = dt.datetime.now(dt.timezone.utc)
    stale: list[tuple[str, Any]] = []
    for row in rows:
        if not assigned_to(row):
            continue
        expiry = lease_expiry(row)
        if expiry is not None and expiry[1] <= now:
            stale.append((str(row.get("id", "unknown")), expiry[0]))
    if stale:
        labels = ", ".join(f"{issue} (expired {when})" for issue, when in stale)
        return result("warn", f"stale assigned leases: {labels}; {limit_note}", "bd unclaim <id>")
    return result("pass", f"no expired leases among {len(rows)} open beads; {limit_note}")




def check_remote_sync(state: dict[str, Any]) -> dict[str, Any]:
    command = run_bd(["dolt", "remote", "list"], timeout_for(state))
    if command.timed_out:
        return timeout_result(command)
    if command.returncode != 0:
        return result("skip", f"bd dolt remote list failed; remote configuration cannot be determined read-only: {detail_error(command)}")
    text = command.stdout.strip()
    if not text:
        return result("skip", "bd dolt remote list returned no output; remote configuration cannot be determined")
    if "no remotes configured" in text.lower():
        return result("pass", "no Dolt remote configured")
    return result("pass", "Dolt remote configured: yes")


CHECKS = {
    "bd-available": check_bd_available,
    "bd-version-supported": check_bd_version_supported,
    "store-reachable": check_store_reachable,
    "store-is-embedded": check_store_embedded,
    "actor-identity": check_actor_identity,
    "ready-work-readable": check_ready_work,
    "no-stale-lease-on-open-work": check_stale_leases,
    "remote-sync-configured": check_remote_sync,
}


def summary(check_results: list[dict[str, Any]], elapsed_seconds: float | None = None) -> str:
    counts = {status: 0 for status in ("pass", "warn", "fail", "skip")}
    for check in check_results:
        counts[check["status"]] += 1
    parts = [f"{counts['pass']} pass", f"{counts['warn']} warn", f"{counts['fail']} fail"]
    if counts["skip"]:
        parts.append(f"{counts['skip']} skip")
    rendered = ", ".join(parts)
    if elapsed_seconds is not None:
        rendered += f", elapsed {elapsed_seconds:.2f}s"
    return rendered


def main() -> int:
    started = time.monotonic()
    parser = argparse.ArgumentParser(description="Run read-only Beads preflight checks")
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--only", help="comma-separated check ids")
    parser.add_argument("--include-slow", action="store_true", help="run the opt-in open-bead lease scan")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, metavar="SECONDS", help="per-command timeout (default: 5)")
    parser.add_argument("--apply", action="store_true", help="report that no safe automatic fix exists")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be a finite number greater than zero")

    selected = list(CHECK_IDS)
    if args.only is not None:
        selected = [item.strip() for item in args.only.split(",") if item.strip()]
        unknown = [item for item in selected if item not in CHECKS]
        if unknown:
            parser.error(f"unknown check id(s): {', '.join(unknown)}")
    state: dict[str, Any] = {
        "timeout_seconds": args.timeout,
        "run_stale_leases": args.include_slow
        or (args.only is not None and "no-stale-lease-on-open-work" in selected),
    }
    checks: list[dict[str, Any]] = []
    for check_id in selected:
        checked = CHECKS[check_id](state)
        checks.append({"id": check_id, **checked})
    report = {
        "ok": not any(check["status"] == "fail" for check in checks),
        "summary": summary(checks, time.monotonic() - started),
        "checks": checks,
    }
    if args.as_json:
        print(json.dumps(report, separators=(",", ":")))
        if args.apply:
            print("No beads check has a safe automatic fix; --apply performed no mutation.", file=sys.stderr)
    else:
        for check in checks:
            fix = f"; fix: {check['fix']}" if check["fix"] else ""
            print(f"{check['id']:<30} {check['status'].upper():<5} {check['detail']}{fix}")
        print(f"Summary: {report['summary']}")
        if args.apply:
            print("No beads check has a safe automatic fix; --apply performed no mutation.")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
