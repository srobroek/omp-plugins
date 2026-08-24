#!/usr/bin/env python3
"""Resolve one release-queue-watch JSON record to an orchestrate node.

The script is read-only. Dispatches require an approved repository/PR/head
match. Lifecycle records match the repository/PR owner and indicate whether
the run shepherd must revalidate. Both emit crash-replay receipts.

Exit codes: 0 resolved/replay/duplicate/control record, 1 invalid input, 2 no
orchestrate owner (safe to route once to pr-shepherd), 3 ambiguous or invalid
orchestrate ownership (do not reroute).
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
LIFECYCLE_TRANSITIONS = {"opened", "updated", "failed", "merged", "closed"}
LIFECYCLE_SOURCES = {"webhook", "reconciliation"}
CHECK_STATES = {"pass", "pending", "fail"}
QUEUE_STATES = {"active", "queued", "blocked", "closed"}


class ContractError(ValueError):
    """Raised when a watcher record violates the handoff contract."""


class ResolutionError(ValueError):
    """Raised when a valid queue record has no unique orchestrate owner."""


class UnmatchedError(ResolutionError):
    """Raised when a valid queue record has no orchestrate owner."""


def _unwrap(value: Any) -> Any:
    if isinstance(value, dict) and "data" in value and "schema_version" in value:
        return value["data"]
    return value


def _read_json(path: str) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ContractError(f"cannot read JSON from {path}: {error}") from error


def validate_record(record: Any) -> dict[str, Any] | None:
    if not isinstance(record, dict):
        raise ContractError("watcher record must be a JSON object")
    record_type = record.get("type")
    if record_type != "dispatch":
        return None
    pull_request = record.get("pullRequest")
    if not isinstance(pull_request, dict):
        raise ContractError("dispatch.pullRequest must be a JSON object")
    missing = sorted(REQUIRED_PULL_REQUEST_FIELDS - pull_request.keys())
    if missing:
        raise ContractError(
            f"dispatch.pullRequest missing fields: {', '.join(missing)}"
        )

    repository = pull_request["repository"]
    number = pull_request["number"]
    head_sha = pull_request["headSha"]
    priority = pull_request["priority"]
    labels = pull_request["labels"]
    if not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository):
        raise ContractError("repository must be OWNER/REPO")
    if type(number) is not int or number < 1:
        raise ContractError("number must be a positive integer")
    if not isinstance(head_sha, str) or not HEAD_SHA_RE.fullmatch(head_sha):
        raise ContractError("headSha must be a hexadecimal Git object id")
    if type(priority) is not int or not 0 <= priority <= 4:
        raise ContractError("priority must be an integer from 0 through 4")
    if not isinstance(labels, list) or not all(
        isinstance(label, str) for label in labels
    ):
        raise ContractError("labels must be an array of strings")
    for field in ("title", "baseRef", "createdAt", "updatedAt", "activeSince"):
        if not isinstance(pull_request[field], str) or not pull_request[field]:
            raise ContractError(f"{field} must be a non-empty string")
    if pull_request["draft"] is not False:
        raise ContractError("dispatch must describe a non-draft pull request")
    if pull_request["mergeable"] is not True:
        raise ContractError("dispatch must describe a mergeable pull request")
    if pull_request["checks"] != "pass":
        raise ContractError("dispatch checks must be pass")
    if pull_request["state"] != "active":
        raise ContractError("dispatch state must be active")
    return pull_request


def validate_lifecycle_record(record: Any) -> dict[str, Any] | None:
    if not isinstance(record, dict):
        raise ContractError("watcher record must be a JSON object")
    if record.get("type") != "pr-lifecycle":
        return None
    transition = record.get("transition")
    source = record.get("source")
    lifecycle_key = record.get("lifecycleKey")
    if transition not in LIFECYCLE_TRANSITIONS:
        raise ContractError(
            f"transition must be one of {sorted(LIFECYCLE_TRANSITIONS)}"
        )
    if source not in LIFECYCLE_SOURCES:
        raise ContractError(f"source must be one of {sorted(LIFECYCLE_SOURCES)}")
    if not isinstance(lifecycle_key, str) or not lifecycle_key:
        raise ContractError("lifecycleKey must be a non-empty string")
    pull_request = record.get("pullRequest")
    if not isinstance(pull_request, dict):
        raise ContractError("pr-lifecycle.pullRequest must be a JSON object")
    missing = sorted(REQUIRED_PULL_REQUEST_FIELDS - pull_request.keys())
    if missing:
        raise ContractError(
            f"pr-lifecycle.pullRequest missing fields: {', '.join(missing)}"
        )
    repository = pull_request["repository"]
    number = pull_request["number"]
    head_sha = pull_request["headSha"]
    if not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository):
        raise ContractError("repository must be OWNER/REPO")
    if type(number) is not int or number < 1:
        raise ContractError("number must be a positive integer")
    if not isinstance(head_sha, str) or not HEAD_SHA_RE.fullmatch(head_sha):
        raise ContractError("headSha must be a hexadecimal Git object id")
    if (
        type(pull_request["priority"]) is not int
        or not 0 <= pull_request["priority"] <= 4
    ):
        raise ContractError("priority must be an integer from 0 through 4")
    if not isinstance(pull_request["labels"], list) or not all(
        isinstance(label, str) for label in pull_request["labels"]
    ):
        raise ContractError("labels must be an array of strings")
    for field in ("title", "baseRef", "createdAt", "updatedAt"):
        if not isinstance(pull_request[field], str) or not pull_request[field]:
            raise ContractError(f"{field} must be a non-empty string")
    if type(pull_request["draft"]) is not bool:
        raise ContractError("draft must be a boolean")
    if (
        pull_request["mergeable"] is not None
        and type(pull_request["mergeable"]) is not bool
    ):
        raise ContractError("mergeable must be a boolean or null")
    if pull_request["checks"] not in CHECK_STATES:
        raise ContractError(f"checks must be one of {sorted(CHECK_STATES)}")
    if pull_request["state"] not in QUEUE_STATES:
        raise ContractError(f"state must be one of {sorted(QUEUE_STATES)}")
    if pull_request["activeSince"] is not None and (
        not isinstance(pull_request["activeSince"], str)
        or not pull_request["activeSince"]
    ):
        raise ContractError("activeSince must be a non-empty string or null")
    if transition == "failed" and pull_request["checks"] != "fail":
        raise ContractError("failed lifecycle checks must be fail")
    if transition in {"merged", "closed"} and pull_request["state"] != "closed":
        raise ContractError("terminal lifecycle pullRequest.state must be closed")
    if source == "webhook":
        for field in ("deliveryId", "webhookAction"):
            if not isinstance(record.get(field), str) or not record[field]:
                raise ContractError(
                    f"webhook lifecycle {field} must be a non-empty string"
                )
    return {
        "transition": transition,
        "source": source,
        "lifecycleKey": lifecycle_key,
        "pullRequest": pull_request,
    }


def _labels(node: dict[str, Any]) -> set[str]:
    labels = node.get("labels", [])
    return {label for label in labels if isinstance(label, str)}


def _delivery_state(metadata: dict[str, Any], dispatch_key: str) -> str:
    if metadata.get("queue_dispatch_ack") == dispatch_key:
        return "ack"
    if metadata.get("queue_dispatch_sent") == dispatch_key:
        return "sent"
    if metadata.get("queue_dispatch_pending") == dispatch_key:
        return "pending"
    return "untracked"


def _lifecycle_delivery_state(metadata: dict[str, Any], lifecycle_key: str) -> str:
    if metadata.get("queue_lifecycle_ack") == lifecycle_key:
        return "ack"
    if metadata.get("queue_lifecycle_sent") == lifecycle_key:
        return "sent"
    if metadata.get("queue_lifecycle_pending") == lifecycle_key:
        return "pending"
    return "untracked"


def _validate_receipt_lineage(
    metadata: dict[str, Any], prefix: str, event_key: str
) -> None:
    current_field = f"{prefix}"
    current_key = metadata.get(current_field)
    receipt_fields = (f"{prefix}_pending", f"{prefix}_sent", f"{prefix}_ack")
    receipts = {field: metadata.get(field) for field in receipt_fields}
    for field, value in receipts.items():
        if value is not None and (not isinstance(value, str) or not value):
            raise ResolutionError(f"{field} must be a non-empty string")

    if current_key == event_key:
        acknowledged_key = receipts[f"{prefix}_ack"]
        completed_prior_key = (
            acknowledged_key
            if isinstance(acknowledged_key, str) and acknowledged_key != event_key
            else None
        )
        mismatched = [
            field
            for field, value in receipts.items()
            if value is not None and value != event_key and value != completed_prior_key
        ]
        if mismatched:
            raise ResolutionError(
                f"{current_field} receipt mismatch in {', '.join(mismatched)}"
            )
        return

    matching_receipts = [
        field for field, value in receipts.items() if value == event_key
    ]
    if matching_receipts:
        raise ResolutionError(
            f"{current_field} does not match receipts in {', '.join(matching_receipts)}"
        )

    if isinstance(current_key, str) and current_key:
        current_ack = receipts[f"{prefix}_ack"]
        if current_ack != current_key:
            raise ResolutionError(
                f"cannot replace unacknowledged {current_field} {current_key}"
            )


def _ensure_unique_node_ownership(nodes: list[Any]) -> None:
    owners: dict[tuple[str, int], str] = {}
    for node in nodes:
        if not isinstance(node, dict) or node.get("status") != "in_progress":
            continue
        if "orc-node" not in _labels(node):
            continue
        metadata = node.get("metadata")
        if not isinstance(metadata, dict):
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
                f"duplicate orchestrate node ownership for {repository}#{number}: "
                f"{owners[identity]} and {node.get('id')}"
            )
        owners[identity] = str(node.get("id"))


def _handoff_result(
    node: dict[str, Any],
    metadata: dict[str, Any],
    repository: str,
    number: int,
    head_sha: str,
    dispatch_key: str,
    status: str,
    priority: int | None = None,
) -> dict[str, Any]:
    if not isinstance(node.get("id"), str) or not node["id"]:
        raise ResolutionError("approved node is missing its id")
    for field in ("branch", "base_sha"):
        if not isinstance(metadata.get(field), str) or not metadata[field]:
            raise ResolutionError(f"approved node is missing metadata.{field}")
    delivery_state = _delivery_state(metadata, dispatch_key)
    required_metadata: dict[str, str] = {}
    if status == "resolved":
        delivery_state = None
        required_metadata = {
            "queue_dispatch": dispatch_key,
            "queue_dispatch_pending": dispatch_key,
        }
    elif status == "replay" and delivery_state == "untracked":
        required_metadata = {"queue_dispatch_pending": dispatch_key}
    result = {
        "status": status,
        "deliveryState": delivery_state,
        "requiredMetadata": required_metadata,
        "node": node["id"],
        "dispatchKey": dispatch_key,
        "repository": repository,
        "number": number,
        "headSha": head_sha,
        "branch": metadata["branch"],
        "baseSha": metadata["base_sha"],
    }
    if priority is not None:
        result["priority"] = priority
    return result


def _lifecycle_result(
    node: dict[str, Any],
    metadata: dict[str, Any],
    lifecycle: dict[str, Any],
    status: str,
) -> dict[str, Any]:
    identifier = node.get("id")
    if not isinstance(identifier, str) or not identifier:
        raise ResolutionError("orchestrate node is missing its id")
    pull_request = lifecycle["pullRequest"]
    lifecycle_key = lifecycle["lifecycleKey"]
    transition = lifecycle["transition"]
    approved = "state:approved" in _labels(node)
    wake_shepherd = approved or transition in {"failed", "merged", "closed"}
    if wake_shepherd:
        for field in ("branch", "base_sha"):
            if not isinstance(metadata.get(field), str) or not metadata[field]:
                raise ResolutionError(f"orchestrate node is missing metadata.{field}")

    delivery_state = _lifecycle_delivery_state(metadata, lifecycle_key)
    required_metadata: dict[str, str] = {}
    if status == "resolved":
        delivery_state = None
        required_metadata = {
            "queue_lifecycle": lifecycle_key,
            "queue_lifecycle_head": pull_request["headSha"],
            "queue_lifecycle_transition": transition,
        }
        if wake_shepherd:
            required_metadata["queue_lifecycle_pending"] = lifecycle_key
        else:
            required_metadata["queue_lifecycle_ack"] = lifecycle_key
    elif status == "replay" and delivery_state == "untracked":
        receipt = (
            "queue_lifecycle_pending" if wake_shepherd else "queue_lifecycle_ack"
        )
        required_metadata = {receipt: lifecycle_key}

    anchored_head = metadata.get("head_sha")
    result = {
        "status": status,
        "eventType": "pr-lifecycle",
        "deliveryState": delivery_state,
        "requiredMetadata": required_metadata,
        "node": identifier,
        "lifecycleKey": lifecycle_key,
        "transition": transition,
        "source": lifecycle["source"],
        "wakeShepherd": wake_shepherd,
        "repository": pull_request["repository"],
        "number": pull_request["number"],
        "headSha": pull_request["headSha"],
        "headChanged": isinstance(anchored_head, str)
        and anchored_head != pull_request["headSha"],
    }
    if wake_shepherd:
        result["branch"] = metadata["branch"]
        result["baseSha"] = metadata["base_sha"]
    return result


def _resolve_lifecycle(lifecycle: dict[str, Any], nodes_value: Any) -> dict[str, Any]:
    nodes = _unwrap(nodes_value)
    if not isinstance(nodes, list):
        raise ContractError("nodes snapshot must be a JSON array")
    pull_request = lifecycle["pullRequest"]
    candidates: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("status") != "in_progress":
            continue
        if "orc-node" not in _labels(node):
            continue
        metadata = node.get("metadata")
        if not isinstance(metadata, dict):
            continue
        raw_pr = metadata.get("pr")
        if isinstance(raw_pr, bool):
            continue
        try:
            node_pr = int(raw_pr)
        except (TypeError, ValueError):
            continue
        if (
            metadata.get("repo") == pull_request["repository"]
            and node_pr == pull_request["number"]
        ):
            candidates.append(node)
    if not candidates:
        raise UnmatchedError(
            f"no orchestrate node for "
            f"{pull_request['repository']}#{pull_request['number']}"
        )
    if len(candidates) != 1:
        raise ResolutionError(
            f"expected one orchestrate node for "
            f"{pull_request['repository']}#{pull_request['number']}, "
            f"found {len(candidates)}"
        )
    node = candidates[0]
    metadata = node["metadata"]
    lifecycle_key = lifecycle["lifecycleKey"]
    _validate_receipt_lineage(metadata, "queue_lifecycle", lifecycle_key)
    if metadata.get("queue_lifecycle_ack") == lifecycle_key:
        status = "duplicate"
    elif metadata.get("queue_lifecycle") == lifecycle_key:
        status = "replay"
    else:
        status = "resolved"
    return _lifecycle_result(node, metadata, lifecycle, status)


def resolve(record: Any, nodes_value: Any) -> dict[str, Any]:
    if isinstance(record, dict) and record.get("type") in {
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
            "recordType": record["type"],
            "action": "gate-check-and-pass",
            "message": message,
            "repository": repository,
        }
    lifecycle = validate_lifecycle_record(record)
    if lifecycle is not None:
        return _resolve_lifecycle(lifecycle, nodes_value)
    pull_request = validate_record(record)
    if pull_request is None:
        return {
            "status": "ignored",
            "recordType": record.get("type") if isinstance(record, dict) else None,
        }

    nodes = _unwrap(nodes_value)
    if not isinstance(nodes, list):
        raise ContractError("nodes snapshot must be a JSON array")
    repository = pull_request["repository"]
    number = pull_request["number"]
    head_sha = pull_request["headSha"]
    candidates: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("status") != "in_progress":
            continue
        if "state:approved" not in _labels(node):
            continue
        metadata = node.get("metadata")
        if not isinstance(metadata, dict):
            continue
        raw_pr = metadata.get("pr")
        if isinstance(raw_pr, bool):
            continue
        try:
            node_pr = int(raw_pr)
        except (TypeError, ValueError):
            continue
        if (
            metadata.get("repo") == repository
            and node_pr == number
            and metadata.get("head_sha") == head_sha
        ):
            candidates.append(node)

    if not candidates:
        raise UnmatchedError(f"no approved node for {repository}#{number}@{head_sha}")
    if len(candidates) != 1:
        raise ResolutionError(
            f"expected one approved node for {repository}#{number}@{head_sha}, "
            f"found {len(candidates)}"
        )
    node = candidates[0]
    metadata = node["metadata"]
    dispatch_key = f"{repository}#{number}@{head_sha}"
    _validate_receipt_lineage(metadata, "queue_dispatch", dispatch_key)
    persisted_key = metadata.get("queue_dispatch")
    if metadata.get("queue_dispatch_ack") == dispatch_key:
        status = "duplicate"
    elif persisted_key == dispatch_key:
        status = "replay"
    else:
        status = "resolved"
    return _handoff_result(
        node,
        metadata,
        repository,
        number,
        head_sha,
        dispatch_key,
        status,
        pull_request["priority"],
    )


def replay_unacknowledged(nodes_value: Any) -> list[dict[str, Any]]:
    """Reconstruct approved handoffs whose current dispatch lacks an ack."""
    nodes = _unwrap(nodes_value)
    if not isinstance(nodes, list):
        raise ContractError("nodes snapshot must be a JSON array")
    _ensure_unique_node_ownership(nodes)
    handoffs: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("status") != "in_progress":
            continue
        if "state:approved" not in _labels(node):
            continue
        metadata = node.get("metadata")
        if not isinstance(metadata, dict):
            continue
        dispatch_key = metadata.get("queue_dispatch")
        if not isinstance(dispatch_key, str) or not dispatch_key:
            continue
        _validate_receipt_lineage(metadata, "queue_dispatch", dispatch_key)
        if metadata.get("queue_dispatch_ack") == dispatch_key:
            continue
        repository = metadata.get("repo")
        head_sha = metadata.get("head_sha")
        raw_pr = metadata.get("pr")
        if isinstance(raw_pr, bool):
            raise ResolutionError("queued node has invalid metadata.pr")
        try:
            number = int(raw_pr)
        except (TypeError, ValueError) as error:
            raise ResolutionError("queued node has invalid metadata.pr") from error
        if number < 1:
            raise ResolutionError("queued node has invalid metadata.pr")
        if not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository):
            raise ResolutionError("queued node has invalid metadata.repo")
        if not isinstance(head_sha, str) or not HEAD_SHA_RE.fullmatch(head_sha):
            raise ResolutionError("queued node has invalid metadata.head_sha")
        if dispatch_key != f"{repository}#{number}@{head_sha}":
            raise ResolutionError(
                "queued node dispatch key does not match its identity"
            )
        handoffs.append(
            _handoff_result(
                node,
                metadata,
                repository,
                number,
                head_sha,
                dispatch_key,
                "replay",
            )
        )
    return sorted(handoffs, key=lambda handoff: handoff["node"])


def replay_unacknowledged_lifecycles(nodes_value: Any) -> list[dict[str, Any]]:
    """Reconstruct lifecycle wake-ups whose current key lacks an ack."""
    nodes = _unwrap(nodes_value)
    if not isinstance(nodes, list):
        raise ContractError("nodes snapshot must be a JSON array")
    _ensure_unique_node_ownership(nodes)
    handoffs: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict) or node.get("status") != "in_progress":
            continue
        if "orc-node" not in _labels(node):
            continue
        metadata = node.get("metadata")
        if not isinstance(metadata, dict):
            continue
        lifecycle_key = metadata.get("queue_lifecycle")
        if not isinstance(lifecycle_key, str) or not lifecycle_key:
            continue
        _validate_receipt_lineage(metadata, "queue_lifecycle", lifecycle_key)
        if metadata.get("queue_lifecycle_ack") == lifecycle_key:
            continue
        transition = metadata.get("queue_lifecycle_transition")
        head_sha = metadata.get("queue_lifecycle_head")
        repository = metadata.get("repo")
        raw_pr = metadata.get("pr")
        if isinstance(raw_pr, bool):
            raise ResolutionError("queued node has invalid metadata.pr")
        try:
            number = int(raw_pr)
        except (TypeError, ValueError) as error:
            raise ResolutionError("queued node has invalid metadata.pr") from error
        if transition not in LIFECYCLE_TRANSITIONS:
            raise ResolutionError("queued node has invalid lifecycle transition")
        if not isinstance(repository, str) or not REPOSITORY_RE.fullmatch(repository):
            raise ResolutionError("queued node has invalid metadata.repo")
        if number < 1:
            raise ResolutionError("queued node has invalid metadata.pr")
        if not isinstance(head_sha, str) or not HEAD_SHA_RE.fullmatch(head_sha):
            raise ResolutionError("queued node has invalid lifecycle head")
        lifecycle = {
            "transition": transition,
            "source": "replay",
            "lifecycleKey": lifecycle_key,
            "pullRequest": {
                "repository": repository,
                "number": number,
                "headSha": head_sha,
            },
        }
        handoffs.append(_lifecycle_result(node, metadata, lifecycle, "replay"))
    return sorted(handoffs, key=lambda handoff: handoff["node"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nodes-file", required=True, help="bd list --json snapshot")
    parser.add_argument(
        "--replay-unacknowledged",
        action="store_true",
        help="emit approved dispatches that lack a matching ack",
    )
    args = parser.parse_args(argv)
    try:
        nodes = _read_json(args.nodes_file)
        if args.replay_unacknowledged:
            result = {
                "status": "replay",
                "dispatches": replay_unacknowledged(nodes),
                "lifecycles": replay_unacknowledged_lifecycles(nodes),
            }
        else:
            record = json.load(sys.stdin)
            result = resolve(record, nodes)
    except json.JSONDecodeError as error:
        print(f"invalid watcher JSON: {error}", file=sys.stderr)
        return 1
    except ContractError as error:
        print(f"invalid watcher record: {error}", file=sys.stderr)
        return 1
    except UnmatchedError as error:
        print(f"unmatched watcher record: {error}", file=sys.stderr)
        return 2
    except ResolutionError as error:
        print(f"unresolved watcher record: {error}", file=sys.stderr)
        return 3
    json.dump(result, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
