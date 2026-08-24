#!/usr/bin/env python3
"""pr-shepherd: the executable landing boundary.

Callers supply durable identity; this script owns live GitHub checks, queue
order, exact-head merge, proof, and recovery writes. Run with no arguments for
the argument shape of every subcommand.

Two invariants govern edits here:

- The digests produced by `blob_digest` ARE the waiter id, the native holder
  token, the failure key, the recovery key, and the sheepdog wisp id. They must
  stay byte-identical to `git hash-object --stdin`, which
  tests/test_blob_digest.py pins against the real git binary.
- On a merge-queue base, a successful `gh pr merge` only ENQUEUES. Stamping
  `merged` there would report success for a pull request a failing merge group
  can still eject, so queue mode persists `landing_state=queued` and proves
  landing on a later pass.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time

EXIT_UNKNOWN = 2
EXIT_WAITING = 10
EXIT_STALE = 11
EXIT_FAILED = 12
EXIT_SLOT_QUEUED = 75

WAITER_LABEL = "gt:slot-waiter"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# GitHub merge-queue landing states. Distinct from the beads merge slot's
# SLOT_QUEUED, which is an unrelated concept (local slot contention).
STATE_QUEUED = "queued"
STATE_EJECTED = "ejected"
LOCAL_GATE_SCHEMA = "pr-shepherd/local-gate-v1"
BILLING_ANNOTATION = (
    "The job was not started because recent account payments have failed or "
    "your spending limit needs to be increased."
)


class Fail(Exception):
    """Unknown, malformed, or unavailable evidence. Exits EXIT_UNKNOWN."""


class QueryError(Exception):
    """A query could not be answered. The caller decides whether that is fatal."""


def fail(message: str) -> None:
    raise Fail(message)


def require_command(name: str) -> None:
    if shutil.which(name) is None:
        fail(f"{name} not found")


def require_sha(value: str, name: str) -> None:
    if len(value or "") != 40 or re.search(r"[^0-9a-fA-F]", value):
        fail(f"{name} must be a 40-character hexadecimal SHA")


def blob_digest(data: bytes) -> str:
    """`git hash-object --stdin` without the spawn."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def nul_payload(*parts: str) -> bytes:
    """The NUL-terminated field encoding every identity digest hashes.

    surrogateescape, because JSON admits a lone surrogate and `json.loads` returns it
    verbatim -- so any bd metadata field that reaches a digest (holder, generation,
    lease_actor, a failure-key detail derived from a filename with invalid UTF-8) took
    the tool down with an UnencodableError traceback. canonical_repo() already guards
    exactly this the same way; this function was the asymmetry.
    """
    return "".join(f"{part}\0" for part in parts).encode(errors="surrogateescape")


# --------------------------------------------------------------------------
# process helpers
#
# stderr is inherited rather than captured so child diagnostics reach the
# caller, matching the shell this replaces. `quiet` reproduces its `2>/dev/null`.
# --------------------------------------------------------------------------


def _run(argv: list[str], *, env_extra: dict[str, str] | None = None, quiet: bool = False,
         merge_stderr: bool = False) -> subprocess.CompletedProcess:
    env = None
    if env_extra:
        env = {**os.environ, **env_extra}
    stderr = None
    if quiet:
        stderr = subprocess.DEVNULL
    elif merge_stderr:
        stderr = subprocess.STDOUT
    return subprocess.run(argv, stdout=subprocess.PIPE, stderr=stderr, env=env, text=True)


def bd(*args: str, env_extra: dict[str, str] | None = None,
       quiet: bool = False) -> subprocess.CompletedProcess:
    return _run(["bd", *args], env_extra=env_extra, quiet=quiet)


def bd_ok(*args: str, env_extra: dict[str, str] | None = None, quiet: bool = False) -> bool:
    return bd(*args, env_extra=env_extra, quiet=quiet).returncode == 0


def bd_json(*args: str, env_extra: dict[str, str] | None = None, quiet: bool = False):
    """Parsed JSON from bd. Raises QueryError when bd fails or the output is not JSON."""
    result = bd(*args, env_extra=env_extra, quiet=quiet)
    if result.returncode != 0:
        raise QueryError(f"bd {' '.join(args)} exited {result.returncode}")
    try:
        return json.loads(result.stdout)
    except ValueError as error:
        raise QueryError(f"bd {' '.join(args)} did not emit JSON") from error


def gh_tsv(argv: list[str], message: str, *, fields: int | None = None) -> list[str]:
    """Run gh with a caller-supplied @tsv --jq filter and split the row.

    The filter stays in gh rather than moving into this process: gh evaluates it
    in-process, so it costs no spawn, and it keeps the normalization of absent
    fields in one place.
    """
    result = _run(["gh", *argv])
    if result.returncode != 0:
        fail(message)
    row = result.stdout.rstrip("\n").split("\t")
    # ARITY IS ENFORCED HERE rather than left to the caller's unpack. Every caller
    # unpacks a fixed number of fields, so any other count raised ValueError out of
    # main() and exited 1 -- a code outside the documented vocabulary
    # (2/10/11/12/75) that a shell caller reads. Reproduced with a fake gh printing
    # an HTML 502 body while exiting 0, which a proxy or GHES front end really does;
    # empty output and a JSON error body behave the same. fail() turns each into the
    # documented unknown exit instead of a traceback.
    if fields is not None and len(row) != fields:
        fail(f"{message} (expected {fields} tab-separated fields, got {len(row)})")
    return row


def gh_value(argv: list[str], message: str) -> str:
    result = _run(["gh", *argv])
    if result.returncode != 0:
        fail(message)
    return result.stdout.strip()


def git(*args: str, quiet: bool = False) -> subprocess.CompletedProcess:
    return _run(["git", *args], quiet=quiet)


def git_bytes(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], stdout=subprocess.PIPE)


# --------------------------------------------------------------------------
# native merge slot
# --------------------------------------------------------------------------


def slot_state() -> dict:
    state = bd_json("merge-slot", "check", "--json")
    if not isinstance(state, dict):
        raise QueryError("merge-slot check did not emit an object")
    return state


def slot_state_or_fail(message: str = "cannot inspect merge slot") -> dict:
    try:
        return slot_state()
    except QueryError:
        fail(message)


def slot_holder(state: dict) -> str:
    return state.get("holder") or ""


def slot_available(state: dict) -> bool:
    return state.get("available") is True


def slot_id_or_fail(state: dict) -> str:
    slot = state.get("id") or ""
    if not slot:
        fail("merge-slot id is missing")
    return slot


_armed_holder: str | None = None


def arm_slot_release(holder: str) -> None:
    """Release the native slot on any exit, including a delivered signal."""
    global _armed_holder
    _armed_holder = holder
    for sig, code in ((signal.SIGHUP, 129), (signal.SIGINT, 130), (signal.SIGTERM, 143)):
        signal.signal(sig, lambda _signum, _frame, code=code: sys.exit(code))


def disarm_slot_release() -> None:
    global _armed_holder
    _armed_holder = None
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, signal.SIG_DFL)


def run_armed_release() -> None:
    if _armed_holder is None:
        return
    try:
        release_slot(_armed_holder, "terminal")
    except (Fail, QueryError, OSError):
        pass


# --------------------------------------------------------------------------
# waiter identity and records
# --------------------------------------------------------------------------


def waiter_id(slot: str, holder: str, generation) -> str:
    digest = blob_digest(nul_payload(slot, holder, str(generation)))
    return f"{slot}-waiter-{digest[:12]}"


def native_holder_token(holder: str, record: dict) -> str:
    """Bind the queue holder, generation, waiter id, and actor lease into one token."""
    metadata = record.get("metadata") or {}
    waiter = record.get("id")
    generation = metadata.get("generation")
    lease = metadata.get("lease_actor") or ""
    if not waiter or generation is None or not lease:
        raise QueryError("waiter record cannot produce a native holder token")
    digest = blob_digest(nul_payload(holder, str(generation), lease, waiter))
    return f"pr-shepherd:{digest}"


def current_actor() -> str:
    actor = os.environ.get("BEADS_ACTOR") or ""
    if not actor:
        fail("BEADS_ACTOR is required for merge-slot waiters")
    return actor


def waiter_link_state(record: dict, slot: str) -> bool:
    """True when linked, False when the link is absent. Raises on an invalid link."""
    dependencies = record.get("dependencies")
    if dependencies is None:
        dependencies = []
    if not isinstance(dependencies, list):
        raise QueryError("waiter dependencies are malformed")
    parents = [d for d in dependencies if isinstance(d, dict) and d.get("type") == "parent-child"]
    if not parents:
        return False
    if len(parents) != 1 or parents[0].get("depends_on_id") != slot:
        raise QueryError("waiter parent linkage is invalid")
    return True


def require_waiter_link(record: dict, slot: str, message: str) -> None:
    """Abort unless the record carries exactly one parent-child link to the slot.

    An absent link and a malformed one are both fatal here; only
    `ensure_waiter_link` distinguishes them, because only it can repair an absent one.
    """
    try:
        linked = waiter_link_state(record, slot)
    except QueryError:
        linked = False
    if not linked:
        fail(message)


def require_waiter_link_for_recovery(record: dict, slot: str, message: str) -> None:
    """Like require_waiter_link, but an ABSENT link is not fatal.

    A recovery command exists to clear a waiter that is already in a bad state, so
    aborting on the very damage it was invoked to repair made the state unrecoverable:
    `bd create` succeeding while the following `bd dep add` failed left a waiter with
    no parent, and recover-waiter, recover-slot and recover-claim all refused it. Only
    manual bd surgery cleared it.

    A MALFORMED link -- two parents, or a link to another slot -- is still fatal,
    because that is a state this code cannot reason about. Only the absent case is
    tolerated, which is the same distinction ensure_waiter_link draws.
    """
    try:
        waiter_link_state(record, slot)
    except QueryError:
        fail(message)


def waiter_record_state(waiter: str, slot: str, holder: str, generation) -> dict | None:
    """The projected waiter record, or None when it does not exist."""
    records = bd_json("list", "--id", waiter, "--all", "--json")
    if not isinstance(records, list):
        raise QueryError("waiter query did not emit a list")
    if not records:
        return None
    if len(records) != 1:
        raise QueryError("waiter query is ambiguous")
    record = records[0]
    metadata = record.get("metadata") or {}
    if (
        record.get("id") != waiter
        or metadata.get("slot_id") != slot
        or metadata.get("holder") != holder
        or metadata.get("waiter_id") != waiter
        or metadata.get("generation") != generation
    ):
        raise QueryError("waiter identity metadata does not match")
    return {
        "id": record["id"],
        "status": record.get("status"),
        "created_at": record.get("created_at"),
        "assignee": record.get("assignee") or "",
        "metadata": metadata,
        "dependencies": record.get("dependencies") or [],
    }


def waiter_record_state_or_fail(waiter, slot, holder, generation, message) -> dict:
    try:
        record = waiter_record_state(waiter, slot, holder, generation)
    except QueryError:
        fail(message)
    if record is None:
        fail(message)
    return record


def ensure_waiter_link(waiter: str, slot: str, holder: str, generation) -> None:
    record = waiter_record_state_or_fail(
        waiter, slot, holder, generation, f"cannot query waiter {waiter} dependency"
    )
    try:
        if waiter_link_state(record, slot):
            return
    except QueryError:
        fail(f"waiter {waiter} has invalid parent linkage")
    if not bd_ok("dep", "add", waiter, slot, "--type", "parent-child"):
        record = waiter_record_state_or_fail(
            waiter, slot, holder, generation, f"cannot reconcile waiter {waiter} dependency"
        )
        require_waiter_link(record, slot, f"cannot link waiter {waiter} to merge slot {slot}")
        return
    record = waiter_record_state_or_fail(
        waiter, slot, holder, generation, f"cannot verify waiter {waiter} dependency"
    )
    require_waiter_link(record, slot, f"waiter {waiter} parent linkage did not persist")


def waiter_attempts(slot: str, holder: str) -> list:
    attempts = bd_json(
        "list", "--label", WAITER_LABEL, "--all",
        "--metadata-field", f"slot_id={slot}",
        "--metadata-field", f"holder={holder}",
        "--limit", "0", "--json",
    )
    if not isinstance(attempts, list):
        raise QueryError("waiter attempts did not emit a list")
    return attempts


