#!/usr/bin/env python3
"""Resolve one release-queue-watch record to a PR shepherd merge bead.

The script is read-only. It validates the watcher record, matches one
`agent:integrator` bead by repository and pull-request number, and emits the
metadata receipt that a caller must persist before waking the shepherd.

Exit codes: 0 resolved/replay/duplicate/control record, 1 invalid input, 2 no
unique shepherd-owned merge bead.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

REPOSITORY_RE = re.compile(r"^[^/\s]+/[^/\s]+$")
HEAD_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")
ACTIVE_STATUSES = {"open", "in_progress", "blocked"}
LIFECYCLE_TRANSITIONS = {"opened", "updated", "failed", "merged", "closed"}
LIFECYCLE_SOURCES = {"webhook", "reconciliation"}
CHECK_STATES = {"pass", "pending", "fail"}
QUEUE_STATES = {"active", "queued", "blocked", "closed"}
REQUIRED_PULL_REQUEST_FIELDS = {
    "repository",
    "number",
    "title",
    "headSha",
    "baseRef",
    "labels",
    "priority",
    "draft",
    "mergeable",
    "checks",
    "createdAt",
    "updatedAt",
    "state",
    "activeSince",
}


class ContractError(ValueError):
    """Raised when a watcher record violates the queue contract."""


class ResolutionError(ValueError):
    """Raised when a valid record does not map to one shepherd merge bead."""


def _unwrap(value: Any) -> Any:
    if isinstance(value, dict) and "data" in value and "schema_version" in value:
        return value["data"]
    return value


def _read_json(path: str) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError(f"cannot read JSON from {path}: {error}") from error


def _validate_pull_request(value: Any, *, dispatch: bool) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError("record.pullRequest must be a JSON object")
    missing = sorted(REQUIRED_PULL_REQUEST_FIELDS - value.keys())
    if missing:
        raise ContractError(f"pullRequest missing fields: {', '.join(missing)}")

    repository = value["repository"]
    number = value["number"]
    head_sha = value["headSha"]
    if not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository):
        raise ContractError("repository must be OWNER/REPO")
    if type(number) is not int or number < 1:
        raise ContractError("number must be a positive integer")
    if not isinstance(head_sha, str) or not HEAD_SHA_RE.fullmatch(head_sha):
        raise ContractError("headSha must be a hexadecimal Git object id")
    if type(value["priority"]) is not int or not 0 <= value["priority"] <= 4:
        raise ContractError("priority must be an integer from 0 through 4")
    if not isinstance(value["labels"], list) or not all(
        isinstance(label, str) for label in value["labels"]
    ):
        raise ContractError("labels must be an array of strings")
    for field in ("title", "baseRef", "createdAt", "updatedAt"):
        if not isinstance(value[field], str) or not value[field]:
            raise ContractError(f"{field} must be a non-empty string")
    if type(value["draft"]) is not bool:
        raise ContractError("draft must be a boolean")
    if value["mergeable"] is not None and type(value["mergeable"]) is not bool:
        raise ContractError("mergeable must be a boolean or null")
    if not _in_enum(value["checks"], CHECK_STATES):
        raise ContractError(f"checks must be one of {sorted(CHECK_STATES)}")
    if not _in_enum(value["state"], QUEUE_STATES):
        raise ContractError(f"state must be one of {sorted(QUEUE_STATES)}")
    if value["activeSince"] is not None and (
        not isinstance(value["activeSince"], str) or not value["activeSince"]
    ):
        raise ContractError("activeSince must be a non-empty string or null")

    if dispatch:
        if value["draft"] is not False:
            raise ContractError("dispatch must describe a non-draft pull request")
        if value["mergeable"] is not True:
            raise ContractError("dispatch must describe a mergeable pull request")
        if value["checks"] != "pass":
            raise ContractError("dispatch checks must be pass")
        if value["state"] != "active":
            raise ContractError("dispatch state must be active")
        if not isinstance(value["activeSince"], str) or not value["activeSince"]:
            raise ContractError("dispatch activeSince must be a non-empty string")
    return value


def validate_record(record: Any) -> dict[str, Any] | None:
    if not isinstance(record, dict):
        raise ContractError("watcher record must be a JSON object")
    record_type = record.get("type")
    if record_type == "dispatch":
        pull_request = _validate_pull_request(record.get("pullRequest"), dispatch=True)
        return {
            "eventType": "dispatch",
            "eventKey": (
                f"dispatch:{pull_request['repository']}#{pull_request['number']}"
                f"@{pull_request['headSha']}"
            ),
            "transition": "ready",
            "pullRequest": pull_request,
        }
    if record_type == "pr-lifecycle":
        transition = record.get("transition")
        source = record.get("source")
        lifecycle_key = record.get("lifecycleKey")
        if not _in_enum(transition, LIFECYCLE_TRANSITIONS):
            raise ContractError(
                f"transition must be one of {sorted(LIFECYCLE_TRANSITIONS)}"
            )
        if not isinstance(source, str) or source not in LIFECYCLE_SOURCES:
            raise ContractError(f"source must be one of {sorted(LIFECYCLE_SOURCES)}")
        if not isinstance(lifecycle_key, str) or not lifecycle_key:
            raise ContractError("lifecycleKey must be a non-empty string")
        pull_request = _validate_pull_request(record.get("pullRequest"), dispatch=False)
        if transition == "failed" and pull_request["checks"] != "fail":
            raise ContractError("failed lifecycle checks must be fail")
        if _in_enum(transition, {"merged", "closed"}) and pull_request["state"] != "closed":
            raise ContractError("terminal lifecycle pullRequest.state must be closed")
        if transition == "merged" and source != "webhook":
            raise ContractError("merged lifecycle must come from webhook")
        if source == "webhook":
            for field in ("deliveryId", "webhookAction"):
                if not isinstance(record.get(field), str) or not record[field]:
                    raise ContractError(
                        f"webhook lifecycle {field} must be a non-empty string"
                    )
        return {
            "eventType": "pr-lifecycle",
            "eventKey": f"lifecycle:{lifecycle_key}",
            "transition": transition,
            "pullRequest": pull_request,
        }
    return None


def _in_enum(value: object, allowed: frozenset[str] | set[str]) -> bool:
    """Membership test that survives an unhashable value.

    `value not in {...}` raises TypeError when value is a list or dict, so a payload
    carrying `"checks": []` or `"transition": []` crashed with a traceback instead of
    the ContractError this validator exists to produce -- the malformed input escaped
    the very check written to reject it. A non-string can never be a member of a set
    of strings, so it is simply not in the enum.
    """
    return isinstance(value, str) and value in allowed


def _labels(bead: dict[str, Any]) -> set[str]:
    # `bd list --json` emits `"labels": null` for a bead with no labels, not `[]`,
    # and 5 of 8 beads in this repository's own store do exactly that. Iterating it
    # raised an unhandled TypeError, so ONE unlabelled bead anywhere in the snapshot
    # killed resolve and replay before main() could convert the failure into an exit
    # code -- traceback, exit 1, no receipt. `metadata: null` was already guarded two
    # functions below; labels was the one that got missed.
    labels = bead.get("labels") or []
    if not isinstance(labels, (list, tuple, set)):
        return set()
    return {label for label in labels if isinstance(label, str)}


def _delivery_state(metadata: dict[str, Any], event_key: str) -> str:
    if metadata.get("shepherd_event_ack") == event_key:
        return "ack"
    if metadata.get("shepherd_event_sent") == event_key:
        return "sent"
    if metadata.get("shepherd_event_pending") == event_key:
        return "pending"
    return "untracked"


def _ensure_unique_shepherd_ownership(beads: list[Any]) -> None:
    owners: dict[tuple[str, int], str] = {}
    for bead in beads:
        if not isinstance(bead, dict) or bead.get("status") not in ACTIVE_STATUSES:
            continue
        if "agent:integrator" not in _labels(bead):
            continue
        metadata = bead.get("metadata")
        if (
            not isinstance(metadata, dict)
            or metadata.get("integration_owner") == "orchestrate"
        ):
            continue
        repository = metadata.get("repo")
        raw_pr = metadata.get("pr")
        if isinstance(raw_pr, bool):
            continue
        try:
            number = int(raw_pr)
        except (TypeError, ValueError):
            continue
        if not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository):
            continue
        identity = (repository, number)
        if identity in owners:
            raise ResolutionError(
                f"duplicate shepherd merge bead ownership for {repository}#{number}: "
                f"{owners[identity]} and {bead.get('id')}"
            )
        owners[identity] = str(bead.get("id"))


def _result(
    bead: dict[str, Any],
    metadata: dict[str, Any],
    event: dict[str, Any],
    status: str,
) -> dict[str, Any]:
    identifier = bead.get("id")
    if not isinstance(identifier, str) or not identifier:
        raise ResolutionError("merge bead is missing its id")
    pull_request = event["pullRequest"]
    event_key = event["eventKey"]
    delivery_state = _delivery_state(metadata, event_key)
    required_metadata: dict[str, str] = {}
    if status == "resolved":
        delivery_state = None
        required_metadata = {
            "shepherd_event": event_key,
            "shepherd_event_head": pull_request["headSha"],
            "shepherd_event_pending": event_key,
            "shepherd_event_transition": event["transition"],
            "shepherd_event_type": event["eventType"],
        }
    elif status == "replay" and delivery_state == "untracked":
        required_metadata = {"shepherd_event_pending": event_key}
    result = {
        "status": status,
        "deliveryState": delivery_state,
        "requiredMetadata": required_metadata,
        "bead": identifier,
        "eventKey": event_key,
        "eventType": event["eventType"],
        "transition": event["transition"],
        "repository": pull_request["repository"],
        "number": pull_request["number"],
        "headSha": pull_request["headSha"],
    }
    if event["eventType"] == "dispatch":
        result["priority"] = pull_request["priority"]
    return result


def resolve(record: Any, beads_value: Any) -> dict[str, Any]:
    record_type = record.get("type") if isinstance(record, dict) else None
    if isinstance(record_type, str) and record_type in {
        "webhook-error",
        "reconcile-error",
    }:
        message = record.get("message")
        if not isinstance(message, str) or not message:
            raise ContractError("watcher error message must be a non-empty string")
        repository = record.get("repository")
        if repository is not None and (
            not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository)
        ):
            raise ContractError("watcher error repository must be OWNER/REPO")
        return {
            "status": "fallback",
            "recordType": record_type,
            "action": "gate-check-and-pass",
            "message": message,
            "repository": repository,
        }
    event = validate_record(record)
    if event is None:
        return {
            "status": "ignored",
            "recordType": record_type,
        }
    beads = _unwrap(beads_value)
    if not isinstance(beads, list):
        raise ContractError("beads snapshot must be a JSON array")

    pull_request = event["pullRequest"]
    candidates: list[dict[str, Any]] = []
    orchestrate_owned = False
    for bead in beads:
        if not isinstance(bead, dict) or bead.get("status") not in ACTIVE_STATUSES:
            continue
        if "agent:integrator" not in _labels(bead):
            continue
        metadata = bead.get("metadata")
        if not isinstance(metadata, dict):
            continue
        raw_pr = metadata.get("pr")
        if isinstance(raw_pr, bool):
            continue
        try:
            bead_pr = int(raw_pr)
        except (TypeError, ValueError):
            continue
        if (
            metadata.get("repo") == pull_request["repository"]
            and bead_pr == pull_request["number"]
        ):
            if metadata.get("integration_owner") == "orchestrate":
                orchestrate_owned = True
                continue
            candidates.append(bead)

    if orchestrate_owned:
        return {
            "status": "ignored",
            "recordType": event["eventType"],
            "reason": "orchestrate-owned",
        }
    if len(candidates) != 1:
        raise ResolutionError(
            f"expected one shepherd merge bead for "
            f"{pull_request['repository']}#{pull_request['number']}, "
            f"found {len(candidates)}"
        )
    bead = candidates[0]
    metadata = bead["metadata"]
    if event["eventType"] == "dispatch":
        anchored_head = metadata.get("head_sha")
        if anchored_head is not None and anchored_head != pull_request["headSha"]:
            raise ResolutionError("dispatch head does not match merge bead metadata")

    event_key = event["eventKey"]
    if metadata.get("shepherd_event_ack") == event_key:
        status = "duplicate"
    elif metadata.get("shepherd_event") == event_key:
        status = "replay"
    else:
        status = "resolved"
    return _result(bead, metadata, event, status)


def replay_unacknowledged(beads_value: Any) -> list[dict[str, Any]]:
    beads = _unwrap(beads_value)
    if not isinstance(beads, list):
        raise ContractError("beads snapshot must be a JSON array")
    _ensure_unique_shepherd_ownership(beads)
    results: list[dict[str, Any]] = []
    for bead in beads:
        if not isinstance(bead, dict) or bead.get("status") not in ACTIVE_STATUSES:
            continue
        if "agent:integrator" not in _labels(bead):
            continue
        metadata = bead.get("metadata")
        if not isinstance(metadata, dict):
            continue
        if metadata.get("integration_owner") == "orchestrate":
            continue
        event_key = metadata.get("shepherd_event")
        if not isinstance(event_key, str) or not event_key:
            continue
        if metadata.get("shepherd_event_ack") == event_key:
            continue
        event_type = metadata.get("shepherd_event_type")
        transition = metadata.get("shepherd_event_transition")
        head_sha = metadata.get("shepherd_event_head")
        repository = metadata.get("repo")
        raw_pr = metadata.get("pr")
        if isinstance(raw_pr, bool):
            raise ResolutionError("queued merge bead has invalid metadata.pr")
        try:
            number = int(raw_pr)
        except (TypeError, ValueError) as error:
            raise ResolutionError(
                "queued merge bead has invalid metadata.pr"
            ) from error
        if not _in_enum(event_type, {"dispatch", "pr-lifecycle"}):
            raise ResolutionError("queued merge bead has invalid shepherd_event_type")
        # The PERSISTED transition is validated on its own terms first. Substituting
        # "ready" for a dispatch event meant a dispatch bead could carry any junk in
        # shepherd_event_transition -- a list, a dict -- and never be checked, because
        # the value actually validated was the literal this line supplies. A field
        # written to the bead is a field that has to be readable next time.
        if transition is not None and not _in_enum(
            transition, LIFECYCLE_TRANSITIONS | {"ready"}
        ):
            raise ResolutionError("queued merge bead has invalid event transition")
        expected_transition = "ready" if event_type == "dispatch" else transition
        if not _in_enum(expected_transition, LIFECYCLE_TRANSITIONS | {"ready"}):
            raise ResolutionError("queued merge bead has invalid event transition")
        if not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository):
            raise ResolutionError("queued merge bead has invalid metadata.repo")
        if number < 1:
            raise ResolutionError("queued merge bead has invalid metadata.pr")
        if not isinstance(head_sha, str) or not HEAD_SHA_RE.fullmatch(head_sha):
            raise ResolutionError("queued merge bead has invalid event head")
        if event_type == "dispatch":
            expected_key = f"dispatch:{repository}#{number}@{head_sha}"
            if event_key != expected_key:
                raise ResolutionError(
                    "queued merge bead event key does not match its identity"
                )
        elif not event_key.startswith("lifecycle:"):
            raise ResolutionError("queued merge bead has invalid lifecycle event key")
        event = {
            "eventType": event_type,
            "eventKey": event_key,
            "transition": expected_transition,
            "pullRequest": {
                "repository": repository,
                "number": number,
                "headSha": head_sha,
                "priority": 4,
            },
        }
        results.append(_result(bead, metadata, event, "replay"))
    return sorted(results, key=lambda item: item["bead"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--beads-file", required=True, help="bd list --json snapshot")
    parser.add_argument(
        "--replay-unacknowledged",
        action="store_true",
        help="emit shepherd events that lack a matching ack",
    )
    args = parser.parse_args(argv)
    try:
        beads = _read_json(args.beads_file)
        if args.replay_unacknowledged:
            result = {"status": "replay", "events": replay_unacknowledged(beads)}
        else:
            result = resolve(json.load(sys.stdin), beads)
    except json.JSONDecodeError as error:
        print(f"invalid watcher JSON: {error}", file=sys.stderr)
        return 1
    except ContractError as error:
        print(f"invalid watcher record: {error}", file=sys.stderr)
        return 1
    except ResolutionError as error:
        print(f"unresolved watcher event: {error}", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
