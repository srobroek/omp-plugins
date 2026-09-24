#!/usr/bin/env python3
"""Run the orchestrate preflight without changing the repository."""

from __future__ import annotations

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable


STATUSES = {"pass", "fail", "warn", "skip"}
API_FIELDS = (
    "allow_squash_merge",
    "allow_merge_commit",
    "allow_rebase_merge",
    "allow_auto_merge",
    "delete_branch_on_merge",
    "squash_merge_commit_title",
    "squash_merge_commit_message",
)
ROLE_RE = re.compile(r"\|\s*`agent:([^`]+)`\s*\|")
ISOLATION_FIX = r"sed -i '' '/^  isolation:/,/^  showResolvedModelBadge:/ s/^\([[:space:]]*enabled:[[:space:]]*\)true/\1false/' ~/.omp/agent/config.yml"


class CommandResult:
    def __init__(self, argv: list[str], returncode: int, stdout: str, stderr: str):
        self.argv = argv
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def run_command(argv: list[str], timeout: float = 30.0) -> CommandResult:
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError:
        return CommandResult(argv, 127, "", f"{argv[0]}: command not found")
    except subprocess.TimeoutExpired:
        return CommandResult(argv, 124, "", "command timed out")
    return CommandResult(argv, result.returncode, result.stdout, result.stderr)


def command_error(result: CommandResult) -> str:
    message = result.stderr.strip() or result.stdout.strip()
    if not message:
        message = f"exit status {result.returncode}"
    return message.splitlines()[-1][:300]


def decode_json(text: str) -> Any:
    text = text.strip()
    if not text:
        raise ValueError("empty output")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # A CLI may print an informational line before its JSON result. Accept
        # only a complete JSON value from a later line, never a partial object.
        for line in reversed(text.splitlines()):
            candidate = line.strip()
            if candidate.startswith(("{", "[")):
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    continue
        raise ValueError("output was not JSON")


def check(check_id: str, status: str, detail: str, fix: str | None = None) -> dict[str, Any]:
    if status not in STATUSES:
        raise ValueError(f"invalid status {status!r}")
    return {"id": check_id, "status": status, "detail": detail, "fix": fix}


def bool_value(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, dict):
        for key in ("task.isolation.enabled", "enabled", "value"):
            if key in value:
                found = bool_value(value[key])
                if found is not None:
                    return found
        for nested in value.values():
            found = bool_value(nested)
            if found is not None:
                return found
    if isinstance(value, list):
        for nested in value:
            found = bool_value(nested)
            if found is not None:
                return found
    return None


def isolation_check() -> dict[str, Any]:
    argv = ["omp", "config", "get", "task.isolation.enabled", "--json"]
    if shutil.which("omp") is None:
        return check(
            "isolation-disabled",
            "fail",
            "cannot run omp config get task.isolation.enabled --json: omp is unavailable",
            ISOLATION_FIX,
        )
    result = run_command(argv)
    if result.returncode != 0:
        return check(
            "isolation-disabled",
            "fail",
            f"omp config get task.isolation.enabled --json failed: {command_error(result)}",
            ISOLATION_FIX,
        )
    try:
        enabled = bool_value(decode_json(result.stdout))
    except ValueError as error:
        return check(
            "isolation-disabled",
            "fail",
            f"omp config get task.isolation.enabled --json returned invalid JSON: {error}",
            ISOLATION_FIX,
        )
    if enabled is False:
        return check("isolation-disabled", "pass", "task.isolation.enabled=false")
    if enabled is True:
        return check(
            "isolation-disabled",
            "fail",
            "task.isolation.enabled=true; native isolation forks the .beads ledger",
            ISOLATION_FIX,
        )
    return check(
        "isolation-disabled",
        "fail",
        "omp config get task.isolation.enabled --json did not report a boolean",
        ISOLATION_FIX,
    )


def default_branch() -> tuple[str | None, str]:
    if shutil.which("wt") is None:
        return None, "wt is unavailable"
    result = run_command(["wt", "config", "state", "default-branch"])
    if result.returncode != 0:
        return None, f"wt config state default-branch failed: {command_error(result)}"
    for line in reversed(result.stdout.splitlines()):
        candidate = line.strip()
        if candidate and re.fullmatch(r"[A-Za-z0-9._/-]+", candidate):
            return candidate, ""
    return None, "wt config state default-branch returned no branch"