def valid_generation(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QueryError("waiter generation is not a number")
    if value < 1 or float(value) != int(value):
        raise QueryError("waiter generation is not a positive integer")
    return value


def waiter_record_by_id(waiter: str, slot: str, holder: str) -> dict:
    records = bd_json("list", "--id", waiter, "--all", "--json")
    if not isinstance(records, list) or len(records) != 1:
        raise QueryError("waiter lookup is ambiguous")
    generation = valid_generation((records[0].get("metadata") or {}).get("generation"))
    if waiter != waiter_id(slot, holder, generation):
        raise QueryError("waiter id does not match its derived identity")
    record = waiter_record_state(waiter, slot, holder, generation)
    if record is None:
        raise QueryError("waiter disappeared between queries")
    return record


def waiter_record_by_id_or_fail(waiter, slot, holder, message) -> dict:
    try:
        return waiter_record_by_id(waiter, slot, holder)
    except QueryError:
        fail(message)


def active_waiter_record(slot: str, holder: str) -> dict | None:
    """The single open or claimed attempt, or None when there is none."""
    attempts = waiter_attempts(slot, holder)
    active = [a for a in attempts if a.get("status") in ("open", "in_progress")]
    if not active:
        return None
    if len(active) != 1:
        raise QueryError(f"multiple active waiter attempts exist for {holder}")
    return active[0]


def ensure_waiter_record(slot: str, holder: str, mode: str = "resume") -> str:
    if mode not in ("resume", "requeue"):
        fail("waiter mode must be resume or requeue")
    actor = current_actor()
    try:
        attempts = waiter_attempts(slot, holder)
    except QueryError:
        fail("cannot query durable waiter attempts")
    active = [a for a in attempts if a.get("status") in ("open", "in_progress")]
    if len(active) > 1:
        fail(f"multiple active waiter attempts exist for {holder}")
    if len(active) == 1:
        generation = (active[0].get("metadata") or {}).get("generation")
        if generation is None:
            fail("active waiter generation is invalid")
        waiter = waiter_id(slot, holder, generation)
        record = waiter_record_state_or_fail(
            waiter, slot, holder, generation, "active waiter identity is invalid"
        )
        if (record["metadata"].get("lease_actor") or "") != actor:
            fail(f"waiter {waiter} is leased to another actor")
        ensure_waiter_link(waiter, slot, holder, generation)
        return waiter

    if attempts and mode != "requeue":
        fail(f"terminal waiter for {holder} requires explicit requeue")
    generations = [(a.get("metadata") or {}).get("generation") or 0 for a in attempts]
    generation = (max(generations) if generations else 0) + 1
    waiter = waiter_id(slot, holder, generation)
    metadata = json.dumps(
        {
            "slot_id": slot,
            "holder": holder,
            "lease_actor": actor,
            "generation": generation,
            "waiter_id": waiter,
        },
        separators=(",", ":"),
    )
    created = bd_ok(
        "create", f"Merge-slot waiter: {holder}", "--id", waiter,
        "--labels", WAITER_LABEL, "--metadata", metadata, "--silent",
    )
    if created:
        record = waiter_record_state_or_fail(
            waiter, slot, holder, generation, f"created waiter {waiter} is not queryable"
        )
    else:
        record = waiter_record_state_or_fail(
            waiter, slot, holder, generation, f"cannot create or recover durable waiter {waiter}"
        )
        if (record["metadata"].get("lease_actor") or "") != actor:
            fail(f"recovered waiter {waiter} is leased to another actor")
    ensure_waiter_link(waiter, slot, holder, generation)
    status = record.get("status")
    if status == "closed":
        fail(f"durable waiter {waiter} is already terminal")
    if status not in ("open", "in_progress"):
        fail(f"durable waiter {waiter} has invalid status {status or 'empty'}")
    return waiter


def first_waiter_record(slot: str) -> tuple[str, str]:
    """The eligible queue front: earliest created_at, then id. ("", "") when empty."""
    try:
        records = bd_json(
            "list", "--label", WAITER_LABEL, "--status", "open,in_progress",
            "--metadata-field", f"slot_id={slot}", "--limit", "0", "--json",
        )
    except QueryError:
        fail("cannot query merge-slot waiter records")
    if not isinstance(records, list):
        fail("cannot query merge-slot waiter records")

    for row in records:
        waiter = row.get("id")
        if not waiter:
            fail("invalid merge-slot waiter id")
        metadata = row.get("metadata") or {}
        holder = metadata.get("holder")
        if not holder:
            fail("invalid merge-slot waiter holder")
        try:
            generation = valid_generation(metadata.get("generation"))
        except QueryError:
            fail("invalid merge-slot waiter generation")
        if waiter != waiter_id(slot, holder, generation):
            fail(f"merge-slot waiter {waiter} has invalid identity")
        if (metadata.get("waiter_id") or "") != waiter:
            fail(f"merge-slot waiter {waiter} has invalid identity metadata")
        # AN ABSENT LINK IS REPAIRED HERE, not treated as fatal. ensure_waiter_record
        # does `bd create` then `bd dep add`; if the second call loses (bd crash, lock
        # contention, a killed process between the two) the waiter exists with no
        # parent link. This scan runs over EVERY row, so one such waiter aborted
        # acquire_slot for unrelated holders -- and all three recovery commands abort
        # on this same check, so nothing but manual bd surgery cleared it. The bound
        # was itself the bypass.
        #
        # A MALFORMED link is still fatal: two parents, or a link to the wrong slot,
        # is a state this code cannot reason about. Only the absent case is repairable,
        # which is exactly the distinction ensure_waiter_link already draws.
        try:
            linked = waiter_link_state(row, slot)
        except QueryError:
            fail(f"merge-slot waiter {waiter} has invalid parent linkage")
        if not linked:
            ensure_waiter_link(waiter, slot, holder, generation)

    eligible = [
        row
        for row in records
        if row.get("status") in ("open", "in_progress")
        and (row.get("metadata") or {}).get("slot_id") == slot
        and isinstance(row.get("id"), str) and row.get("id")
        and isinstance(row.get("created_at"), str) and row.get("created_at")
        and isinstance((row.get("metadata") or {}).get("holder"), str)
        and (row.get("metadata") or {}).get("holder")
    ]
    if not eligible:
        return "", ""
    front = sorted(eligible, key=lambda row: (row["created_at"], row["id"]))[0]
    return front["id"], front["metadata"]["holder"]


def claim_waiter_record(waiter: str, slot: str, holder: str) -> None:
    actor = current_actor()
    record = waiter_record_by_id_or_fail(waiter, slot, holder, "cannot query waiter before claim")
    status = record.get("status")
    assignee = record.get("assignee") or ""
    if (record["metadata"].get("lease_actor") or "") != actor:
        fail(f"waiter {waiter} is leased to another actor")
    if status == "open":
        if assignee:
            fail(f"open waiter {waiter} has a foreign assignee")
        if not bd_ok("update", waiter, "--claim", env_extra={"BEADS_ACTOR": actor}):
            fail(f"cannot claim owned waiter {waiter}")
        record = waiter_record_by_id_or_fail(waiter, slot, holder, "cannot verify waiter claim")
        status = record.get("status")
        assignee = record.get("assignee") or ""
    if status != "in_progress" or assignee != actor:
        fail(f"waiter {waiter} is not owned by {actor}")
    require_waiter_link(record, slot, f"owned waiter {waiter} lost parent linkage")


def validate_waiter_owner(slot: str, holder: str) -> None:
    actor = current_actor()
    try:
        record = active_waiter_record(slot, holder)
    except QueryError:
        record = None
    if record is None:
        fail(f"cannot find active waiter for owned slot {holder}")
    waiter = record.get("id")
    if not waiter:
        fail("invalid waiter identity")
    record = waiter_record_by_id_or_fail(
        waiter, slot, holder, f"cannot validate waiter {waiter} ownership"
    )
    require_waiter_link(record, slot, f"waiter {waiter} has invalid parent linkage")
    if (
        (record["metadata"].get("lease_actor") or "") != actor
        or record.get("status") != "in_progress"
        or (record.get("assignee") or "") != actor
    ):
        fail(f"waiter {waiter} is not owned by {actor}")


def release_waiter_record(slot: str, holder: str, disposition: str,
                         require_existing: bool = True,
                         reason: str = "merge-slot request completed") -> None:
    actor = current_actor()
    try:
        record = active_waiter_record(slot, holder)
    except QueryError:
        fail(f"cannot query active waiter for {holder}")
    if record is None:
        if not require_existing:
            return
        fail(f"active waiter for {holder} does not exist")
    waiter = record.get("id")
    if not waiter:
        fail("invalid waiter identity")
    record = waiter_record_by_id_or_fail(
        waiter, slot, holder, f"cannot validate waiter {waiter} for release"
    )
    require_waiter_link(record, slot, f"waiter {waiter} has invalid parent linkage")
    status = record.get("status")
    assignee = record.get("assignee") or ""
    if (record["metadata"].get("lease_actor") or "") != actor:
        fail(f"waiter {waiter} is leased to another actor")
    if status == "in_progress" and assignee != actor:
        fail(f"waiter {waiter} is assigned to another actor")
    if disposition == "retryable":
        if not bd_ok("update", waiter, "--assignee", "", "--status", "open"):
            fail(f"cannot reopen retryable waiter {waiter}")
        record = waiter_record_by_id_or_fail(
            waiter, slot, holder, f"cannot verify retryable waiter {waiter}"
        )
        if record.get("status") != "open" or (record.get("assignee") or ""):
            fail(f"retryable waiter {waiter} did not remain open")
    elif disposition == "terminal":
        if not bd_ok("close", waiter, "--reason", reason):
            fail(f"cannot close waiter {waiter}")
        record = waiter_record_by_id_or_fail(
            waiter, slot, holder, f"cannot verify waiter {waiter} close"
        )
        if record.get("status") != "closed":
            fail(f"waiter {waiter} close did not persist")
    else:
        fail("waiter disposition must be retryable or terminal")


def force_close_waiter_record(slot: str, holder: str, require_existing: bool = True,
                              reason: str = "recovered dead waiter") -> None:
    try:
        record = active_waiter_record(slot, holder)
        query_error = False
    except QueryError:
        record, query_error = None, True
    if record is None and not query_error:
        try:
            attempts = waiter_attempts(slot, holder)
        except QueryError:
            fail(f"cannot query terminal waiter for {holder}")
        if attempts:
            terminal = sorted(
                attempts, key=lambda a: (a.get("metadata") or {}).get("generation") or 0
            )[-1]
            waiter = terminal.get("id")
            if not waiter:
                fail("invalid waiter identity")
            record = waiter_record_by_id_or_fail(
                waiter, slot, holder, f"cannot validate terminal waiter {waiter}"
            )
            require_waiter_link_for_recovery(
                record, slot, f"terminal waiter {waiter} has invalid parent linkage"
            )
            if record.get("status") != "closed":
                fail(f"waiter {waiter} has invalid terminal status")
            return
        if not require_existing:
            return
        fail(f"waiter for {holder} does not exist")
    if record is None:
        fail(f"cannot query active waiter for {holder}")
    waiter = record.get("id")
    if not waiter:
        fail("invalid waiter identity")
    record = waiter_record_by_id_or_fail(
        waiter, slot, holder, f"cannot validate waiter {waiter} for recovery"
    )
    require_waiter_link(record, slot, f"waiter {waiter} has invalid parent linkage")
    if not bd_ok("close", waiter, "--reason", reason):
        fail(f"cannot close waiter {waiter}")


def close_observed_waiter_generation(slot: str, holder: str, observed: dict,
                                     expected_lease: str, reason: str) -> None:
    waiter = observed.get("id")
    if not waiter:
        fail("invalid observed waiter identity")
    generation = (observed.get("metadata") or {}).get("generation")
    if generation is None:
        fail("invalid observed waiter generation")
    record = waiter_record_state_or_fail(
        waiter, slot, holder, generation, f"cannot validate observed waiter {waiter}"
    )
    require_waiter_link_for_recovery(record, slot, f"observed waiter {waiter} has invalid parent linkage")
    if (record["metadata"].get("lease_actor") or "") != expected_lease:
        fail(f"observed waiter {waiter} lease changed")
    status = record.get("status")
    if status != "closed":
        if status not in ("open", "in_progress"):
            fail(f"observed waiter {waiter} has invalid status {status or 'empty'}")
        if not bd_ok("close", waiter, "--reason", reason):
            fail(f"cannot close observed waiter {waiter}")
    record = waiter_record_state_or_fail(
        waiter, slot, holder, generation, f"cannot verify observed waiter {waiter} close"
    )
    if record.get("status") != "closed":
        fail(f"observed waiter {waiter} close did not persist")


# --------------------------------------------------------------------------
# slot acquisition and release
# --------------------------------------------------------------------------


def acquire_slot(holder: str, attempts: str = "3", interval: str = "1",
                 protection: str = "handoff", waiter_mode: str = "resume") -> int:
    if not holder:
        fail("slot holder is required")
    if not re.fullmatch(r"[1-9][0-9]*", str(attempts)):
        fail("attempts must be a positive integer")
    if not re.fullmatch(r"[0-9]+", str(interval)):
        fail("poll interval must be a non-negative integer")
    if protection not in ("handoff", "armed"):
        fail("slot protection must be handoff or armed")
    if waiter_mode not in ("resume", "requeue"):
        fail("waiter mode must be resume or requeue")
    attempt_limit = int(attempts)
    poll = int(interval)

    created = bd("merge-slot", "create")
    if created.returncode != 0:
        raise SystemExit(created.returncode)
    state = slot_state_or_fail()
    slot = slot_id_or_fail(state)
    waiter = ensure_waiter_record(slot, holder, waiter_mode)
    record = waiter_record_by_id_or_fail(
        waiter, slot, holder, "cannot validate waiter before native slot entry"
    )
    try:
        native_holder = native_holder_token(holder, record)
    except QueryError:
        fail("cannot derive native holder token")

    for attempt in range(1, attempt_limit + 1):
        if attempt > 1 and poll > 0:
            time.sleep(poll)
        state = slot_state_or_fail()
        actual = slot_holder(state)
        if actual == native_holder:
            claim_waiter_record(waiter, slot, holder)
            if protection == "armed":
                arm_slot_release(holder)
            print(f"SLOT_OWNED holder={holder} resumed=true")
            return 0
        if slot_available(state):
            front_id, front_holder = first_waiter_record(slot)
            if front_id == waiter and front_holder == holder:
                claim_waiter_record(waiter, slot, holder)
                front_id, front_holder = first_waiter_record(slot)
                if front_id != waiter or front_holder != holder:
                    fail(f"waiter {waiter} lost queue priority during claim")
                acquired = bd("merge-slot", "acquire", "--holder", native_holder)
                if acquired.returncode == 0:
                    if protection == "armed":
                        arm_slot_release(holder)
                    print(f"SLOT_OWNED holder={holder} resumed=false")
                    return 0
                if acquired.returncode != 1:
                    fail(f"merge-slot acquire failed with exit {acquired.returncode}")

    release_waiter_record(slot, holder, "retryable", True, "merge-slot request remains queued")
    print(f"SLOT_QUEUED holder={holder} attempts={attempts} waiter={waiter} persisted=true")
    return EXIT_SLOT_QUEUED


def release_slot(holder: str, disposition: str = "terminal", quiet: bool = False) -> int:
    if disposition not in ("retryable", "terminal"):
        fail("slot release disposition must be retryable or terminal")
    try:
        state = slot_state()
    except QueryError:
        print(f"SLOT_RELEASE_UNKNOWN holder={holder}", file=sys.stderr)
        return EXIT_UNKNOWN
    actual = slot_holder(state)
    slot = state.get("id") or ""
    if not slot:
        return EXIT_UNKNOWN
    if slot_available(state):
        already_available = "true"
    else:
        try:
            record = active_waiter_record(slot, holder)
        except QueryError:
            record = None
        if record is None:
            fail("cannot find active waiter for native slot release")
        try:
            native_holder = native_holder_token(holder, record)
        except QueryError:
            fail("cannot derive native holder token")
        if actual != native_holder:
            print(
                f"SLOT_FOREIGN expected={native_holder} actual={actual or 'unknown'}",
                file=sys.stderr,
            )
            return EXIT_FAILED
        validate_waiter_owner(slot, holder)
        if disposition == "retryable":
            release_waiter_record(
                slot, holder, "retryable", True, "merge-slot request remains retryable"
            )
        if bd_ok("merge-slot", "release", "--holder", native_holder):
            already_available = "false"
        else:
            print(f"SLOT_RELEASE_FAILED holder={holder}", file=sys.stderr)
            return EXIT_UNKNOWN
    if already_available == "true" or disposition == "terminal":
        release_waiter_record(slot, holder, disposition, False, "merge-slot request completed")
    if not quiet:
        print(
            f"SLOT_RELEASED holder={holder} already_available={already_available} "
            f"disposition={disposition}"
        )
    return 0


def run_with_slot(holder: str, command) -> int:
    """Acquire under stable identity, run `command`, then release by outcome.

    `command` returns either an exit code or `(exit_code, release_disposition)`.
    The override exists for a merge-queue enqueue: the work is finished from this
    repository's point of view even though the landing is not yet provable, so the
    waiter closes instead of holding the queue behind an unprovable landing.
    """
    acquire_rc = acquire_slot(
        holder,
        os.environ.get("SHEPHERD_SLOT_ATTEMPTS", "3"),
        os.environ.get("SHEPHERD_SLOT_INTERVAL", "1"),
        "armed",
        os.environ.get("SHEPHERD_WAITER_MODE", "resume"),
    )
    if acquire_rc != 0:
        return acquire_rc

    outcome = command()
    if isinstance(outcome, tuple):
        command_rc, override = outcome
    else:
        command_rc, override = outcome, None

    # EXIT_UNKNOWN IS RETRYABLE TOO. Only EXIT_WAITING was, so any indeterminate
    # outcome closed the waiter terminally -- and the holder token is a function of
    # head (pr-shepherd:{repo}#{pr}@{head}), so the next `land` at that same head hit
    # "terminal waiter ... requires explicit requeue" and exited 2. A transient gh
    # failure inside the slot, merge-probe exiting 2, or a queue ejection followed by
    # a CI re-run at the same head are all cases where the correct next action is to
    # try again, and the documented escape is unreachable in practice: SHEPHERD_WAITER_MODE
    # / requeue appears only in this script and one line of
    # references/landing-contract.md, never in SKILL.md or any caller. An operator who
    # cannot retry learns to pass requeue blindly, which defeats the guard entirely.
    #
    # A FAILED landing stays terminal. Only "we could not tell" is retryable.
    retryable = command_rc in (EXIT_WAITING, EXIT_UNKNOWN)
    disposition = override or ("retryable" if retryable else "terminal")
    release_rc = release_slot(holder, disposition)
    if release_rc == 0:
        disarm_slot_release()
    if command_rc != 0:
        return command_rc
    return release_rc


def external_command(argv: list[str]):
    def run() -> int:
        return subprocess.run(argv).returncode

    return run


def with_slot(holder: str, rest: list[str]) -> int:
    if not rest or rest[0] != "--":
        fail("with-slot requires -- before the command")
    command = rest[1:]
    if not command:
        fail("with-slot requires a command")
    return run_with_slot(holder, external_command(command))


# --------------------------------------------------------------------------
# live GitHub checks
# --------------------------------------------------------------------------

RUN_JQ = '[.headSha,.status,(.conclusion // "NONE"),(.url // "NONE")] | @tsv'

PR_READY_JQ = (
    '[.state,(.isDraft|tostring),(.mergeable // "UNKNOWN"),'
    '(if (.reviewDecision // "") == "" then "NONE" else .reviewDecision end),'
    '(.baseRefName // "NONE"),(.headRefOid // "NONE"),'
    '([.statusCheckRollup[]? | ((.conclusion // .state // .status // "") | ascii_upcase)] | '
    'if length == 0 then "NONE" '
    'elif all(. == "SUCCESS" or . == "NEUTRAL" or . == "SKIPPED") then "GREEN" '
    'elif any(. == "FAILURE" or . == "ERROR" or . == "CANCELLED" or . == "TIMED_OUT" or '
    '. == "ACTION_REQUIRED" or . == "STARTUP_FAILURE") then "RED" else "PENDING" end)] | @tsv'
)

LOCAL_GATE_RUN_JQ = (
    '[.headSha,(.status // "NONE" | ascii_upcase),'
    '(.conclusion // "NONE" | ascii_upcase),([.jobs[]?] | length),'
    '([.jobs[]?.steps[]?] | length),'
    '([.jobs[]? | {id: (.databaseId // 0), '
    'conclusion: ((.conclusion // "NONE") | ascii_upcase), '
    'steps: ([.steps[]?] | length)}] | tojson)] | @tsv'
)

PR_LANDED_JQ = (
    '[.state,(.mergedAt // "NONE"),(.mergeCommit.oid // "NONE"),(.baseRefName // "NONE"),'
    '(.headRefOid // "NONE"),(.url // "NONE")] | @tsv'
)

PR_MERGE_JQ = '[.state,(.headRefOid // "NONE"),(.mergeCommit.oid // "NONE")] | @tsv'


def check_run(repo: str, run_id: str, expected_head: str) -> int:
    require_sha(expected_head, "expected head")
    actual_head, status, conclusion, url = gh_tsv(
        ["run", "view", run_id, "--repo", repo,
         "--json", "headSha,status,conclusion,url", "--jq", RUN_JQ],
        f"cannot read run {run_id}",
        fields=4,
    )
    require_sha(actual_head, "run head")
    if actual_head != expected_head:
        print(
            f"RUN_STALE run={run_id} expected={expected_head} actual={actual_head} "
            f"url={url or 'unknown'}"
        )
        return EXIT_STALE
    if status != "completed":
        print(f"RUN_WAITING run={run_id} status={status} head={actual_head}")
        return EXIT_WAITING
    if conclusion == "success":
        print(f"RUN_READY run={run_id} head={actual_head}")
        return 0
    if conclusion in ("failure", "cancelled", "timed_out", "action_required", "startup_failure"):
        print(f"RUN_FAILED run={run_id} conclusion={conclusion} head={actual_head}")
        return EXIT_FAILED
    fail(f"run {run_id} has unknown conclusion {conclusion or 'empty'}")


PR_ANCHOR_JQ = '[(.headRefName // "NONE"),(.baseRefName // "NONE"),(.url // "NONE")] | @tsv'


def check_bead_anchors(merge_bead: str, repo: str, pr: str) -> int:
    """Verify the merge bead's own anchors describe the PR it names.

    A merge bead pointing at the wrong PR would otherwise be landed on the
    strength of its `metadata.pr` alone. Previously a PR-body `Merge-Bead:`
    trailer was supposed to catch that, but no code ever compared the two, so the
    check existed only as prose. The bead is authoritative here, per the carrier
    doctrine, so this reads the bead and the live PR and never the PR body.

    `repo` and `branch` are compared because both are stable for the life of the
    PR. `head_sha` deliberately is not: it advances on every push, so a mismatch
    means stale rather than wrong, and `land_owned` already rejects a stale head
    against the caller's expected head.

    Absent anchors return 0. A bead that predates the anchor convention is not
    evidence of a mismatch, and this is a guard against a wrong pointer, not a
    completeness check on metadata.
    """
    try:
        records = bd_json("show", merge_bead, "--json", quiet=True)
    except QueryError:
        print(f"ANCHOR_UNKNOWN merge={merge_bead} reason=bd-unavailable", file=sys.stderr)
        return EXIT_UNKNOWN
    record = records[0] if isinstance(records, list) and records else records
    if not isinstance(record, dict):
        print(f"ANCHOR_UNKNOWN merge={merge_bead} reason=no-record", file=sys.stderr)
        return EXIT_UNKNOWN
    raw_metadata = record.get("metadata")
    if raw_metadata is None:
        metadata = {}
    elif not isinstance(raw_metadata, dict):
        print(f"ANCHOR_UNKNOWN merge={merge_bead} reason=no-metadata", file=sys.stderr)
        return EXIT_UNKNOWN
    else:
        metadata = raw_metadata

    anchored_pr = metadata.get("pr")
    if anchored_pr is not None and str(anchored_pr) != str(pr):
        print(
            f"ANCHOR_MISMATCH merge={merge_bead} field=pr "
            f"anchored={anchored_pr} actual={pr}"
        )
        return EXIT_FAILED
    anchored_repo = metadata.get("repo")
    if anchored_repo is not None and anchored_repo != repo:
        print(
            f"ANCHOR_MISMATCH merge={merge_bead} field=repo "
            f"anchored={anchored_repo} actual={repo}"
        )
        return EXIT_FAILED

    anchored_branch = metadata.get("branch")
    if anchored_branch is None:
        print(f"ANCHOR_OK merge={merge_bead} pr={pr} branch=unanchored")
        return 0
    head_branch, base_branch, url = gh_tsv(
        ["pr", "view", pr, "--repo", repo, "--json", "headRefName,baseRefName,url",
         "--jq", PR_ANCHOR_JQ],
        f"cannot read PR {pr} anchors",
        fields=3,
    )
    if head_branch != anchored_branch:
        print(
            f"ANCHOR_MISMATCH merge={merge_bead} field=branch "
            f"anchored={anchored_branch} actual={head_branch or 'unknown'} "
            f"url={url or 'unknown'}"
        )
        return EXIT_FAILED
    print(f"ANCHOR_OK merge={merge_bead} pr={pr} branch={head_branch} base={base_branch}")
    return 0


def local_gate_run_evidence(repo: str, run_id: int, expected_head: str,
                            failure_class: str) -> dict:
    actual_head, status, conclusion, jobs, steps, job_evidence_json = gh_tsv(
        ["run", "view", str(run_id), "--repo", repo,
         "--json", "status,conclusion,headSha,jobs", "--jq", LOCAL_GATE_RUN_JQ],
        f"cannot read local gate run {run_id}",
        fields=6,
    )
    require_sha(actual_head, "local gate run head")
    if actual_head != expected_head:
        print(
            f"LOCAL_GATE_STALE run={run_id} expected_head={expected_head} "
            f"actual_head={actual_head}"
        )
        return {"result": EXIT_STALE}
    if status != "COMPLETED":
        print(f"LOCAL_GATE_WAITING run={run_id} status={status} head={actual_head}")
        return {"result": EXIT_WAITING}
    if not jobs.isdigit() or not steps.isdigit():
        fail(f"local gate run {run_id} has invalid job evidence")
    try:
        job_evidence = json.loads(job_evidence_json)
    except json.JSONDecodeError as error:
        raise Fail(f"local gate run {run_id} has invalid job evidence") from error
    if (
        not isinstance(job_evidence, list)
        or len(job_evidence) != int(jobs)
        or any(
            not isinstance(job, dict)
            or isinstance(job.get("id"), bool)
            or not isinstance(job.get("id"), int)
            or job["id"] < 1
            or not isinstance(job.get("conclusion"), str)
            or isinstance(job.get("steps"), bool)
            or not isinstance(job.get("steps"), int)
            or job["steps"] < 0
            for job in job_evidence
        )
        or sum(job["steps"] for job in job_evidence) != int(steps)
    ):
        fail(f"local gate run {run_id} has invalid job evidence")
    if int(steps) != 0:
        print(
            f"LOCAL_GATE_FAILED run={run_id} conclusion={conclusion} jobs={jobs} "
            f"steps={steps} class={failure_class}"
        )
        return {"result": EXIT_FAILED}
    if conclusion == "FAILURE" and failure_class == "github_billing_zero_steps":
        failed_jobs = [job for job in job_evidence if job["conclusion"] == "FAILURE"]
        if (
            not failed_jobs
            or any(job["conclusion"] not in ("FAILURE", "SKIPPED") for job in job_evidence)
            or any(not github_billing_failure(repo, job["id"]) for job in failed_jobs)
        ):
            print(
                f"LOCAL_GATE_FAILED run={run_id} conclusion={conclusion} jobs={jobs} "
                f"steps={steps} class={failure_class} billing_signal=absent"
            )
            return {"result": EXIT_FAILED}
    elif conclusion == "STARTUP_FAILURE" and failure_class == "github_startup_zero_steps":
        if any(
            job["conclusion"] not in ("FAILURE", "STARTUP_FAILURE", "SKIPPED")
            for job in job_evidence
        ):
            print(f"LOCAL_GATE_FAILED run={run_id} conclusion={conclusion} class={failure_class}")
            return {"result": EXIT_FAILED}
    elif conclusion in ("FAILURE", "STARTUP_FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"):
        print(f"LOCAL_GATE_FAILED run={run_id} conclusion={conclusion} class={failure_class}")
        return {"result": EXIT_FAILED}
    else:
        fail(f"local gate run {run_id} has unsupported conclusion {conclusion or 'empty'}")
    return {"result": 0, "head": actual_head, "jobs": jobs, "steps": steps}


def local_gate_receipt(repo: str, expected_head: str, operator: str,
                       receipt_path: str) -> dict:
    if not operator:
        fail("local gate operator authorization is required")
    if not receipt_path or not os.path.isfile(receipt_path):
        fail("local gate receipt must be an existing file")
    try:
        receipt_bytes = open(receipt_path, "rb").read()
        receipt = json.loads(receipt_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise Fail("local gate receipt is malformed or not authorized") from error
    evidence = receipt.get("evidence_ref") if isinstance(receipt, dict) else None
    run_id = receipt.get("run_id") if isinstance(receipt, dict) else None
    failure_class = receipt.get("failure_class") if isinstance(receipt, dict) else None
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema") != LOCAL_GATE_SCHEMA
        or receipt.get("head_sha") != expected_head
        or receipt.get("operator_authorized") is not True
        or receipt.get("authorization") != "operator-approved"
        or receipt.get("authorized_by") != operator
        or receipt.get("local_gate") != "passed"
        or not isinstance(evidence, str)
        or not evidence
        or "\t" in evidence
        or "\n" in evidence
        or isinstance(run_id, bool)
        or not isinstance(run_id, int)
        or run_id < 1
        or failure_class not in ("github_billing_zero_steps", "github_startup_zero_steps")
    ):
        fail("local gate receipt is malformed or not authorized")

    run = local_gate_run_evidence(repo, run_id, expected_head, failure_class)
    if run["result"] != 0:
        return {"result": run["result"]}
    receipt_sha = blob_digest(receipt_bytes)
    print(
        f"LOCAL_GATE_READY run={run_id} head={run['head']} operator={operator} "
        f"class={failure_class} evidence={evidence} jobs={run['jobs']} steps={run['steps']}"
    )
    return {
        "result": 0,
        "run_id": run_id,
        "failure_class": failure_class,
        "evidence_ref": evidence,
        "receipt_sha": receipt_sha,
    }


def github_billing_failure(repo: str, job_id: int) -> bool:
    annotation_jq = (
        '[.[] | select(.annotation_level == "failure" and .path == ".github" '
        'and .start_line == 1 and .end_line == 1 '
        f'and (.message | startswith({json.dumps(BILLING_ANNOTATION)})))] | length'
    )
    count = gh_value(
        ["api", f"repos/{repo}/check-runs/{job_id}/annotations?per_page=100", "--jq", annotation_jq],
        f"cannot read local gate job {job_id} annotations",
    )
    if not count.isdigit():
        fail(f"local gate job {job_id} annotations are malformed")
    return int(count) > 0


def local_gate_failure_binding(repo: str, pr: str, run_id: int,
                               expected_head: str, failure_class: str) -> int:
    binding_jq = (
        '[.statusCheckRollup[]? | '
        '{conclusion: ((.conclusion // .state // .status // "") | ascii_upcase), '
        'url: (.detailsUrl // .targetUrl // .url // "")} | '
        'select(.conclusion == "FAILURE" or .conclusion == "ERROR" or '
        '.conclusion == "CANCELLED" or .conclusion == "TIMED_OUT" or '
        '.conclusion == "ACTION_REQUIRED" or .conclusion == "STARTUP_FAILURE")] | '
        'tojson'
    )
    red_json = gh_value(
        ["pr", "view", pr, "--repo", repo, "--json", "statusCheckRollup",
         "--jq", binding_jq],
        f"cannot read PR {pr} local gate checks",
    )
    try:
        red_checks = json.loads(red_json)
    except json.JSONDecodeError as error:
        raise Fail(f"PR {pr} local gate checks are malformed") from error
    if not isinstance(red_checks, list) or any(
        not isinstance(check, dict)
        or not isinstance(check.get("conclusion"), str)
        or not isinstance(check.get("url"), str)
        for check in red_checks
    ):
        fail(f"PR {pr} local gate checks are malformed")
    allowed_conclusions = {"FAILURE"}
    if failure_class == "github_startup_zero_steps":
        allowed_conclusions.add("STARTUP_FAILURE")
    run_pattern = re.compile(r"/actions/runs/([1-9][0-9]*)(?:$|[^0-9])")
    bound_count = 0
    disallowed_count = 0
    for check in red_checks:
        match = run_pattern.search(check["url"])
        if check["conclusion"] not in allowed_conclusions or match is None:
            disallowed_count += 1
            continue
        check_run_id = int(match.group(1))
        if check_run_id == run_id:
            bound_count += 1
            continue
        try:
            extra = local_gate_run_evidence(repo, check_run_id, expected_head, failure_class)
        except Fail:
            extra = {"result": EXIT_FAILED}
        if extra["result"] != 0:
            disallowed_count += 1
    red_count = len(red_checks)
    if red_count == 0 or bound_count == 0 or disallowed_count != 0:
        print(
            f"LOCAL_GATE_FAILED pr={pr} run={run_id} red_checks={red_count} "
            f"bound_checks={bound_count} disallowed_checks={disallowed_count}"
        )
        return EXIT_FAILED
    return 0


def check_pr(repo: str, pr: str, expected_head: str, expected_base: str,
             approval_mode: str = "github", local_operator: str = "",
             local_receipt: str = "", validated_receipt: dict | None = None) -> int:
    require_sha(expected_head, "expected head")
    receipt = None
    if approval_mode in ("github", "external"):
        if local_operator or local_receipt:
            fail(f"{approval_mode} approval does not accept local gate evidence")
    elif approval_mode == "local":
        receipt = local_gate_receipt(repo, expected_head, local_operator, local_receipt)
        if validated_receipt is not None:
            validated_receipt.update(receipt)
        if receipt["result"] != 0:
            return receipt["result"]
    else:
        fail("approval mode must be github, external, or local")
    state, draft, mergeable, review, base, head, checks = gh_tsv(
        ["pr", "view", pr, "--repo", repo,
         "--json",
         "state,isDraft,mergeable,reviewDecision,baseRefName,headRefOid,statusCheckRollup",
         "--jq", PR_READY_JQ],
        f"cannot read PR {pr}",
        fields=7,
    )
    if head != expected_head or base != expected_base:
        print(
            f"PR_STALE pr={pr} expected_head={expected_head} actual_head={head or 'unknown'} "
            f"expected_base={expected_base} actual_base={base or 'unknown'}"
        )
        return EXIT_STALE
    if approval_mode == "local":
        binding_rc = local_gate_failure_binding(
            repo, pr, receipt["run_id"], expected_head, receipt["failure_class"]
        )
        if binding_rc != 0:
            return binding_rc
    if state != "OPEN":
        print(f"PR_NOT_OPEN pr={pr} state={state or 'unknown'}")
        return EXIT_FAILED
    if (
        mergeable == "CONFLICTING"
        or review == "CHANGES_REQUESTED"
        or (checks == "RED" and approval_mode != "local")
    ):
        print(f"PR_FAILED pr={pr} mergeable={mergeable} review={review} checks={checks}")
        return EXIT_FAILED
    if draft == "true" or checks == "PENDING" or (
        approval_mode == "github" and review != "APPROVED"
    ):
        print(
            f"PR_WAITING pr={pr} draft={draft} review={review or 'empty'} "
            f"approval={approval_mode} checks={checks}"
        )
        return EXIT_WAITING
    if mergeable != "MERGEABLE" or (
        checks not in ("GREEN", "NONE")
        and not (approval_mode == "local" and checks == "RED")
    ):
        fail(
            f"PR {pr} readiness is unknown (mergeable={mergeable or 'empty'}, "
            f"checks={checks or 'empty'})"
        )
    print(f"PR_READY pr={pr} head={head} base={base} approval={approval_mode} checks={checks}")
    return 0


def verify_landed(repo: str, pr: str, landing_base: str, recorded_base: str,
                  expected_head: str, expected_merge: str) -> int:
    require_sha(recorded_base, "recorded base")
    require_sha(expected_head, "expected head")
    require_sha(expected_merge, "expected merge")
    state, merged_at, actual_merge, pr_base, actual_head, _url = gh_tsv(
        ["pr", "view", pr, "--repo", repo,
         "--json", "state,mergedAt,mergeCommit,baseRefName,headRefOid,url",
         "--jq", PR_LANDED_JQ],
        f"cannot read merged PR {pr}",
        fields=6,
    )
    if state != "MERGED" or merged_at == "NONE":
        print(f"NOT_LANDED pr={pr} state={state or 'unknown'} merged_at={merged_at or 'empty'}")
        return EXIT_WAITING
    if actual_head != expected_head or actual_merge != expected_merge:
        print(
            f"LANDING_STALE pr={pr} expected_head={expected_head} "
            f"actual_head={actual_head or 'unknown'} expected_merge={expected_merge} "
            f"actual_merge={actual_merge or 'unknown'}"
        )
        return EXIT_STALE

    remote_base = gh_value(
        ["api", f"repos/{repo}/git/ref/heads/{landing_base}", "--jq", ".object.sha"],
        f"cannot read remote base {landing_base}",
    )
    require_sha(remote_base, "remote base")
    compare_status = gh_value(
        ["api", f"repos/{repo}/compare/{expected_merge}...{remote_base}", "--jq", ".status"],
        f"cannot compare merge commit with {landing_base}",
    )
    if compare_status in ("ahead", "identical"):
        print(
            f"LANDED_COMMIT pr={pr} merge={expected_merge} base={landing_base} "
            f"base_sha={remote_base}"
        )
        return 0
    if compare_status not in ("diverged", "behind"):
        fail(f"unknown compare state {compare_status}")

    if git(
        "fetch", "--quiet", "--no-tags", "origin",
        f"refs/heads/{landing_base}:refs/remotes/origin/{landing_base}",
        f"refs/pull/{pr}/head",
    ).returncode != 0:
        fail("cannot fetch landing proof refs")
    resolved = git("rev-parse", "--verify", f"refs/remotes/origin/{landing_base}^{{commit}}")
    if resolved.returncode != 0:
        fail("cannot resolve fetched base")
    if resolved.stdout.strip() != remote_base:
        fail("fetched base does not match GitHub ref")
    if git("cat-file", "-e", f"{recorded_base}^{{commit}}", quiet=True).returncode != 0:
        fail("recorded base object is unavailable")
    if git("cat-file", "-e", f"{expected_head}^{{commit}}", quiet=True).returncode != 0:
        fail("expected head object is unavailable")

    # Raw NUL-separated paths: a path may legitimately contain a newline, and
    # decoding it would corrupt the content proof.
    diff = git_bytes("diff", "--name-only", "-z", recorded_base, expected_head)
    if diff.returncode != 0:
        fail("cannot enumerate PR content")
    paths = [p for p in diff.stdout.split(b"\0") if p]
    for raw in paths:
        path = os.fsdecode(raw)
        expected_entry = git("ls-tree", expected_head, "--", path)
        if expected_entry.returncode != 0:
            fail(f"cannot inspect head path {path}")
        actual_entry = git("ls-tree", remote_base, "--", path)
        if actual_entry.returncode != 0:
            fail(f"cannot inspect base path {path}")
        if expected_entry.stdout != actual_entry.stdout:
            print(f"NOT_LANDED_CONTENT pr={pr} path={shlex.quote(path)} base={landing_base}")
            return EXIT_WAITING
    if not paths:
        fail("content proof has no changed paths")
    print(
        f"LANDED_CONTENT pr={pr} merge={expected_merge} pr_base={pr_base} "
        f"landing_base={landing_base} base_sha={remote_base} paths={len(paths)}"
    )
    return 0


# --------------------------------------------------------------------------
# GitHub merge queue
# --------------------------------------------------------------------------

QUEUE_QUERY = (
    "query($owner:String!,$name:String!,$pr:Int!){"
    "repository(owner:$owner,name:$name){pullRequest(number:$pr){"
    "isMergeQueueEnabled isInMergeQueue "
    "mergeQueueEntry{state position headCommit{oid}}}}}"
)

_queue_cache: dict[tuple[str, str], dict | None] = {}


def queue_state(repo: str, pr: str) -> dict | None:
    """Merge-queue facts for a PR's base branch, or None when undetectable.

    Detection uses GraphQL because REST branch protection carries no merge-queue
    field at all: `repos/{owner}/{repo}/branches/{branch}/protection` has no such
    property in the published schema, so a REST probe cannot answer the question.

    None means the probe failed. Callers treat that as non-queue and say so
    explicitly; they never infer a landing from it.
    """
    key = (repo, str(pr))
    if key in _queue_cache:
        return _queue_cache[key]
    owner, _, name = repo.partition("/")
    result = None
    if owner and name and re.fullmatch(r"[0-9]+", str(pr)):
        probe = _run([
            "gh", "api", "graphql",
            "-f", f"query={QUEUE_QUERY}",
            "-F", f"owner={owner}", "-F", f"name={name}", "-F", f"pr={pr}",
        ])
        if probe.returncode == 0:
            try:
                payload = json.loads(probe.stdout)
                node = payload["data"]["repository"]["pullRequest"]
                entry = node.get("mergeQueueEntry") or {}
                result = {
                    "enabled": node.get("isMergeQueueEnabled") is True,
                    "in_queue": node.get("isInMergeQueue") is True,
                    "entry_state": entry.get("state") or "NONE",
                    "entry_position": entry.get("position"),
                    "entry_head": (entry.get("headCommit") or {}).get("oid") or "NONE",
                }
            except (ValueError, KeyError, TypeError, AttributeError):
                result = None
    _queue_cache[key] = result
    return result


def queue_state_reported(repo: str, pr: str, context: str) -> dict | None:
    state = queue_state(repo, pr)
    if state is None:
        print(
            f"QUEUE_DETECT_FAILED pr={pr} context={context} treated=non-queue",
            file=sys.stderr,
        )
    return state


def record_queue_receipt(merge_bead: str, pr: str, pr_base: str, landing_base: str,
                         head_sha: str, queue: dict) -> None:
    if not bd_ok(
        "update", merge_bead,
        "--set-metadata", f"head_sha={head_sha}",
        "--set-metadata", f"pr_base={pr_base}",
        "--set-metadata", f"landing_base={landing_base}",
        "--set-metadata", f"queue_entry_head={queue['entry_head']}",
        "--set-metadata", f"landing_state={STATE_QUEUED}",
    ):
        fail("cannot persist merge-queue enqueue receipt")
    if not bd_ok(
        "comment", merge_bead,
        f"ENQUEUED pr={pr} pr_base={pr_base} landing_base={landing_base} "
        f"head_sha={head_sha} entry_state={queue['entry_state']} "
        f"entry_head={queue['entry_head']}",
    ):
        fail("cannot record merge-queue enqueue receipt")


def record_queue_ejection(merge_bead: str, pr: str, landing_base: str, head_sha: str,
                          pr_state: str, queue: dict | None) -> None:
    entry_state = queue["entry_state"] if queue else "UNKNOWN"
    if not bd_ok(
        "update", merge_bead,
        "--set-metadata", f"landing_state={STATE_EJECTED}",
        "--set-metadata", f"queue_ejected_head={head_sha}",
    ):
        fail("cannot persist merge-queue ejection receipt")
    if not bd_ok(
        "comment", merge_bead,
        f"QUEUE_EJECTED pr={pr} landing_base={landing_base} head_sha={head_sha} "
        f"pr_state={pr_state} entry=absent entry_state={entry_state} prior_state={STATE_QUEUED}",
    ):
        fail("cannot record merge-queue ejection receipt")


# --------------------------------------------------------------------------
# landing transaction
# --------------------------------------------------------------------------


def landing_receipt(merge_bead: str) -> dict:
    try:
        record = bd_json("show", merge_bead, "--json")
    except QueryError:
        fail("cannot inspect landing receipt")
    if not isinstance(record, list) or not record:
        fail("cannot inspect landing receipt")
    metadata = record[0].get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def stamp_landing_proof(merge_bead: str, pr: str, head_sha: str, merge_sha: str) -> None:
    if not bd_ok(
        "update", merge_bead,
        "--set-metadata", f"head_sha={head_sha}",
        "--set-metadata", f"merge_sha={merge_sha}",
        "--set-metadata", "landing_state=proved",
    ):
        fail("cannot stamp landing metadata")
    if not bd_ok(
        "comment", merge_bead,
        f"LANDED pr={pr} head_sha={head_sha} merge_sha={merge_sha} proof=base",
    ):
        fail("cannot record landing proof")


def record_merge_receipt(merge_bead: str, pr: str, pr_base: str, landing_base: str,
                         head_sha: str, merge_sha: str) -> None:
    if not bd_ok(
        "update", merge_bead,
        "--set-metadata", f"head_sha={head_sha}",
        "--set-metadata", f"merge_sha={merge_sha}",
        "--set-metadata", f"pr_base={pr_base}",
        "--set-metadata", f"landing_base={landing_base}",
        "--set-metadata", "landing_state=merged",
    ):
        fail("cannot persist remote merge receipt")
    if not bd_ok(
        "comment", merge_bead,
        f"MERGED pr={pr} pr_base={pr_base} landing_base={landing_base} "
        f"head_sha={head_sha} merge_sha={merge_sha}",
    ):
        fail("cannot record remote merge receipt")


def record_local_gate_admission(merge_bead: str, pr: str, expected_head: str,
                                operator: str, receipt_path: str,
                                validated_receipt: dict) -> None:
    if validated_receipt.get("result") != 0:
        fail("local gate receipt was not validated before landing record")
    try:
        with open(receipt_path, "rb") as receipt_file:
            current_bytes = receipt_file.read()
        current = json.loads(current_bytes)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise Fail("local gate receipt changed before landing record") from error
    current_sha = blob_digest(current_bytes)
    if (
        current_sha != validated_receipt.get("receipt_sha")
        or not isinstance(current, dict)
        or current.get("run_id") != validated_receipt.get("run_id")
        or current.get("head_sha") != expected_head
    ):
        fail("local gate receipt changed before landing record")
    receipt = validated_receipt
    if not bd_ok(
        "update", merge_bead,
        "--set-metadata", "local_gate_mode=local",
        "--set-metadata", f"local_gate_operator={operator}",
        "--set-metadata", f"local_gate_head_sha={expected_head}",
        "--set-metadata", f"local_gate_run_id={receipt['run_id']}",
        "--set-metadata", f"local_gate_failure_class={receipt['failure_class']}",
        "--set-metadata", f"local_gate_evidence={receipt['evidence_ref']}",
        "--set-metadata", f"local_gate_receipt_sha={receipt['receipt_sha']}",
    ):
        fail("cannot persist local gate admission")
    if not bd_ok(
        "comment", merge_bead,
        f"LOCAL_GATE pr={pr} head_sha={expected_head} operator={operator} "
        f"run={receipt['run_id']} class={receipt['failure_class']} "
        f"evidence={receipt['evidence_ref']} receipt_sha={receipt['receipt_sha']}",
    ):
        fail("cannot record local gate admission")


def hold_for_landing_base(merge_bead: str, pr: str, pr_base: str, landing_base: str,
                          merge_sha: str) -> None:
    if not bd_ok("update", merge_bead, "--set-metadata", "landing_state=waiting_base"):
        fail("cannot persist stacked landing hold")
    if not bd_ok(
        "comment", merge_bead,
        f"LANDING_HOLD pr={pr} pr_base={pr_base} landing_base={landing_base} "
        f"merge_sha={merge_sha}",
    ):
        fail("cannot record stacked landing hold")
    print(
        f"LANDING_HOLD merge={merge_bead} pr={pr} pr_base={pr_base} "
        f"landing_base={landing_base} merge_sha={merge_sha}"
    )


def prove_remote_merge(merge_bead: str, repo: str, pr: str, pr_base: str, landing_base: str,
                       recorded_base: str, expected_head: str, merge_sha: str,
                       marker: str) -> int:
    """Persist the merge receipt, then prove the change reached landing_base."""
    require_sha(merge_sha, "merge commit")
    record_merge_receipt(merge_bead, pr, pr_base, landing_base, expected_head, merge_sha)
    verify_rc = verify_landed(repo, pr, landing_base, recorded_base, expected_head, merge_sha)
    if verify_rc == EXIT_WAITING and pr_base != landing_base:
        hold_for_landing_base(merge_bead, pr, pr_base, landing_base, merge_sha)
        return EXIT_WAITING
    if verify_rc != 0:
        return verify_rc
    stamp_landing_proof(merge_bead, pr, expected_head, merge_sha)
    print(f"{marker} merge={merge_bead} pr={pr} merge_sha={merge_sha}")
    return 0


def land_owned(merge_bead: str, repo: str, pr: str, pr_base: str, landing_base: str,
               recorded_base: str, expected_head: str, method: str, approval_mode: str,
               local_operator: str = "", local_receipt: str = ""):
    require_sha(recorded_base, "recorded base")
    require_sha(expected_head, "expected head")
    if method not in ("merge", "rebase", "squash"):
        fail("merge method must be merge, rebase, or squash")

    # Before anything reads the PR as this bead's PR, prove that it is.
    anchors = check_bead_anchors(merge_bead, repo, pr)
    if anchors != 0:
        return anchors

    state, actual_head, merge_sha = gh_tsv(
        ["pr", "view", pr, "--repo", repo, "--json", "state,headRefOid,mergeCommit",
         "--jq", PR_MERGE_JQ],
        f"cannot read PR {pr} before landing",
        fields=3,
    )
    if actual_head != expected_head:
        print(
            f"PR_STALE pr={pr} expected_head={expected_head} "
            f"actual_head={actual_head or 'unknown'}"
        )
        return EXIT_STALE

    if state == "MERGED":
        return prove_remote_merge(
            merge_bead, repo, pr, pr_base, landing_base, recorded_base, expected_head,
            merge_sha, "LANDING_RECOVERY_PROVED",
        )

    validated_local_receipt = {} if approval_mode == "local" else None
    readiness = check_pr(
        repo, pr, expected_head, pr_base, approval_mode, local_operator, local_receipt,
        validated_local_receipt,
    )
    if readiness != 0:
        return readiness
    if approval_mode == "local":
        record_local_gate_admission(
            merge_bead, pr, expected_head, local_operator, local_receipt,
            validated_local_receipt,
        )
    if git(
        "fetch", "--quiet", "--no-tags", "origin",
        f"refs/heads/{pr_base}:refs/remotes/origin/{pr_base}",
        f"refs/pull/{pr}/head",
    ).returncode != 0:
        fail("cannot fetch landing transaction refs")
    probe = _run(
        [os.path.join(SCRIPT_DIR, "merge-probe.sh"), "conflicts",
         f"refs/remotes/origin/{pr_base}", expected_head],
        merge_stderr=True,
    )
    probe_output = probe.stdout.rstrip("\n")
    if probe.returncode == 1:
        print(f"LANDING_CONFLICT pr={pr} paths={probe_output}")
        return EXIT_FAILED
    if probe.returncode != 0:
        print(f"LANDING_UNKNOWN pr={pr} probe={probe_output}", file=sys.stderr)
        return EXIT_UNKNOWN

    merged = subprocess.run(
        ["gh", "pr", "merge", pr, "--repo", repo, f"--{method}",
         "--match-head-commit", expected_head]
    )
    if merged.returncode != 0:
        print(f"LANDING_MERGE_FAILED pr={pr}", file=sys.stderr)
        return EXIT_FAILED

    state, actual_head, merge_sha = gh_tsv(
        ["pr", "view", pr, "--repo", repo, "--json", "state,headRefOid,mergeCommit",
         "--jq", PR_MERGE_JQ],
        f"cannot read PR {pr} after merge",
        fields=3,
    )
    if state == "MERGED" and actual_head == expected_head:
        return prove_remote_merge(
            merge_bead, repo, pr, pr_base, landing_base, recorded_base, expected_head,
            merge_sha, "LANDING_PROVED",
        )

    # A successful merge that left the PR open is the merge-queue signature: the
    # call enqueued rather than merged. Detection happens only here, so a
    # non-queue landing pays no extra API call.
    if actual_head == expected_head:
        queue = queue_state_reported(repo, pr, "post-merge")
        if queue and queue["in_queue"]:
            record_queue_receipt(merge_bead, pr, pr_base, landing_base, expected_head, queue)
            print(
                f"LANDING_ENQUEUED merge={merge_bead} pr={pr} pr_base={pr_base} "
                f"landing_base={landing_base} head_sha={expected_head} "
                f"entry_state={queue['entry_state']} entry_position={queue['entry_position']} "
                f"entry_head={queue['entry_head']} landing_state={STATE_QUEUED}"
            )
            # Terminal for the beads slot: GitHub now serializes this landing, so
            # holding the local queue behind it would only block other pull requests.
            return EXIT_WAITING, "terminal"
    fail("PR identity changed after merge")


def resume_queued_landing(merge_bead: str, repo: str, pr: str, pr_base: str, landing_base: str,
                          recorded_base: str, expected_head: str) -> int:
    """Advance a pull request already enqueued in the GitHub merge queue.

    Runs outside the beads merge slot: it never calls `gh pr merge`, so there is
    nothing to serialize, and holding the slot would block unrelated landings.
    """
    require_sha(recorded_base, "recorded base")
    require_sha(expected_head, "expected head")
    state, actual_head, merge_sha = gh_tsv(
        ["pr", "view", pr, "--repo", repo, "--json", "state,headRefOid,mergeCommit",
         "--jq", PR_MERGE_JQ],
        f"cannot read queued PR {pr}",
        fields=3,
    )
    if actual_head != expected_head:
        print(
            f"PR_STALE pr={pr} expected_head={expected_head} "
            f"actual_head={actual_head or 'unknown'}"
        )
        return EXIT_STALE
    if state == "MERGED":
        return prove_remote_merge(
            merge_bead, repo, pr, pr_base, landing_base, recorded_base, expected_head,
            merge_sha, "LANDING_QUEUE_PROVED",
        )

    queue = queue_state_reported(repo, pr, "queued-resume")
    if queue is None:
        print(
            f"LANDING_QUEUE_UNKNOWN merge={merge_bead} pr={pr} head_sha={expected_head} "
            f"landing_base={landing_base} pr_state={state or 'unknown'}",
            file=sys.stderr,
        )
        return EXIT_UNKNOWN
    if queue["in_queue"]:
        print(
            f"LANDING_QUEUED merge={merge_bead} pr={pr} landing_base={landing_base} "
            f"head_sha={expected_head} entry_state={queue['entry_state']} "
            f"entry_position={queue['entry_position']} landing_state={STATE_QUEUED}"
        )
        return EXIT_WAITING

    # Enqueued, gone from the queue, and the pull request is not merged: the merge
    # group failed and GitHub ejected it. Never a success.
    record_queue_ejection(merge_bead, pr, landing_base, expected_head, state or "unknown", queue)
    print(
        f"LANDING_QUEUE_EJECTED merge={merge_bead} pr={pr} landing_base={landing_base} "
        f"head_sha={expected_head} pr_state={state or 'unknown'} queue=github entry=absent "
        f"entry_state={queue['entry_state']} prior_state={STATE_QUEUED} "
        f"landing_state={STATE_EJECTED}"
    )
    return EXIT_FAILED


def land_pr(merge_bead: str, repo: str, pr: str, pr_base: str, landing_base: str,
            recorded_base: str, expected_head: str, method: str,
            approval_mode: str = "github", local_operator: str = "",
            local_receipt: str = "") -> int:
    receipt = landing_receipt(merge_bead)
    if receipt.get("landing_state") == STATE_QUEUED:
        landing_rc = resume_queued_landing(
            merge_bead, repo, pr, pr_base, landing_base, recorded_base, expected_head
        )
    else:
        holder = f"pr-shepherd:{repo}#{pr}@{expected_head}"
        landing_rc = run_with_slot(
            holder,
            lambda: land_owned(
                merge_bead, repo, pr, pr_base, landing_base, recorded_base,
                expected_head, method, approval_mode, local_operator, local_receipt,
            ),
        )
    if landing_rc != 0:
        return landing_rc
    if not bd_ok(
        "close", merge_bead, "--reason",
        f"PR #{pr} landed on {landing_base} with exact proof",
    ):
        fail("cannot close landed merge bead")
    print(f"LANDING_COMPLETE merge={merge_bead} pr={pr} base={landing_base}")
    return 0


# --------------------------------------------------------------------------
# bounce receipts
# --------------------------------------------------------------------------

FAILURE_KINDS = ("ci", "conflict", "review", "queue")


def failure_key(repo: str, kind: str, details: list[str]) -> str:
    if not details:
        fail("failure-key requires failure details")
    if kind not in FAILURE_KINDS:
        fail("failure kind must be ci, conflict, review, or queue")
    return blob_digest(nul_payload(repo, kind, *details))


def find_fixes(key: str) -> list[str]:
    try:
        records = bd_json(
            "list", "--label-any", "agent:coder,agent:reviewer",
            "--status", "open,in_progress,blocked,deferred",
            "--metadata-field", f"failure_key={key}", "--json",
        )
    except QueryError as error:
        raise QueryError("cannot query fix beads") from error
    if not isinstance(records, list):
        raise QueryError("fix bead query did not emit a list")
    ordered = sorted(records, key=lambda r: (r.get("created_at") or "", r.get("id") or ""))
    return [r["id"] for r in ordered if r.get("id")]


def find_fix(key: str) -> str:
    fixes = find_fixes(key)
    return fixes[0] if fixes else ""


def reconcile_fix_duplicates(key: str, canonical: str) -> None:
    for duplicate in find_fixes(key):
        if not duplicate or duplicate == canonical:
            continue
        if not bd_ok(
            "close", duplicate, "--reason", f"Duplicate of {canonical} for failure_key={key}"
        ):
            fail(f"cannot close duplicate fix bead {duplicate}")


def comment_marker_present(issue: str, marker: str) -> bool:
    comments = bd_json("comments", issue, "--json")
    if not isinstance(comments, list):
        raise QueryError("comment query did not emit a list")
    return any(marker in (c.get("text") or "") for c in comments if isinstance(c, dict))


def comment_once(issue: str, marker: str, message: str) -> None:
    try:
        if comment_marker_present(issue, marker):
            return
    except QueryError:
        fail(f"cannot query comment receipt on {issue}")
    if not bd_ok("comment", issue, message):
        fail(f"cannot write comment receipt on {issue}")


def dependency_present(merge_bead: str, fix_bead: str) -> bool:
    record = bd_json("show", merge_bead, "--json")
    if not isinstance(record, list) or not record:
        raise QueryError("dependency query did not emit a record")
    dependencies = record[0].get("dependencies") or []
    if not isinstance(dependencies, list):
        raise QueryError("dependencies are malformed")
    return any(
        (d.get("id") or d.get("depends_on_id")) == fix_bead
        for d in dependencies
        if isinstance(d, dict)
    )


BOUNCE_PHASES = ("", "preparing", "fix_ready", "parked", "commented", "complete")


def bounce_phase_rank(phase: str) -> int:
    if phase not in BOUNCE_PHASES:
        fail(f"unknown bounce receipt phase {phase}")
    return BOUNCE_PHASES.index(phase)


def advance_bounce_receipt(merge_bead: str, key: str, fix_bead: str, phase: str) -> None:
    if not bd_ok(
        "update", merge_bead,
        "--set-metadata", f"bounce_key={key}",
        "--set-metadata", f"bounce_fix={fix_bead}",
        "--set-metadata", f"bounce_phase={phase}",
    ):
        fail(f"cannot persist bounce receipt phase {phase}")


def ensure_bounce(merge_bead: str, key: str, route: str, title: str, metadata: str,
                  description: str) -> int:
    if route not in ("agent:coder", "agent:reviewer"):
        fail("bounce route must be agent:coder or agent:reviewer")
    try:
        parsed = json.loads(metadata)
    except ValueError:
        parsed = None
    if not isinstance(parsed, dict):
        fail("invalid bounce metadata")
    metadata_with_key = json.dumps({**parsed, "failure_key": key}, separators=(",", ":"))

    receipt = landing_receipt_or_fail(merge_bead)
    if (receipt.get("bounce_key") or "") == key:
        receipt_fix = receipt.get("bounce_fix") or ""
        phase = receipt.get("bounce_phase") or ""
    else:
        receipt_fix, phase = "", ""
    phase_rank = bounce_phase_rank(phase)
    try:
        fix_bead = find_fix(key)
    except QueryError:
        fail("cannot query bounce duplicates")
    if phase_rank == 5 and not fix_bead:
        receipt_fix = ""
        phase_rank = 0
    if phase_rank == 0:
        advance_bounce_receipt(merge_bead, key, "", "preparing")
        phase_rank = 1

    if not fix_bead:
        if not bd_ok(
            "create", title, "--deps", f"discovered-from:{merge_bead}",
            "--labels", route, "--metadata", metadata_with_key,
            "--description", description, "--silent",
        ):
            fail("cannot create fix bead")
        try:
            canonical = find_fix(key)
        except QueryError:
            fail("cannot reconcile bounce creation")
        if not canonical:
            fail("created fix bead is not queryable")
        fix_bead = canonical

    if receipt_fix and receipt_fix != fix_bead:
        fail(f"bounce receipt fix changed (expected {receipt_fix}, found {fix_bead})")
    if phase_rank < 2:
        advance_bounce_receipt(merge_bead, key, fix_bead, "fix_ready")
        phase_rank = 2

    try:
        present = dependency_present(merge_bead, fix_bead)
    except QueryError:
        fail("cannot query bounce dependency receipt")
    if not present:
        if not bd_ok("dep", "add", merge_bead, fix_bead):
            fail("cannot park merge bead")
    try:
        reconcile_fix_duplicates(key, fix_bead)
    except QueryError:
        fail("cannot query bounce duplicates")
    if phase_rank < 3:
        advance_bounce_receipt(merge_bead, key, fix_bead, "parked")
        phase_rank = 3
    if phase_rank < 4:
        marker = f"bounce_receipt={key}"
        comment_once(
            merge_bead, marker,
            f"BOUNCED {marker} failure_key={key} fix={fix_bead} route={route}",
        )
        comment_once(fix_bead, marker, f"CORRELATED {marker} merge={merge_bead} failure_key={key}")
        advance_bounce_receipt(merge_bead, key, fix_bead, "commented")
        phase_rank = 4
    if not bd_ok("update", merge_bead, "--assignee", "", "--status", "open"):
        fail("cannot release merge bead claim")
    if phase_rank < 5:
        advance_bounce_receipt(merge_bead, key, fix_bead, "complete")
        print(f"BOUNCE_PARKED merge={merge_bead} fix={fix_bead} key={key}")
    else:
        print(f"BOUNCE_REUSED merge={merge_bead} fix={fix_bead} key={key}")
    return 0


def landing_receipt_or_fail(merge_bead: str) -> dict:
    try:
        record = bd_json("show", merge_bead, "--json")
    except QueryError:
        fail("cannot inspect bounce receipt")
    if not isinstance(record, list) or not record:
        fail("cannot inspect bounce receipt")
    metadata = record[0].get("metadata")
    return metadata if isinstance(metadata, dict) else {}


# --------------------------------------------------------------------------
# recovery receipts
# --------------------------------------------------------------------------

RECOVERY_PHASES = ("prepared", "mutated", "commented", "audited", "complete")


def recovery_key(kind: str, subject: str, evidence: str) -> str:
    return blob_digest(nul_payload(kind, subject, evidence))


def recovery_phase_rank(phase: str) -> int:
    """Rank a recovery phase. An unknown phase aborts rather than defaulting.

    In the shell this guard was written `[[ "$(recovery_phase_rank …)" -lt 2 ]]`,
    where the command substitution discarded the callee's abort and
    `[[ "" -lt 2 ]]` took the mutating branch. Raising here cannot be discarded.
    """
    if phase not in RECOVERY_PHASES:
        fail(f"unknown recovery receipt phase {phase or 'empty'}")
    return RECOVERY_PHASES.index(phase) + 1


def advance_recovery_receipt(merge_bead: str, key: str, kind: str, subject: str, evidence: str,
                             phase: str) -> None:
    if not bd_ok(
        "update", merge_bead,
        "--set-metadata", f"recovery_key={key}",
        "--set-metadata", f"recovery_kind={kind}",
        "--set-metadata", f"recovery_subject={subject}",
        "--set-metadata", f"recovery_evidence={evidence}",
        "--set-metadata", f"recovery_phase={phase}",
    ):
        fail(f"cannot persist recovery receipt phase {phase}")


def recovery_receipt(merge_bead: str) -> tuple[str, str]:
    try:
        record = bd_json("show", merge_bead, "--json")
    except QueryError:
        fail("cannot inspect recovery receipt")
    if not isinstance(record, list) or not record:
        fail("cannot inspect recovery receipt")
    metadata = record[0].get("metadata") or {}
    return metadata.get("recovery_key") or "", metadata.get("recovery_phase") or ""


def prepare_recovery(merge_bead: str, key: str, kind: str, subject: str,
                     evidence: str) -> tuple[str, bool]:
    current_key, phase = recovery_receipt(merge_bead)
    if current_key == key and phase:
        recovery_phase_rank(phase)
        return phase, False
    if current_key and phase != "complete":
        fail("another recovery receipt is incomplete")
    advance_recovery_receipt(merge_bead, key, kind, subject, evidence, "prepared")
    return "prepared", True


def recovery_audit_present(merge_bead: str, tool_name: str) -> bool | None:
    """True/False when the audit log is readable, None when it does not exist yet."""
    try:
        where = bd_json("where", "--json")
    except QueryError as error:
        raise QueryError("cannot resolve beads path") from error
    path = where.get("path") if isinstance(where, dict) else None
    if not isinstance(path, str) or not path:
        raise QueryError("beads path is invalid")
    audit_file = os.path.join(path, "interactions.jsonl")
    if not os.path.isfile(audit_file):
        return None
    try:
        with open(audit_file, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                event = json.loads(line)
                if (
                    event.get("kind") == "tool_call"
                    and event.get("issue_id") == merge_bead
                    and event.get("tool_name") == tool_name
                ):
                    return True
    except (OSError, ValueError) as error:
        raise QueryError("cannot read the beads audit log") from error
    return False


def finish_recovery(merge_bead: str, key: str, kind: str, subject: str, evidence: str,
                    phase: str) -> None:
    phase_rank = recovery_phase_rank(phase)
    if phase_rank < 2:
        advance_recovery_receipt(merge_bead, key, kind, subject, evidence, "mutated")
        phase_rank = 2
    marker = f"recovery_receipt={key}"
    if phase_rank < 3:
        comment_once(
            merge_bead, marker,
            f"RECOVERED {marker} kind={kind} subject={subject} evidence={evidence}",
        )
        advance_recovery_receipt(merge_bead, key, kind, subject, evidence, "commented")
        phase_rank = 3
    tool_name = f"pr-shepherd.recover-{kind}.{key}"
    if phase_rank < 4:
        try:
            present = recovery_audit_present(merge_bead, tool_name)
        except QueryError:
            fail("cannot query recovery audit receipt")
        if not present:
            if not bd_ok(
                "audit", "record", "--kind", "tool_call", "--tool-name", tool_name,
                "--issue-id", merge_bead,
            ):
                fail("cannot audit recovery receipt")
        advance_recovery_receipt(merge_bead, key, kind, subject, evidence, "audited")
        phase_rank = 4
    if phase_rank < 5:
        advance_recovery_receipt(merge_bead, key, kind, subject, evidence, "complete")


def recover_slot(merge_bead: str, dead_holder: str, evidence: str) -> int:
    if not evidence:
        fail("dead-holder recovery requires an evidence reference")
    key = recovery_key("slot", dead_holder, evidence)
    phase, is_new = prepare_recovery(merge_bead, key, "slot", dead_holder, evidence)
    if recovery_phase_rank(phase) < 2:
        state = slot_state_or_fail()
        slot = slot_id_or_fail(state)
        actual = slot_holder(state)
        try:
            record = active_waiter_record(slot, dead_holder)
            query_error = False
        except QueryError:
            record, query_error = None, True
        if record is not None:
            lease = (record.get("metadata") or {}).get("lease_actor") or ""
            if not lease:
                fail("dead holder waiter lease is missing")
            try:
                native_holder = native_holder_token(dead_holder, record)
            except QueryError:
                fail("cannot derive dead native holder token")
            if actual == native_holder:
                if not bd_ok("merge-slot", "release", "--holder", native_holder):
                    fail("cannot release dead holder")
            elif is_new:
                fail(f"slot holder changed (expected {native_holder}, found {actual or 'none'})")
            close_observed_waiter_generation(
                slot, dead_holder, record, lease, "recovered dead slot holder"
            )
        elif query_error or is_new:
            fail("cannot find dead holder waiter generation")
        else:
            force_close_waiter_record(slot, dead_holder, False, "recovered dead slot holder")
    finish_recovery(merge_bead, key, "slot", dead_holder, evidence, phase)
    print(
        f"SLOT_RECOVERED merge={merge_bead} holder={dead_holder} evidence={evidence} "
        f"receipt={key}"
    )
    return 0


def recover_waiter(merge_bead: str, dead_waiter: str, evidence: str) -> int:
    if not evidence:
        fail("dead-waiter recovery requires an evidence reference")
    key = recovery_key("waiter", dead_waiter, evidence)
    phase, _ = prepare_recovery(merge_bead, key, "waiter", dead_waiter, evidence)
    if recovery_phase_rank(phase) < 2:
        state = slot_state_or_fail()
        slot = slot_id_or_fail(state)
        actual = slot_holder(state)
        try:
            record = active_waiter_record(slot, dead_waiter)
            query_error = False
        except QueryError:
            record, query_error = None, True
        if record is not None:
            lease = (record.get("metadata") or {}).get("lease_actor") or ""
            if not lease:
                fail("dead waiter lease is missing")
            try:
                native_holder = native_holder_token(dead_waiter, record)
            except QueryError:
                fail("cannot derive dead waiter native holder token")
            if actual == native_holder:
                fail("dead waiter currently holds the slot")
            close_observed_waiter_generation(
                slot, dead_waiter, record, lease, "recovered dead queued waiter"
            )
        elif query_error:
            fail("cannot find dead waiter generation")
        else:
            force_close_waiter_record(slot, dead_waiter, True, "recovered dead queued waiter")
    finish_recovery(merge_bead, key, "waiter", dead_waiter, evidence, phase)
    print(
        f"WAITER_RECOVERED merge={merge_bead} waiter={dead_waiter} evidence={evidence} "
        f"receipt={key}"
    )
    return 0


def recover_claim(merge_bead: str, dead_actor: str, evidence: str,
                  waiter_holder: str = "") -> int:
    if not evidence:
        fail("dead-claim recovery requires an evidence reference")
    successor = current_actor()
    if successor == dead_actor:
        fail("successor must differ from dead actor")
    subject = dead_actor
    if waiter_holder:
        subject = f"{dead_actor}|{waiter_holder}|{successor}"
    key = recovery_key("claim", subject, evidence)
    current_key, current_phase = recovery_receipt(merge_bead)
    if (current_key, current_phase) == (key, "complete"):
        print(
            f"CLAIM_RECOVERED merge={merge_bead} holder={dead_actor} "
            f"waiter={waiter_holder or 'none'} evidence={evidence} receipt={key}"
        )
        return 0

    recovery_holder = ""
    if waiter_holder:
        state = slot_state_or_fail("cannot inspect merge slot for waiter recovery")
        slot = slot_id_or_fail(state)
        try:
            record = active_waiter_record(slot, waiter_holder)
        except QueryError:
            record = None
        if record is None:
            fail("cannot find current open waiter attempt for takeover")
        require_waiter_link(record, slot, "waiter has invalid parent linkage")
        lease = (record.get("metadata") or {}).get("lease_actor") or ""
        try:
            native_holder = native_holder_token(waiter_holder, record)
        except QueryError:
            fail("cannot derive native holder token")
        actual = slot_holder(state)
        if lease == dead_actor:
            if actual == native_holder:
                if not bd_ok("merge-slot", "release", "--holder", native_holder):
                    fail("cannot release dead native holder")
            elif actual:
                fail("slot holder changed before dead-owner recovery")
            close_observed_waiter_generation(
                slot, waiter_holder, record, dead_actor, "recovered dead waiter generation"
            )
            if acquire_slot(waiter_holder, "1", "0", "handoff", "requeue") != 0:
                fail("cannot acquire fresh successor waiter generation")
        elif lease == successor:
            if actual != native_holder:
                fail("successor waiter does not own its native slot token")
        else:
            fail("waiter recovery is leased to another successor")
    else:
        recovery_holder = f"pr-shepherd:claim-recovery:{merge_bead}:{dead_actor}"
        if acquire_slot(recovery_holder, "1", "0", "handoff", "resume") != 0:
            fail("cannot acquire dead-claim recovery slot")

    # RELEASED ON EVERY EXIT PATH, not only on success. The recovery slot is acquired
    # with protection="handoff", so no signal-armed release covers it, and it used to
    # be released only after finish_recovery. Any Fail in between -- the "another
    # recovery receipt is incomplete" check inside prepare_recovery, or a bd hiccup in
    # claim_state -- left the slot held by pr-shepherd:claim-recovery:<bead>:<actor>
    # forever; retries resumed the same lease and aborted identically, and
    # release_sheepdog then returned 75 for good, so NO shepherd could take the repo
    # patrol.
    #
    # Two details are load-bearing, and each one cost me a full harness run:
    #
    # `if not waiter_holder` -- in the waiter-takeover path the slot belongs to the
    # caller's waiter, not to us, so releasing it here would tear down a lease this
    # function never acquired. Only the internal lease above is ours to free.
    #
    # The DISPOSITION must follow the outcome. Releasing "terminal" on the failure path
    # marks the waiter terminal, and the retry then dies on "terminal waiter ...
    # requires explicit requeue" -- swapping one stuck lease for an unresumable one.
    # A crashed recovery is by definition retryable.
    disposition = "retryable"
    try:
        rc = _recover_claim_body(
            merge_bead, dead_actor, evidence, waiter_holder, successor, subject, key
        )
        disposition = "terminal"
        return rc
    finally:
        if not waiter_holder and recovery_holder:
            if release_slot(recovery_holder, disposition, quiet=True) != 0 and (
                disposition == "terminal"
            ):
                fail("cannot release dead-claim recovery slot")


def _recover_claim_body(merge_bead: str, dead_actor: str, evidence: str,
                        waiter_holder: str, successor: str, subject: str,
                        key: str) -> int:
    """recover_claim's body, with the internal slot already held by the caller.

    Split out so the caller's `finally` owns the release for every exit path.
    """
    phase, _ = prepare_recovery(merge_bead, key, "claim", subject, evidence)
    if recovery_phase_rank(phase) < 2:
        claim = claim_state(merge_bead, "cannot inspect merge claim")
        actual = claim["assignee"]
        status = claim["status"]
        if actual == dead_actor:
            if not bd_ok("update", merge_bead, "--assignee", "", "--status", "open"):
                fail("cannot release dead claim")
            if not bd_ok(
                "update", merge_bead, "--claim", env_extra={"BEADS_ACTOR": successor}
            ):
                fail("cannot atomically reclaim merge bead for successor")
        elif actual:
            working = status == "in_progress" and "state:working" in claim["labels"]
            if actual != successor or not working:
                fail(
                    f"claim changed to unsafe successor state (holder={actual or 'none'}, "
                    f"status={status or 'none'})"
                )
        elif status != "open":
            fail(f"unowned claim has unsafe resumed status {status or 'none'}")
        else:
            if not bd_ok(
                "update", merge_bead, "--claim", env_extra={"BEADS_ACTOR": successor}
            ):
                fail("cannot atomically resume merge-bead reclaim")
        claim = claim_state(merge_bead, "cannot verify merge-bead reclaim")
        if claim["status"] != "in_progress" or claim["assignee"] != successor:
            fail("merge-bead reclaim did not persist")
    finish_recovery(merge_bead, key, "claim", subject, evidence, phase)
    print(
        f"CLAIM_RECOVERED merge={merge_bead} holder={dead_actor} "
        f"waiter={waiter_holder or 'none'} evidence={evidence} receipt={key}"
    )
    return 0


def claim_state(merge_bead: str, message: str) -> dict:
    try:
        record = bd_json("show", merge_bead, "--json")
    except QueryError:
        fail(message)
    if not isinstance(record, list) or not record:
        fail(message)
    entry = record[0]
    return {
        "assignee": entry.get("assignee") or "",
        "status": entry.get("status") or "",
        "labels": entry.get("labels") or [],
    }


# --------------------------------------------------------------------------
# sheepdog patrol lease
# --------------------------------------------------------------------------

# ASCII-only folding, matching `tr '[:upper:]' '[:lower:]'`: the result feeds a
# digest, so Unicode case folding would be a different identity.
_ASCII_LOWER = bytes.maketrans(bytes(range(0x41, 0x5B)), bytes(range(0x61, 0x7B)))


def canonical_repo(repo: str) -> str:
    """GitHub treats Owner/Repo and owner/repo as one repository, so the wisp folds case."""
    return repo.encode("utf-8", "surrogateescape").translate(_ASCII_LOWER).decode(
        "utf-8", "surrogateescape"
    )


def sheepdog_wisp(repo: str) -> str:
    """One shepherd per repository, addressable without a registry."""
    digest = blob_digest(nul_payload("sheepdog", canonical_repo(repo)))
    try:
        where = bd_json("where", "--json")
        prefix = where.get("prefix") if isinstance(where, dict) else None
    except QueryError:
        prefix = None
    if not isinstance(prefix, str) or not prefix:
        fail("cannot resolve beads prefix")
    return f"{prefix}-wisp-{digest[:12]}"


def sheepdog_title(repo: str) -> str:
    return f"[wisp:patrol] sheepdog {canonical_repo(repo)}"


def sheepdog_record(wisp: str) -> dict | None:
    result = bd(
        "show", wisp, "--json", env_extra={"BD_JSON_ENVELOPE": "1"}, quiet=True
    )
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)["data"][0]
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def ensure_merge_slot() -> None:
    """Create the slot when it is absent.

    `check` does not fail on a missing slot -- it exits 0 reporting
    {"available": false, "error": "not found"} -- so a missing slot is
    indistinguishable from a held one unless that field is read.
    """
    try:
        state = slot_state()
    except QueryError:
        return
    if state.get("error") == "not found":
        bd("merge-slot", "create", quiet=True)


def ensure_sheepdog_wisp(wisp: str, repo: str) -> None:
    if sheepdog_record(wisp) is not None:
        return
    created = bd_ok(
        "create", sheepdog_title(repo), "--ephemeral", "--wisp-type", "patrol",
        "--id", wisp, "--silent", quiet=True,
    )
    if not created and sheepdog_record(wisp) is None:
        fail(f"cannot create sheepdog wisp {wisp}")


def acquire_sheepdog(repo: str) -> int:
    actor = current_actor()
    wisp = sheepdog_wisp(repo)
    ensure_merge_slot()
    ensure_sheepdog_wisp(wisp, repo)
    record = sheepdog_record(wisp)
    if record is None:
        fail(f"cannot inspect sheepdog {wisp}")
    status = record.get("status")
    holder = record.get("assignee") or ""

    if status == "in_progress" and holder and holder != actor:
        print(f"SHEEPDOG_HELD repo={repo} wisp={wisp} holder={holder}")
        return EXIT_SLOT_QUEUED

    # A terminal wisp is a finished -- or crashed -- generation. Its stale assignee
    # is what refuses the next claim, not its status, so both are cleared.
    if status == "closed" or (holder and holder != actor):
        if not bd_ok("update", wisp, "--status", "open", quiet=True):
            fail(f"cannot reopen sheepdog {wisp} for the next generation")
        if not bd_ok("update", wisp, "--assignee", "", quiet=True):
            fail(f"cannot clear the previous sheepdog holder on {wisp}")

    if not bd_ok("update", wisp, "--claim", quiet=True):
        record = sheepdog_record(wisp)
        if record is None:
            fail(f"cannot re-inspect sheepdog {wisp}")
        holder = record.get("assignee") or "unknown"
        print(f"SHEEPDOG_HELD repo={repo} wisp={wisp} holder={holder}")
        return EXIT_SLOT_QUEUED
    print(f"SHEEPDOG_ACQUIRED repo={repo} wisp={wisp} holder={actor}")
    return 0


def validate_sheepdog_owner(wisp: str, actor: str) -> dict:
    record = sheepdog_record(wisp)
    if record is None:
        fail(f"sheepdog {wisp} does not exist")
    holder = record.get("assignee") or ""
    if holder != actor:
        fail(f"sheepdog {wisp} is not owned by {actor} (holder {holder or 'none'})")
    return record


def touch_sheepdog(repo: str) -> int:
    actor = current_actor()
    wisp = sheepdog_wisp(repo)
    validate_sheepdog_owner(wisp, actor)
    # The heartbeat must not mutate ownership; it only refreshes recency.
    if not bd_ok("update", wisp, "--set-metadata", f"sheepdog_touched_by={actor}"):
        fail(f"cannot record sheepdog heartbeat on {wisp}")
    print(f"SHEEPDOG_TOUCHED repo={repo} wisp={wisp} holder={actor}")
    return 0


def release_sheepdog(repo: str) -> int:
    actor = current_actor()
    wisp = sheepdog_wisp(repo)
    validate_sheepdog_owner(wisp, actor)

    # Releasing while another holder is mid-transition would let a second shepherd
    # patrol against a half-applied landing. Report contention; never force it.
    try:
        state = slot_state()
    except QueryError:
        state = {}
    if not slot_available(state):
        print(
            f"SHEEPDOG_WAITING repo={repo} wisp={wisp} holder={actor} "
            f"slot={slot_holder(state)}"
        )
        return EXIT_SLOT_QUEUED

    if not bd_ok("close", wisp, "--reason", f"sheepdog patrol released by {actor}"):
        fail(f"cannot close sheepdog {wisp}")
    if not bd_ok("update", wisp, "--assignee", "", quiet=True):
        fail(f"cannot clear the sheepdog holder on {wisp}")
    print(f"SHEEPDOG_RELEASED repo={repo} wisp={wisp} holder={actor}")
    return 0


def recover_sheepdog(repo: str, dead_holder: str, evidence: str, audit_bead: str) -> int:
    if not evidence:
        fail("sheepdog recovery requires an evidence reference")
    actor = current_actor()
    if actor == dead_holder:
        fail("successor must differ from the dead holder")
    wisp = sheepdog_wisp(repo)
    record = sheepdog_record(wisp)
    if record is None:
        fail(f"sheepdog {wisp} does not exist")
    holder = record.get("assignee") or ""

    # Recovery is only ever a takeover from the holder the caller observed dead.
    # Any other holder means the observation is stale.
    if holder != dead_holder:
        fail(f"sheepdog {wisp} no longer belongs to {dead_holder} (holder {holder or 'none'})")

    key = recovery_key("sheepdog", dead_holder, evidence)
    if not bd_ok("update", wisp, "--status", "open", quiet=True):
        fail(f"cannot reopen sheepdog {wisp} for recovery")
    if not bd_ok("update", wisp, "--assignee", "", quiet=True):
        fail(f"cannot clear the dead sheepdog holder on {wisp}")
    if not bd_ok("update", wisp, "--claim", quiet=True):
        fail(f"cannot claim sheepdog {wisp} after recovery")
    comment_once(
        audit_bead, f"recovery_receipt={key}",
        f"RECOVERED recovery_receipt={key} kind=sheepdog subject={dead_holder} "
        f"evidence={evidence}",
    )
    print(
        f"SHEEPDOG_RECOVERED repo={repo} wisp={wisp} holder={actor} dead={dead_holder} "
        f"evidence={evidence} receipt={key}"
    )
    return 0


def ready_ids() -> int:
    try:
        records = bd_json("ready", "--label", "agent:integrator", "--unassigned", "--json")
    except QueryError:
        fail("cannot query ready merge beads")
    for record in records or []:
        if isinstance(record, dict) and record.get("id"):
            print(record["id"])
    return 0


# --------------------------------------------------------------------------
# dispatch
# --------------------------------------------------------------------------

USAGE = """usage: landing-contract.py check-run <repo> <run-id> <head-sha>
       landing-contract.py check-pr <repo> <pr> <head-sha> <pr-base> [github|external|local [operator-id] [receipt-file]]
       landing-contract.py check-anchors <merge-bead> <repo> <pr>
       landing-contract.py verify-landed <repo> <pr> <base> <recorded-base-sha> <head-sha> <merge-sha>
       landing-contract.py land <merge-bead> <repo> <pr> <pr-base> <landing-base> <recorded-base-sha> <head-sha> <merge|rebase|squash> [github|external|local [operator-id] [receipt-file]]
       landing-contract.py acquire-slot <stable-holder> [attempts] [poll-seconds] [resume|requeue]
       landing-contract.py release-slot <stable-holder> [terminal|retryable]
       landing-contract.py with-slot <stable-holder> -- <command> [args...]
       landing-contract.py queue-state <repo> <pr>
       landing-contract.py failure-key <repo> <ci|conflict|review|queue> <detail>...
       landing-contract.py ensure-bounce <merge-bead> <key> <route> <title> <metadata-json> <description>
       landing-contract.py recover-slot <merge-bead> <dead-holder> <evidence-ref>
       landing-contract.py recover-waiter <merge-bead> <dead-waiter> <evidence-ref>
       landing-contract.py recover-claim <merge-bead> <dead-actor> <evidence-ref> [waiter-holder]
       landing-contract.py acquire-sheepdog <repo>
       landing-contract.py touch-sheepdog <repo>
       landing-contract.py release-sheepdog <repo>
       landing-contract.py recover-sheepdog <repo> <dead-holder> <evidence-ref> <audit-bead>
       landing-contract.py ready-ids"""


def queue_state_cli(repo: str, pr: str) -> int:
    """Report merge-queue facts for a pull request's base branch."""
    state = queue_state(repo, pr)
    if state is None:
        print(f"QUEUE_UNKNOWN repo={repo} pr={pr} treated=non-queue", file=sys.stderr)
        return EXIT_UNKNOWN
    if not state["enabled"]:
        print(f"QUEUE_ABSENT repo={repo} pr={pr}")
        return 0
    print(
        f"QUEUE_PRESENT repo={repo} pr={pr} in_queue={str(state['in_queue']).lower()} "
        f"entry_state={state['entry_state']} entry_position={state['entry_position']} "
        f"entry_head={state['entry_head']}"
    )
    return 0


# name -> (minimum args, maximum args or None for unbounded, handler)
COMMANDS = {
    "check-run": (3, 3, check_run),
    "check-pr": (4, 7, check_pr),
    "check-anchors": (3, 3, check_bead_anchors),
    "verify-landed": (6, 6, verify_landed),
    "land": (8, 11, land_pr),
    "acquire-slot": (1, 4, None),
    "release-slot": (1, 2, release_slot),
    "with-slot": (3, None, None),
    "queue-state": (2, 2, queue_state_cli),
    "failure-key": (3, None, None),
    "ensure-bounce": (6, 6, ensure_bounce),
    "recover-slot": (3, 3, recover_slot),
    "recover-waiter": (3, 3, recover_waiter),
    "recover-claim": (3, 4, recover_claim),
    "acquire-sheepdog": (1, 1, acquire_sheepdog),
    "touch-sheepdog": (1, 1, touch_sheepdog),
    "release-sheepdog": (1, 1, release_sheepdog),
    "recover-sheepdog": (4, 4, recover_sheepdog),
    "ready-ids": (0, 0, ready_ids),
}

ARITY_MESSAGE = {
    "check-run": "check-run expects 3 arguments",
    "check-pr": "check-pr expects 4-7 arguments",
    "check-anchors": "check-anchors expects 3 arguments",
    "verify-landed": "verify-landed expects 6 arguments",
    "land": "land expects 8-11 arguments",
    "acquire-slot": "acquire-slot expects 1-4 arguments",
    "release-slot": "release-slot expects 1-2 arguments",
    "with-slot": "with-slot expects a holder and command",
    "queue-state": "queue-state expects 2 arguments",
    "failure-key": "failure-key expects at least 3 arguments",
    "ensure-bounce": "ensure-bounce expects 6 arguments",
    "recover-slot": "recover-slot expects 3 arguments",
    "recover-waiter": "recover-waiter expects 3 arguments",
    "recover-claim": "recover-claim expects 3-4 arguments",
    "acquire-sheepdog": "acquire-sheepdog expects 1 argument",
    "touch-sheepdog": "touch-sheepdog expects 1 argument",
    "release-sheepdog": "release-sheepdog expects 1 argument",
    "recover-sheepdog": "recover-sheepdog expects 4 arguments",
    "ready-ids": "ready-ids expects no arguments",
}


def dispatch(argv: list[str]) -> int:
    name = argv[0] if argv else ""
    rest = argv[1:]
    if name in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    if name not in COMMANDS:
        print(USAGE, file=sys.stderr)
        return EXIT_UNKNOWN
    minimum, maximum, handler = COMMANDS[name]
    if len(rest) < minimum or (maximum is not None and len(rest) > maximum):
        fail(ARITY_MESSAGE[name])
    if name == "acquire-slot":
        holder, *tail = rest
        attempts = tail[0] if len(tail) > 0 else "3"
        interval = tail[1] if len(tail) > 1 else "1"
        waiter_mode = tail[2] if len(tail) > 2 else "resume"
        return acquire_slot(holder, attempts, interval, "handoff", waiter_mode)
    if name == "with-slot":
        return with_slot(rest[0], rest[1:])
    if name == "failure-key":
        print(failure_key(rest[0], rest[1], rest[2:]))
        return 0
    return handler(*rest)


def main(argv: list[str]) -> int:
    require_command("git")
    require_command("gh")
    require_command("bd")
    try:
        return dispatch(argv)
    finally:
        run_armed_release()


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Fail as failure:
        print(f"landing-contract: {failure}", file=sys.stderr)
        raise SystemExit(EXIT_UNKNOWN) from None
    except BrokenPipeError:
        raise SystemExit(EXIT_UNKNOWN) from None
