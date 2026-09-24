#!/usr/bin/env python3
"""Prove native Beads lease heartbeat, expiry, reclaim, and provenance.

The proof uses a throwaway git repository and embedded Beads ledger. Because
Beads leases have a fixed five-minute TTL, a complete run normally takes about
six minutes.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BD_TIMEOUT = 30
POLL_INTERVAL = 15


class Proof:
    """Run bd commands in one isolated repository and collect proof steps."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.repo = root / "repo"
        self.ledger = root / "ledger"
        self.steps: list[dict[str, Any]] = []
        self.bead_id: str | None = None
        self.resume_bead_id: str | None = None
        self.fallback_bead_id: str | None = None
        self.reclaim_bead_id: str | None = None
        self.bd_version = "unknown"
        self.base_env = os.environ.copy()
        for name in ("BEADS_DOLT_SHARED_SERVER", "BEADS_DOLT_AUTO_START"):
            self.base_env.pop(name, None)
        self.base_env.update(
            {
                "GIT_TERMINAL_PROMPT": "0",
                "PAGER": "cat",
                "BEADS_DIR": str(self.ledger),
            }
        )

    def command(
        self,
        args: list[str],
        actor: str | None = None,
        *,
        timeout: int = BD_TIMEOUT,
    ) -> subprocess.CompletedProcess[str]:
        """Run one bd command with the proof's isolated environment."""
        env = self.base_env.copy()
        if actor is not None:
            env["BEADS_ACTOR"] = actor
        else:
            env.pop("BEADS_ACTOR", None)
        command = ["bd"]
        if actor is not None:
            command.extend(["--actor", actor])
        command.extend(args)
        try:
            return subprocess.run(
                command,
                cwd=self.repo,
                env=env,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            stdout = error.stdout or ""
            stderr = error.stderr or ""
            if isinstance(stdout, bytes):
                stdout = stdout.decode(errors="replace")
            if isinstance(stderr, bytes):
                stderr = stderr.decode(errors="replace")
            return subprocess.CompletedProcess(command, 124, stdout, f"timed out after {timeout}s\n{stderr}")

    @staticmethod
    def output(result: subprocess.CompletedProcess[str]) -> str:
        """Return bounded command output suitable for step evidence."""
        output = "\n".join(part for part in (result.stdout, result.stderr) if part).strip()
        return output[-2_000:]

    def show_id(self, bead_id: str, actor: str) -> tuple[dict[str, Any] | None, subprocess.CompletedProcess[str]]:
        result = self.command(["show", bead_id, "--json"], actor)
        if result.returncode != 0:
            return None, result
        try:
            payload = json.loads(result.stdout)
            if isinstance(payload, list) and payload and isinstance(payload[0], dict):
                return payload[0], result
        except json.JSONDecodeError:
            pass
        return None, result

    def show(self, actor: str) -> tuple[dict[str, Any] | None, subprocess.CompletedProcess[str]]:
        assert self.bead_id is not None
        return self.show_id(self.bead_id, actor)

    def ready(self, actor: str) -> tuple[list[dict[str, Any]], subprocess.CompletedProcess[str]]:
        result = self.command(["ready", "--json"], actor)
        if result.returncode != 0:
            return [], result
        try:
            payload = json.loads(result.stdout)
            if isinstance(payload, list):
                return [row for row in payload if isinstance(row, dict)], result
        except json.JSONDecodeError:
            pass
        return [], result

    def record(self, step: str, ok: bool, evidence: Any) -> None:
        self.steps.append({"step": step, "ok": ok, "evidence": evidence})


def timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def timestamp_advances(before: Any, after: Any) -> bool:
    before_time = timestamp(before)
    after_time = timestamp(after)
    return before_time is not None and after_time is not None and after_time > before_time


def command_evidence(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    evidence: dict[str, Any] = {"returncode": result.returncode}
    output = Proof.output(result)
    if output:
        evidence["output"] = output
    return evidence


def find_strings(value: Any, needle: str, path: str = "") -> list[str]:
    """Find fields containing *needle*, parsing event JSON values when needed."""
    found: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            if isinstance(child, str) and needle in child.lower():
                found.append(child_path)
                try:
                    decoded = json.loads(child)
                except json.JSONDecodeError:
                    continue
                found.extend(find_strings(decoded, needle, child_path))
            else:
                found.extend(find_strings(child, needle, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(find_strings(child, needle, f"{path}[{index}]"))
    return found


def positive_timeout(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def setup(proof: Proof) -> None:
    proof.repo.mkdir()
    proof.ledger.mkdir()
    subprocess.run(
        ["git", "init", "--quiet"],
        cwd=proof.repo,
        env=proof.base_env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=BD_TIMEOUT,
        check=True,
    )
    result = proof.command(
        [
            "init",
            "--non-interactive",
            "--init-if-missing",
            "--quiet",
            "--prefix",
            "lp",
            "--skip-agents",
            "--skip-hooks",
        ],
        "alice",
    )
    if result.returncode != 0:
        raise RuntimeError(f"bd init failed: {proof.output(result)}")
    version = proof.command(["--version"], "alice")
    if version.returncode == 0:
        proof.bd_version = proof.output(version).splitlines()[0] or "unknown"


def prove_heartbeat(proof: Proof) -> None:
    ids: dict[str, str] = {}
    creates: dict[str, dict[str, Any]] = {}
    for label in ("A", "B", "C"):
        create = proof.command(
            [
                "create",
                "--type",
                "task",
                "--priority",
                "2",
                "--title",
                f"lease lifecycle proof {label}",
                "--json",
            ],
            "alice",
        )
        creates[label] = command_evidence(create)
        try:
            created = json.loads(create.stdout)
            ids[label] = created["id"]
        except (json.JSONDecodeError, KeyError, TypeError, IndexError):
            proof.record("heartbeat", False, {"creates": creates, "error": f"could not read bead {label} id"})
            return

    proof.bead_id = ids["A"]
    proof.resume_bead_id = ids["B"]
    proof.fallback_bead_id = ids["C"]
    claims: dict[str, dict[str, Any]] = {}
    before: dict[str, dict[str, Any] | None] = {}
    shows_before: dict[str, dict[str, Any]] = {}
    for label, bead_id in ids.items():
        claim = proof.command(["update", bead_id, "--claim", "--json"], "alice")
        shown, show_result = proof.show_id(bead_id, "alice")
        claims[label] = command_evidence(claim)
        shows_before[label] = command_evidence(show_result)
        before[label] = shown
        if claim.returncode != 0 or shown is None:
            proof.record(
                "heartbeat",
                False,
                {"beads": ids, "creates": creates, "claims": claims, "shows": shows_before, "error": f"alice could not claim/read bead {label}"},
            )
            return

    time.sleep(3)
    heartbeats: dict[str, dict[str, Any]] = {}
    after: dict[str, dict[str, Any] | None] = {}
    shows_after: dict[str, dict[str, Any]] = {}
    for label, bead_id in ids.items():
        heartbeat = proof.command(["heartbeat", bead_id, "--json"], "alice")
        shown, show_result = proof.show_id(bead_id, "alice")
        heartbeats[label] = command_evidence(heartbeat)
        shows_after[label] = command_evidence(show_result)
        after[label] = shown
    advanced = all(
        after[label] is not None
        and before[label] is not None
        and after[label].get("assignee") == "alice"
        and timestamp_advances(before[label].get("lease_expires_at"), after[label].get("lease_expires_at"))
        and timestamp_advances(before[label].get("heartbeat_at"), after[label].get("heartbeat_at"))
        for label in ids
    )
    proof.record(
        "heartbeat",
        all(result["returncode"] == 0 for result in claims.values())
        and all(result["returncode"] == 0 for result in heartbeats.values())
        and advanced,
        {
            "beads": ids,
            "creates": creates,
            "claims": claims,
            "heartbeats": heartbeats,
            "lease_before": {label: before[label].get("lease_expires_at") if before[label] else None for label in ids},
            "lease_after": {label: after[label].get("lease_expires_at") if after[label] else None for label in ids},
            "heartbeat_before": {label: before[label].get("heartbeat_at") if before[label] else None for label in ids},
            "heartbeat_after": {label: after[label].get("heartbeat_at") if after[label] else None for label in ids},
            "show_before": shows_before,
            "show_after": shows_after,
        },
    )


def prove_live_refusal(proof: Proof) -> None:
    assert proof.bead_id is not None
    before, before_result = proof.show("alice")
    claim = proof.command(["update", proof.bead_id, "--claim", "--json"], "bob")
    heartbeat = proof.command(["heartbeat", proof.bead_id, "--json"], "bob")
    after, after_result = proof.show("alice")
    ok = (
        before is not None
        and claim.returncode != 0
        and heartbeat.returncode != 0
        and after is not None
        and after.get("assignee") == "alice"
        and after.get("status") == "in_progress"
    )
    proof.record(
        "cas-live-refusal",
        ok,
        {
            "bob_claim": command_evidence(claim),
            "bob_heartbeat": command_evidence(heartbeat),
            "assignee_before": before.get("assignee") if before else None,
            "assignee_after": after.get("assignee") if after else None,
            "status_after": after.get("status") if after else None,
            "show_before": command_evidence(before_result),
            "show_after": command_evidence(after_result),
        },
    )


def prove_unclaim_cas(proof: Proof) -> None:
    assert proof.bead_id is not None
    before, before_result = proof.show("alice")
    unclaim = proof.command(["unclaim", proof.bead_id, "--if-assignee", "bob"], "bob")
    after, after_result = proof.show("alice")
    ok = before is not None and unclaim.returncode != 0 and after is not None and after == before
    proof.record(
        "unclaim-cas",
        ok,
        {
            "unclaim": command_evidence(unclaim),
            "before": before,
            "after": after,
            "show_before": command_evidence(before_result),
            "show_after": command_evidence(after_result),
        },
    )


def prove_same_actor_reclaim(proof: Proof) -> None:
    assert proof.bead_id is not None
    before, before_result = proof.show("alice")
    claim = proof.command(["update", proof.bead_id, "--claim", "--json"], "alice")
    after, after_result = proof.show("alice")
    lease_after = timestamp(after.get("lease_expires_at")) if after else None
    fresh = lease_after is not None and lease_after > datetime.now(timezone.utc)
    ok = claim.returncode == 0 and after is not None and after.get("assignee") == "alice" and fresh
    proof.record(
        "same-actor-reclaim",
        ok,
        {
            "claim": command_evidence(claim),
            "lease_before": before.get("lease_expires_at") if before else None,
            "lease_after": after.get("lease_expires_at") if after else None,
            "show_before": command_evidence(before_result),
            "show_after": command_evidence(after_result),
        },
    )


def prove_expiry(proof: Proof, expiry_timeout: int) -> None:
    assert proof.bead_id is not None
    assert proof.resume_bead_id is not None
    assert proof.fallback_bead_id is not None
    beads = {"A": proof.bead_id, "B": proof.resume_bead_id, "C": proof.fallback_bead_id}
    deadline = time.monotonic() + expiry_timeout
    polls = 0
    snapshots: dict[str, dict[str, Any] | None] = {}
    show_results: dict[str, subprocess.CompletedProcess[str]] = {}
    while True:
        snapshots = {}
        show_results = {}
        for label, bead_id in beads.items():
            snapshots[label], show_results[label] = proof.show_id(bead_id, "alice")
        polls += 1
        expired = all(snapshots[label] is not None for label in beads) and all(
            timestamp(snapshots[label].get("lease_expires_at")) is not None
            and timestamp(snapshots[label].get("lease_expires_at")) < datetime.now(timezone.utc)
            for label in beads
        )
        if expired:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(POLL_INTERVAL, remaining))

    expired_before_claim = {
        label: snapshots[label] is not None
        and timestamp(snapshots[label].get("lease_expires_at")) is not None
        and timestamp(snapshots[label].get("lease_expires_at")) < datetime.now(timezone.utc)
        for label in beads
    }
    still_claimed = {
        label: snapshots[label] is not None
        and snapshots[label].get("status") == "in_progress"
        and snapshots[label].get("assignee") == "alice"
        for label in beads
    }
    bob_claim = proof.command(["update", proof.bead_id, "--claim", "--json"], "bob")
    bob_after, bob_after_result = proof.show("bob")
    bob_allowed = bob_claim.returncode == 0
    proof.reclaim_bead_id = proof.fallback_bead_id if bob_allowed else proof.bead_id
    proof.record(
        "expiry",
        all(expired_before_claim.values()) and all(still_claimed.values()),
        {
            "beads": beads,
            "polls": polls,
            "timeout_seconds": expiry_timeout,
            "lease_expires_at": {label: snapshots[label].get("lease_expires_at") if snapshots[label] else None for label in beads},
            "status": {label: snapshots[label].get("status") if snapshots[label] else None for label in beads},
            "assignee": {label: snapshots[label].get("assignee") if snapshots[label] else None for label in beads},
            "expired_before_bob_claim": expired_before_claim,
            "bob_claim_a": command_evidence(bob_claim),
            "bob_claim_a_outcome": "allowed" if bob_allowed else "refused",
            "bob_claim_a_after": bob_after,
            "bob_claim_a_show": command_evidence(bob_after_result),
            "reclaim_target": proof.reclaim_bead_id,
            "show": {label: command_evidence(show_results[label]) for label in beads},
            "native_behavior": "expired lease remains in_progress/alice until reclaim unless another actor can claim it",
        },
    )


def prove_resume_after_expiry(proof: Proof) -> None:
    assert proof.resume_bead_id is not None
    before, before_result = proof.show_id(proof.resume_bead_id, "alice")
    claim = proof.command(["update", proof.resume_bead_id, "--claim", "--json"], "alice")
    after_claim, after_claim_result = proof.show_id(proof.resume_bead_id, "alice")
    heartbeat = proof.command(["heartbeat", proof.resume_bead_id, "--json"], "alice")
    after, after_result = proof.show_id(proof.resume_bead_id, "alice")
    before_expired = (
        before is not None
        and timestamp(before.get("lease_expires_at")) is not None
        and timestamp(before.get("lease_expires_at")) < datetime.now(timezone.utc)
    )
    claim_renewed = (
        after_claim is not None
        and timestamp(after_claim.get("lease_expires_at")) is not None
        and before is not None
        and timestamp(before.get("lease_expires_at")) is not None
        and timestamp(after_claim.get("lease_expires_at")) > timestamp(before.get("lease_expires_at"))
    )
    lease_after = timestamp(after.get("lease_expires_at")) if after else None
    fresh = lease_after is not None and lease_after > datetime.now(timezone.utc)
    ok = heartbeat.returncode == 0 and before_expired and after is not None and after.get("assignee") == "alice" and fresh
    proof.record(
        "resume-after-expiry",
        ok,
        {
            "bead": proof.resume_bead_id,
            "before_expired": before_expired,
            "claim_informational": command_evidence(claim),
            "claim_renewed_informational": claim_renewed,
            "lease_before": before.get("lease_expires_at") if before else None,
            "lease_after_claim": after_claim.get("lease_expires_at") if after_claim else None,
            "show_after_claim": command_evidence(after_claim_result),
            "heartbeat": command_evidence(heartbeat),
            "lease_after_heartbeat": after.get("lease_expires_at") if after else None,
            "assignee": after.get("assignee") if after else None,
            "status": after.get("status") if after else None,
            "show_before": command_evidence(before_result),
            "show_after_heartbeat": command_evidence(after_result),
        },
    )


def prove_reclaim(proof: Proof) -> None:
    assert proof.reclaim_bead_id is not None
    reclaim = proof.command(["reclaim", "--id", proof.reclaim_bead_id, "--older-than", "0s", "--json"], "bob")
    after, after_result = proof.show_id(proof.reclaim_bead_id, "bob")
    ready, ready_result = proof.ready("bob")
    ready_ids = [row.get("id") for row in ready]
    ok = (
        reclaim.returncode == 0
        and after is not None
        and after.get("status") == "open"
        and not after.get("assignee")
        and proof.reclaim_bead_id in ready_ids
    )
    proof.record(
        "reclaim",
        ok,
        {
            "bead": proof.reclaim_bead_id,
            "command": "bd reclaim --id ID --older-than 0s",
            "older_than": "0s",
            "reclaim": command_evidence(reclaim),
            "status": after.get("status") if after else None,
            "assignee": after.get("assignee") if after else None,
            "ready_contains_bead": proof.reclaim_bead_id in ready_ids,
            "show": command_evidence(after_result),
            "ready": command_evidence(ready_result),
        },
    )


def prove_provenance(proof: Proof) -> None:
    assert proof.reclaim_bead_id is not None
    history = proof.command(["history", proof.reclaim_bead_id, "--events", "--json"], "bob")
    events: Any = None
    try:
        events = json.loads(history.stdout)
    except json.JSONDecodeError:
        pass
    reclaim_events: list[Any] = []
    if isinstance(events, list):
        for event in events:
            if isinstance(event, dict) and any(word in str(event.get("event_type", "")).lower() for word in ("reclaim", "recover", "stale")):
                reclaim_events.append(event)
    alice_fields = find_strings(reclaim_events, "alice")
    ok = history.returncode == 0 and bool(reclaim_events) and bool(alice_fields)
    proof.record(
        "provenance",
        ok,
        {
            "bead": proof.reclaim_bead_id,
            "command": f"bd history {proof.reclaim_bead_id} --events --json",
            "event_types": [event.get("event_type") for event in reclaim_events if isinstance(event, dict)],
            "prior_holder": "alice" if alice_fields else None,
            "alice_fields": alice_fields,
            "events": reclaim_events,
            "history": command_evidence(history),
            "error": None if ok else "reclaim event did not record prior holder alice",
        },
    )


def prove_stale_heartbeat(proof: Proof) -> None:
    assert proof.reclaim_bead_id is not None
    stale = proof.command(["heartbeat", proof.reclaim_bead_id, "--json"], "alice")
    claim = proof.command(["update", proof.reclaim_bead_id, "--claim", "--json"], "bob")
    shown, show_result = proof.show_id(proof.reclaim_bead_id, "bob")
    ok = (
        stale.returncode != 0
        and claim.returncode == 0
        and shown is not None
        and shown.get("assignee") == "bob"
        and shown.get("status") == "in_progress"
    )
    proof.record(
        "stale-heartbeat",
        ok,
        {
            "bead": proof.reclaim_bead_id,
            "alice_heartbeat": command_evidence(stale),
            "bob_claim": command_evidence(claim),
            "assignee": shown.get("assignee") if shown else None,
            "status": shown.get("status") if shown else None,
            "show": command_evidence(show_result),
        },
    )


def run(args: argparse.Namespace) -> tuple[dict[str, Any], Path]:
    root = Path(tempfile.mkdtemp(prefix="prove-lease-lifecycle-"))
    proof = Proof(root)
    try:
        setup(proof)
        prove_heartbeat(proof)
        if proof.bead_id is not None and proof.resume_bead_id is not None and proof.fallback_bead_id is not None:
            prove_live_refusal(proof)
            prove_unclaim_cas(proof)
            prove_same_actor_reclaim(proof)
            prove_expiry(proof, args.expiry_timeout)
            prove_resume_after_expiry(proof)
            prove_reclaim(proof)
            prove_provenance(proof)
            prove_stale_heartbeat(proof)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        proof.record("setup", False, {"error": str(error)})
    result = {
        "status": "PASS" if proof.steps and all(step["ok"] for step in proof.steps) else "FAIL",
        "steps": proof.steps,
        "bd_version": proof.bd_version,
    }
    if not args.keep:
        shutil.rmtree(root, ignore_errors=True)
    return result, root


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="print the result as one JSON object")
    parser.add_argument("--keep", action="store_true", help="keep the temporary repository and print its path")
    parser.add_argument(
        "--expiry-timeout",
        type=positive_timeout,
        default=420,
        metavar="SECONDS",
        help="maximum time to wait for the fixed five-minute lease to expire (default: 420; a run takes about six minutes)",
    )
    args = parser.parse_args(argv)
    result, root = run(args)
    if args.json:
        print(json.dumps(result, sort_keys=True))
    else:
        for step in result["steps"]:
            state = "PASS" if step["ok"] else "FAIL"
            evidence = json.dumps(step["evidence"], sort_keys=True, separators=(",", ":"))
            print(f"{step['step']}: {state} {evidence}")
    if args.keep:
        print(f"temporary proof directory: {root}", file=sys.stderr)
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