def base_check(base: str | None) -> dict[str, Any]:
    if base and base.strip():
        return check("base-commit-recorded", "pass", f"run base commit recorded: {base.strip()}")

    branch, error = default_branch()
    tip: str | None = None
    if branch and shutil.which("git") is not None:
        result = run_command(["git", "rev-parse", branch])
        if result.returncode == 0:
            for line in reversed(result.stdout.splitlines()):
                candidate = line.strip()
                if re.fullmatch(r"[0-9a-fA-F]{7,64}", candidate):
                    tip = candidate
                    break
        else:
            error = f"git rev-parse {branch} failed: {command_error(result)}"
    if tip:
        detail = (
            f"--base was not supplied; wt config state default-branch={branch}, "
            f"current tip={tip}. wt switch --base defaults to the default branch's CURRENT TIP; "
            f"concurrent workers could otherwise cut from different bases. "
            f"Give every worker this exact SHA: {tip}."
        )
    else:
        detail = (
            "--base was not supplied; workers MUST be given one exact base SHA. "
            "wt switch --base defaults to the default branch's CURRENT TIP, so concurrent "
            f"workers could otherwise cut from different bases ({error})."
        )
    return check("base-commit-recorded", "warn", detail)


def github_repo() -> tuple[str | None, str]:
    if shutil.which("git") is None:
        return None, "git is unavailable"
    result = run_command(["git", "remote", "-v"])
    if result.returncode != 0:
        return None, f"git remote -v failed: {command_error(result)}"
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) < 2:
            continue
        remote = fields[1]
        if "github.com" not in remote.lower():
            continue
        if remote.startswith("git@"):  # git@github.com:owner/repo.git
            path = remote.split(":", 1)[1]
        else:
            match = re.search(r"github\.com[/:](.+)$", remote, re.IGNORECASE)
            if not match:
                continue
            path = match.group(1)
        path = path.split("?", 1)[0].split("#", 1)[0].rstrip("/")
        if path.endswith(".git"):
            path = path[:-4]
        parts = [part for part in path.split("/") if part]
        if len(parts) >= 2:
            return "/".join(parts[-2:]), ""
    return None, "no GitHub remote"


def upstream_policy_check() -> dict[str, Any]:
    repo, remote_detail = github_repo()
    if repo is None:
        return check("upstream-merge-policy", "skip", remote_detail)
    if shutil.which("gh") is None:
        return check(
            "upstream-merge-policy",
            "skip",
            f"GitHub remote {repo} found, but gh is unavailable; attempted gh api repos/{repo}",
        )

    help_result = run_command(["gh", "api", "--help"])
    help_text = f"{help_result.stdout}\n{help_result.stderr}"
    if help_result.returncode != 0 or "--jq" not in help_text:
        return check(
            "upstream-merge-policy",
            "skip",
            "gh api --help did not verify the --jq option; "
            f"cannot safely run gh api repos/{repo} --jq",
        )

    expression = "{allow_squash_merge,allow_merge_commit,allow_rebase_merge,allow_auto_merge,delete_branch_on_merge,squash_merge_commit_title,squash_merge_commit_message}"
    argv = ["gh", "api", f"repos/{repo}", "--jq", expression]
    result = run_command(argv)
    if result.returncode != 0:
        return check(
            "upstream-merge-policy",
            "skip",
            f"GitHub remote {repo} found, but gh api failed (unavailable or unauthenticated): "
            f"{command_error(result)}; attempted {shlex.join(argv)}",
        )
    try:
        payload = decode_json(result.stdout)
    except ValueError as error:
        return check(
            "upstream-merge-policy",
            "skip",
            f"gh api repos/{repo} returned no usable policy ({error}); attempted {shlex.join(argv)}",
        )
    if not isinstance(payload, dict):
        return check(
            "upstream-merge-policy",
            "skip",
            f"gh api repos/{repo} returned a non-object policy; attempted {shlex.join(argv)}",
        )

    policy = {field: payload.get(field) for field in API_FIELDS}
    detail = (
        f"server-side GitHub policy for {repo}: {json.dumps(policy, sort_keys=True, separators=(',', ':'))}. "
        "This forge policy travels with the repository, but its repo-wide setting cannot express "
        "the per-level policy: worker branch to epic branch preserves evidence, while epic branch "
        "to the default branch may squash. The per-invocation flags are the only level-specific "
        "mechanism: use wt merge --no-squash --no-ff for worker-to-epic and plain or squashing wt "
        "merge for epic-to-main. A squash landing is acceptable only while epic branches still "
        "exist, because they hold the merge commits and conflict resolutions; audits must read "
        "those branches before reclaiming them."
    )
    if policy["allow_merge_commit"] is not True:
        detail += " FAIL: allow_merge_commit must be true so worker-to-epic evidence can survive a PR integration."
        return check("upstream-merge-policy", "fail", detail)

    warnings: list[str] = []
    if policy["allow_squash_merge"] is True:
        detail += " allow_squash_merge=true is expected and available for clean epic landing."
    elif policy["allow_squash_merge"] is False:
        warnings.append("allow_squash_merge=false removes the preferred squash option for epic landing")
    if policy["delete_branch_on_merge"] is True:
        warnings.append(
            "delete_branch_on_merge=true would remove epic branches and their merge/conflict evidence after landing"
        )
    if warnings:
        detail += " WARN: " + "; ".join(warnings) + "."
        return check("upstream-merge-policy", "warn", detail)
    return check("upstream-merge-policy", "pass", detail)


def role_kinds() -> list[str]:
    package_root = Path(__file__).resolve().parents[2]
    roles_file = package_root / "rules" / "orchestrate-roles.md"
    try:
        text = roles_file.read_text(encoding="utf-8")
    except OSError:
        return []
    return list(dict.fromkeys(ROLE_RE.findall(text)))


def ready_count(payload: Any) -> int | None:
    if isinstance(payload, list):
        return len(payload)
    if isinstance(payload, dict):
        for key in ("items", "issues", "results", "ready"):
            value = payload.get(key)
            if isinstance(value, list):
                return len(value)
        if not payload:
            return 0
    return None


def worker_roles_check() -> dict[str, Any]:
    if shutil.which("bd") is None:
        return check("worker-role-labels", "skip", "bd is unavailable; cannot confirm ledger reachability")
    kinds = role_kinds()
    if not kinds:
        return check(
            "worker-role-labels",
            "fail",
            "could not read agent:<kind> routing labels from rules/orchestrate-roles.md",
        )

    counts: list[str] = []
    for kind in kinds:
        label = f"agent:{kind}"
        argv = ["bd", "ready", "--label", label, "--json"]
        result = run_command(argv)
        if result.returncode != 0:
            return check(
                "worker-role-labels",
                "fail",
                f"ledger check {shlex.join(argv)} failed: {command_error(result)}",
            )
        try:
            payload = decode_json(result.stdout)
        except ValueError as error:
            return check(
                "worker-role-labels",
                "fail",
                f"ledger check {shlex.join(argv)} returned invalid JSON: {error}",
            )
        count = ready_count(payload)
        if count is None:
            return check(
                "worker-role-labels",
                "fail",
                f"ledger check {shlex.join(argv)} returned an unknown JSON shape",
            )
        counts.append(f"{label}={count}")
    return check("worker-role-labels", "pass", "ledger reachable; ready work by routing label: " + ", ".join(counts))


THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"}


def strip_thinking(selector: str) -> str:
    """Drop a trailing :LEVEL thinking suffix; other colons (e.g. a model version ':0') stay."""
    head, separator, tail = selector.rpartition(":")
    return head if separator and tail in THINKING_LEVELS else selector


def frontmatter_agents() -> tuple[list[tuple[str, str]], str | None]:
    agents_dir = Path(__file__).resolve().parents[2] / "agents"
    agents: list[tuple[str, str]] = []
    try:
        paths = sorted(agents_dir.glob("*.md"))
    except OSError as error:
        return [], f"could not read orchestrate agents: {error}"
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            return [], f"could not read {path}: {error}"
        if not text.startswith("---\n"):
            return [], f"{path} has no frontmatter"
        end = text.find("\n---", 4)
        if end < 0:
            return [], f"{path} has unterminated frontmatter"
        fields: dict[str, str] = {}
        for line in text[4:end].splitlines():
            key, separator, value = line.partition(":")
            if not separator:
                continue
            value = value.strip()
            if key.strip() in {"name", "model"}:
                fields[key.strip()] = value.strip('"\'')
        if not fields.get("name") or not fields.get("model"):
            return [], f"{path} frontmatter must define name and model"
        agents.append((fields["name"], fields["model"]))
    return agents, None


def config_value(argv: list[str]) -> tuple[Any | None, str | None]:
    result = run_command(argv)
    if result.returncode != 0:
        return None, f"{shlex.join(argv)} failed: {command_error(result)}"
    try:
        payload = decode_json(result.stdout)
    except ValueError as error:
        return None, f"{shlex.join(argv)} returned invalid JSON: {error}"
    if not isinstance(payload, dict) or "value" not in payload:
        return None, f"{shlex.join(argv)} returned invalid JSON: missing value field"
    return payload["value"], None


def observed_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def mapping_type_error(key: str, value: Any) -> str | None:
    expected = "mapping of string->string"
    if not isinstance(value, dict):
        return f"{key} has observed type {observed_type(value)}; expected {expected}"
    invalid = [item for item, mapped in value.items() if not isinstance(item, str) or not isinstance(mapped, str)]
    if invalid:
        return f"{key} has observed type object with non-string key/value; expected {expected}"
    return None


def model_list_error(payload: Any) -> str | None:
    expected = "object with models: array of objects containing string selector"
    if not isinstance(payload, dict):
        return f"model list has observed type {observed_type(payload)}; expected {expected}"
    model_items = payload.get("models")
    if not isinstance(model_items, list):
        return f"model list models has observed type {observed_type(model_items)}; expected array of objects containing string selector"
    for index, item in enumerate(model_items):
        if not isinstance(item, dict):
            return f"model list models[{index}] has observed type {observed_type(item)}; expected object containing string selector"
        selector = item.get("selector")
        if not isinstance(selector, str) or not selector:
            return f"model list models[{index}].selector has observed type {observed_type(selector)}; expected non-empty string"
    return None


def model_roles_check() -> dict[str, Any]:
    if shutil.which("omp") is None:
        return check("model-roles", "skip", "omp is unavailable; cannot verify model roles")
    agents, error = frontmatter_agents()
    if error:
        return check("model-roles", "fail", error)
    overrides, error = config_value(["omp", "config", "get", "task.agentModelOverrides", "--json"])
    if error:
        return check("model-roles", "fail", error)
    type_error = mapping_type_error("task.agentModelOverrides", overrides)
    if type_error:
        return check("model-roles", "fail", type_error)
    roles, error = config_value(["omp", "config", "get", "modelRoles", "--json"])
    if error:
        return check("model-roles", "fail", error)
    type_error = mapping_type_error("modelRoles", roles)
    if type_error:
        return check("model-roles", "fail", type_error)
    stale = sorted(key for key in overrides if key.startswith("orc-"))
    if stale:
        return check("model-roles", "fail", "stale override keys must be removed: " + ", ".join(stale))
    models_result = run_command(["omp", "models", "--json"], timeout=20.0)
    if models_result.returncode != 0:
        return check("model-roles", "fail", f"omp models --json failed: {command_error(models_result)}")
    try:
        models_payload = decode_json(models_result.stdout)
    except ValueError as json_error:
        return check("model-roles", "fail", f"omp models --json returned invalid JSON: {json_error}")
    list_error = model_list_error(models_payload)
    if list_error:
        return check("model-roles", "fail", list_error)
    model_items = models_payload["models"]
    selectors = {item["selector"] for item in model_items}
    missing: list[str] = []
    invalid: list[str] = []
    for name, frontmatter_model in agents:
        effective = overrides.get(name) if isinstance(overrides.get(name), str) else frontmatter_model
        if name not in overrides:
            missing.append(f"{name} (set task.agentModelOverrides.{name})")
        if not isinstance(effective, str) or not effective:
            invalid.append(f"{name}: empty effective selector (set task.agentModelOverrides.{name})")
            continue
        selector = strip_thinking(effective)
        if selector.startswith("@"):
            alias = selector[1:]
            if alias not in roles:
                invalid.append(f"{name}: alias @{alias} missing from modelRoles (set modelRoles.{alias})")
                continue
            selector = roles[alias]
            if not isinstance(selector, str) or not selector:
                invalid.append(f"{name}: alias @{alias} has no concrete selector (set modelRoles.{alias})")
                continue
            selector = strip_thinking(selector)
        if selector not in selectors:
            invalid.append(f"{name}: selector {selector!r} unavailable (set task.agentModelOverrides.{name} or modelRoles alias)")
    details: list[str] = []
    if missing:
        details.append("missing overrides: " + ", ".join(missing))
    if invalid:
        details.append("invalid models: " + "; ".join(invalid))
    if details:
        return check("model-roles", "fail", ". ".join(details))
    return check("model-roles", "pass", f"verified {len(agents)} shipped agent model overrides and selectors")


def candidate_paths(explicit: str | None, packages_root: str | None, package_names: Iterable[str], skill: str) -> list[Path]:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    roots: list[Path] = []
    if packages_root:
        roots.append(Path(packages_root).expanduser())
    else:
        roots.append(Path(__file__).resolve().parents[3])
    for root in roots:
        if (root / "packages").is_dir():
            roots.append(root / "packages")
    for root in roots:
        for package in package_names:
            candidates.append(root / package / "skills" / skill / "preflight.py")
    unique: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def find_sibling(explicit: str | None, packages_root: str | None, package_names: Iterable[str], skill: str) -> tuple[Path | None, list[Path]]:
    candidates = candidate_paths(explicit, packages_root, package_names, skill)
    for path in candidates:
        if path.is_file():
            return path, candidates
    return None, candidates


def sibling_checks(
    prefix: str,
    explicit: str | None,
    packages_root: str | None,
    package_names: Iterable[str],
    skill: str,
    apply_worktrunk: bool,
) -> list[dict[str, Any]]:
    sibling, tried = find_sibling(explicit, packages_root, package_names, skill)
    if sibling is None:
        attempted = ", ".join(str(path) for path in tried) or "<no path supplied>"
        return [check(f"{prefix}.preflight", "skip", f"sibling preflight not found; tried: {attempted}")]

    argv = [sys.executable, str(sibling), "--json"]
    if apply_worktrunk:
        argv.append("--apply")
        print(f"forwarding: {shlex.join(argv)}", file=sys.stderr)
    result = run_command(argv)
    if result.returncode not in (0, 1):
        return [
            check(
                f"{prefix}.preflight",
                "fail",
                f"sibling {sibling} could not run: {command_error(result)}",
            )
        ]
    try:
        payload = decode_json(result.stdout)
        raw_checks = payload.get("checks") if isinstance(payload, dict) else None
        if not isinstance(raw_checks, list):
            raise ValueError("missing checks array")
    except (ValueError, AttributeError) as error:
        return [check(f"{prefix}.preflight", "fail", f"sibling {sibling} returned invalid JSON: {error}")]

    merged: list[dict[str, Any]] = []
    for raw in raw_checks:
        if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
            return [check(f"{prefix}.preflight", "fail", f"sibling {sibling} returned a malformed check")]
        status = raw.get("status")
        if status not in STATUSES:
            return [check(f"{prefix}.preflight", "fail", f"sibling {sibling} returned invalid check status")]
        merged.append(
            check(
                f"{prefix}.{raw['id']}",
                status,
                str(raw.get("detail", "")),
                raw.get("fix") if isinstance(raw.get("fix"), str) else None,
            )
        )
    return merged or [check(f"{prefix}.preflight", "skip", f"sibling {sibling} returned no checks")]


def selected(check_id: str, only: set[str]) -> bool:
    if not only:
        return True
    return check_id in only or any(check_id.startswith(item + ".") for item in only)


def selected_group(prefix: str, only: set[str]) -> bool:
    return not only or prefix in only or any(item.startswith(prefix + ".") for item in only)



def summary(checks: list[dict[str, Any]]) -> str:
    counts = {status: 0 for status in ("pass", "warn", "fail", "skip")}
    for item in checks:
        counts[item["status"]] += 1
    parts = [f"{counts[status]} {status}" for status in ("pass", "warn", "fail")]
    if counts["skip"]:
        parts.append(f"{counts['skip']} skip")
    return ", ".join(parts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run orchestrate preflight checks")
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--only", help="comma-separated check ids")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--base")
    parser.add_argument("--beads-preflight")
    parser.add_argument("--worktrunk-preflight")
    parser.add_argument("--packages-root")
    args = parser.parse_args(argv)
    only = {item.strip() for item in (args.only or "").split(",") if item.strip()}

    checks: list[dict[str, Any]] = []
    if selected_group("beads", only):
        checks.extend(
            sibling_checks(
                "beads",
                args.beads_preflight,
                args.packages_root,
                ("beads", "beads"),
                "beads-preflight",
                False,
            )
        )
    if selected_group("worktrunk", only):
        checks.extend(
            sibling_checks(
                "worktrunk",
                args.worktrunk_preflight,
                args.packages_root,
                ("worktrunk", "wt-lite", "worktrunk-lite"),
                "worktrunk-preflight",
                args.apply,
            )
        )
    own_checks = (
        ("isolation-disabled", isolation_check),
        ("base-commit-recorded", lambda: base_check(args.base)),
        ("upstream-merge-policy", upstream_policy_check),
        ("worker-role-labels", worker_roles_check),
        ("model-roles", model_roles_check),
    )
    checks.extend(function() for check_id, function in own_checks if selected(check_id, only))
    checks = [item for item in checks if selected(item["id"], only)]

    output = {"ok": not any(item["status"] == "fail" for item in checks), "summary": summary(checks), "checks": checks}
    if args.as_json:
        print(json.dumps(output, separators=(",", ":")))
    else:
        width = max((len(item["id"]) for item in checks), default=2)
        for item in checks:
            print(f"{item['id']:<{width}}  {item['status']:<4}  {item['detail']}")
            if item["fix"]:
                print(f"{'':<{width}}       fix: {item['fix']}")
        print(output["summary"])
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
