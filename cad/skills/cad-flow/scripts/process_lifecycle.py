#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Process supervision shared by cad-motion sweeps, the cad-model static check and cad-analysis FEA.

Stdlib only, POSIX (Linux, macOS, the BSDs). A guarantee this platform cannot give raises
`Unsupported`; nothing is silently left unarmed.

Run records. `claim_run(hw, kind)` records the calling process at hw/.cad/runs/<run id>.json:
its pid and start identity (`identity`: Linux boot id and start time, elsewhere `ps -o lstart`),
its process group when it leads one, and each process group it starts with `RunGuard.spawn`.
The kernel reuses ids, so a pid alone proves nothing once its process is gone. A recorded
process runs only while some process has that pid and that identity. A recorded group is still
ours while its leader has the recorded identity, or while no process holds the leader's id at
all: the kernel never hands out an id that is still in use as a process group id, so the group's
survivors keep it reserved. Under an exclusive lock on the runs directory, the claim reads every
record of `hw` and of its .cad-work scratch copies, plus the legacy sweep locks
(hw/motion/*/.sweep-*.json, .cad-work/**/*.sweep.json). It refuses (`RunRefused`) while
  - a run with the same identity (kind and scope: a version, a case) still runs;
  - a run that ended left a recorded process group running (orphaned workers);
  - a record cannot be verified: a legacy lock (it has no identity) whose group still runs, a
    record from another host, or an unreadable record.
It signals none of them; the refusal lists the commands that stop them. It deletes records of
runs that ended and left nothing running. A running run of another identity is allowed and
listed in `RunGuard.concurrent`, so different checks and FEA cases run side by side.

Private process groups. `spawn` starts a command in a new session under a small supervisor
(this file's `supervise` mode). The supervisor leads the group, runs the command as its child
and exits with the command's status; everything the command starts stays in the group. The
supervisor polls its parent, and when the spawning process ends, however abruptly, it kills the
whole group, grandchildren (Gmsh, CalculiX) included. A parent-death signal on the command alone
would not reach those. On SIGTERM it forwards TERM to the group and kills the group
GRACE_SECONDS later. `terminate_group` sends TERM to the group and waits up to its grace for the
supervisor to exit. It then kills the group before reaping the supervisor, since an unreaped
leader keeps its id, and so the group id, from reuse. Finally it drops the group from its run
record. `run` is subprocess.run built on these. One window remains open: a process the command
leaves behind after it ends by itself dies only once the spawning process calls
`terminate_group`.

`die_with(parent)` ends the calling process when process `parent` ends (pool workers).

Usage:
    python3 process_lifecycle.py strays --hw HW
        JSON inventory of recorded runs still running or left behind. Exit 0 when only
        running runs are found, 1 when an orphaned or unverifiable one is found.
"""

from __future__ import annotations

import argparse
import atexit
import errno
import fcntl
import json
import os
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import cache
from pathlib import Path
from typing import Any

SCHEMA = 1
KINDS = frozenset({"sweep", "static", "fea"})
GRACE_SECONDS = 2.0   # TERM to KILL
POLL_SECONDS = 0.1    # how often a supervisor checks its parent
SCRIPT = Path(__file__).resolve()
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


class LifecycleError(RuntimeError):
    """A run cannot be claimed, or a process cannot be supervised as asked."""


class Unsupported(LifecycleError):
    """This platform lacks a capability the guarantee needs."""


@dataclass(frozen=True)
class Stray:
    """A recorded run that still runs, or that may have left processes behind."""

    path: Path            # the run record, or a legacy sweep lock
    kind: str             # sweep, static, fea; "unknown" for an unreadable record
    state: str            # running | orphaned | unverifiable
    reason: str
    run_id: str | None = None
    scope: str = ""                     # with `kind`, the run's identity
    pid: int | None = None              # the run's own process, while it runs
    groups: tuple[int, ...] = ()        # its process groups that still run

    def stop_commands(self) -> list[str]:
        commands = [f"kill -TERM {self.pid}"] if self.pid is not None and self.pid not in self.groups else []
        return commands + [f"kill -TERM -- -{group}" for group in self.groups]

    def describe(self) -> str:
        stop = " and ".join(f"`{command}`" for command in self.stop_commands())
        if self.state != "unverifiable":
            return f"{self.path}: {self.reason}; stop it with {stop}"
        if stop:
            return f"{self.path}: {self.reason}; stop it with {stop}, or delete {self.path} if those runs are not CAD runs"
        return f"{self.path}: {self.reason}; delete it once no process of that run is left"

    def to_json(self) -> dict[str, Any]:
        return {"record": str(self.path), "kind": self.kind, "scope": self.scope, "state": self.state, "run_id": self.run_id,
                "pid": self.pid, "groups": list(self.groups), "reason": self.reason, "stop": self.stop_commands()}


class RunRefused(LifecycleError):
    """`claim_run` found runs that still run or left processes behind; `strays` lists them."""

    def __init__(self, strays: Sequence[Stray]) -> None:
        self.strays = tuple(strays)
        super().__init__("\n".join(stray.describe() for stray in self.strays))


def _require_posix() -> None:
    if os.name != "posix" or not hasattr(os, "killpg"):
        raise Unsupported(f"process groups are POSIX only; {sys.platform} has none")


@cache
def _boot_id() -> str:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    except OSError:
        return ""


def identity(pid: int) -> str | None:
    """The start identity of process `pid`, or None when no process has that id. A zombie keeps
    its identity until it is reaped. Raises Unsupported when this platform has no way to read
    it."""
    if pid <= 0:
        raise ValueError(f"not a process id: {pid}")
    if sys.platform.startswith("linux"):
        try:
            stat = Path(f"/proc/{pid}/stat").read_text(encoding="ascii", errors="replace")
        except (FileNotFoundError, ProcessLookupError):
            return None
        except OSError as error:
            raise Unsupported(f"cannot read /proc/{pid}/stat: {error}") from error
        return f"{_boot_id()}:{stat.rpartition(')')[2].split()[19]}"  # field 22, starttime
    ps = shutil.which("ps") or "/bin/ps"
    try:
        result = subprocess.run([ps, "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True,
                                env={**os.environ, "LC_ALL": "C"}, check=False)
    except OSError as error:
        raise Unsupported(f"no /proc and no usable ps ({error}): process identities unavailable") from error
    started = " ".join(result.stdout.split())
    if started:
        return started
    if result.returncode == 1:
        return None
    raise Unsupported(f"`ps -o lstart= -p {pid}` failed: {result.stderr.strip() or result.returncode}")


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:  # another user's process holds the id
        return True
    return True


def _group_runs(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


# -- dying with a parent --------------------------------------------------------------------------

# kqueue reports the exit of the parent or of the worker, whichever comes first. A parent exit
# kills the worker. The watchdog ignores SIGINT, so a Ctrl-C to the foreground group cannot leave
# the worker unguarded.
_WATCHDOG = """
import os, select, signal, sys
signal.signal(signal.SIGINT, signal.SIG_IGN)
parent, worker = int(sys.argv[1]), int(sys.argv[2])
queue = select.kqueue()
try:
    for pid in (worker, parent):
        queue.control([select.kevent(pid, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                     select.KQ_NOTE_EXIT)], 0)
except ProcessLookupError:
    ended = parent
else:
    os.write(1, b"armed\\n")
    os.close(1)
    ended = queue.control(None, 1)[0].ident
if ended == parent:
    try:
        os.kill(worker, signal.SIGKILL)
    except ProcessLookupError:
        pass
"""
_WATCHDOGS: list[subprocess.Popen[bytes]] = []  # referenced until this process ends; never reaped


def die_with(parent: int) -> None:
    """Kill this process with SIGKILL when process `parent` ends, even in the middle of a native
    call that holds the interpreter lock, so a stopped or killed run leaves no worker going.
    Linux: prctl(PR_SET_PDEATHSIG) fires when this process's parent exits. That is `parent`
    itself, or the forkserver that forked this process and exits with `parent`. After arming, a
    parent that is already gone ends this process at once. macOS and the BSDs: a watchdog
    process waits on kqueue for either exit, and this call returns only once it is armed. Raises
    Unsupported elsewhere."""
    if sys.platform.startswith("linux"):
        import ctypes

        before = os.getppid()
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # 1: PR_SET_PDEATHSIG
            raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG) failed")
        if os.getppid() != before or not _pid_exists(parent):
            os._exit(1)
        return
    if not hasattr(select, "kqueue"):
        raise Unsupported(f"{sys.platform} has neither PR_SET_PDEATHSIG nor kqueue: a worker cannot die with its parent")
    watchdog = subprocess.Popen([sys.executable, "-I", "-S", "-B", "-c", _WATCHDOG, str(parent), str(os.getpid())],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert watchdog.stdout is not None
    with watchdog.stdout:
        armed = watchdog.stdout.readline()
    if armed != b"armed\n":
        raise OSError(errno.ECHILD, f"the kqueue watchdog of process {os.getpid()} did not arm")
    _WATCHDOGS.append(watchdog)


# -- private process groups -----------------------------------------------------------------------

def _check_program(program: str, cwd: Any, env: Any) -> None:
    """Raise what subprocess would raise for a missing or non-executable program, before a
    supervisor starts."""
    if os.path.dirname(program):
        path = Path(program) if os.path.isabs(program) else Path(cwd or os.getcwd()) / program
        if not path.is_file():
            raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), program)
        if not os.access(path, os.X_OK):
            raise PermissionError(errno.EACCES, os.strerror(errno.EACCES), program)
    elif shutil.which(program, path=os.pathsep.join(os.get_exec_path(env))) is None:
        raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), program)


class Supervised(subprocess.Popen):
    """A command under a supervisor that leads its own process group (see the module docstring).
    `pid` is the supervisor's, which is also the group id. `command` is the supervised command,
    and `group_identity` the supervisor's start identity. Leaving a `with` block terminates the
    group."""

    def __init__(self, argv: Sequence[str | os.PathLike[str]], *, guard: RunGuard | None = None,
                 **popen: Any) -> None:
        _require_posix()
        for key in ("start_new_session", "process_group", "preexec_fn", "executable"):
            if key in popen:
                raise TypeError(f"spawn sets {key} itself")
        command = tuple(os.fspath(arg) for arg in argv)
        if not command:
            raise ValueError("spawn needs a command")
        if not sys.executable:
            raise Unsupported("no Python executable to run the supervisor with")
        _check_program(command[0], popen.get("cwd"), popen.get("env"))
        super().__init__([sys.executable, "-I", "-S", "-B", str(SCRIPT), "supervise", str(os.getpid()), *command],
                         start_new_session=True, **popen)
        self.command, self.guard, self._group_ended = command, guard, False
        try:
            self.group_identity = identity(self.pid)  # the unreaped supervisor still has it
            if guard is not None:
                guard._register(self)
        except BaseException:
            self.guard = None
            terminate_group(self, grace_seconds=0)
            raise

    def __exit__(self, *exc: Any) -> None:
        try:
            terminate_group(self)
        finally:
            super().__exit__(*exc)


def spawn(argv: Sequence[str | os.PathLike[str]], **popen: Any) -> Supervised:
    """Start `argv` in a private process group that dies with this process. `popen` takes
    subprocess.Popen's arguments (cwd, env, stdin, stdout, stderr, text, ...), except the ones
    that would change the session. A missing or non-executable program raises FileNotFoundError
    or PermissionError, as subprocess does."""
    return Supervised(argv, **popen)


def _exited(process: Supervised) -> bool:
    """Whether the supervisor has exited, without reaping it."""
    if process.returncode is not None:
        return True
    try:
        return os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except ChildProcessError:
        return True


def _signal_group(process: Supervised, sig: int) -> None:
    # Once the supervisor is reaped its id is free. While another process holds it, our group is
    # gone, since no new process gets an id that is still a group id.
    if process.returncode is not None and _pid_exists(process.pid):
        return
    with suppress(ProcessLookupError, PermissionError):
        os.killpg(process.pid, sig)


def terminate_group(process: Supervised, *, grace_seconds: float = GRACE_SECONDS) -> int:
    """TERM the process group of `process`, wait up to `grace_seconds` for its supervisor to
    exit, KILL the group, and then reap the supervisor. Returns its exit status, which is the
    command's status when the command ended first. Idempotent; drops the group from its run
    record."""
    if not process._group_ended:
        _signal_group(process, signal.SIGTERM)
        deadline = time.monotonic() + grace_seconds
        while not _exited(process) and time.monotonic() < deadline:
            time.sleep(0.02)
        _signal_group(process, signal.SIGKILL)
        process._group_ended = True
    code = process.wait()
    if process.guard is not None:
        process.guard._forget(process)
    return code


def run(argv: Sequence[str | os.PathLike[str]], *, timeout: float | None = None, input: Any = None,
        capture_output: bool = False, guard: RunGuard | None = None, **popen: Any) -> subprocess.CompletedProcess:
    """subprocess.run of a supervised command: on timeout, error or interrupt, its whole group
    is terminated before the exception propagates. TimeoutExpired names the command and carries
    the output read so far. Leftovers of a command that ends by itself are killed too."""
    if capture_output:
        if "stdout" in popen or "stderr" in popen:
            raise ValueError("stdout and stderr arguments may not be used with capture_output")
        popen["stdout"] = popen["stderr"] = subprocess.PIPE
    if input is not None:
        popen["stdin"] = subprocess.PIPE
    with Supervised(argv, guard=guard, **popen) as process:
        try:
            stdout, stderr = process.communicate(input, timeout=timeout)
        except subprocess.TimeoutExpired as expired:
            terminate_group(process)
            raise subprocess.TimeoutExpired(list(process.command), expired.timeout, expired.output,
                                            expired.stderr) from None
        except BaseException:
            terminate_group(process)
            raise
        code = terminate_group(process)
    return subprocess.CompletedProcess(list(process.command), code, stdout, stderr)


def _supervise(parent: int, command: list[str]) -> None:
    """The supervisor: this process leads its own session and process group (spawn starts it so)."""
    stopping: list[float] = []

    def stop(_signum: int, _frame: Any) -> None:
        if not stopping:
            stopping.append(time.monotonic())
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            os.killpg(0, signal.SIGTERM)

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    if os.getppid() != parent:
        os.killpg(0, signal.SIGKILL)
    try:
        child = subprocess.Popen(command)
    except OSError as error:
        print(f"process_lifecycle: cannot start {command[0]}: {error}", file=sys.stderr, flush=True)
        os._exit(127)
    while True:
        try:
            code = child.wait(POLL_SECONDS)
            break
        except subprocess.TimeoutExpired:
            pass
        if os.getppid() != parent or (stopping and time.monotonic() - stopping[0] > GRACE_SECONDS):
            os.killpg(0, signal.SIGKILL)
    if code < 0:  # end the same way, so the parent reads the command's own status
        import resource

        with suppress(OSError, ValueError):  # the command's crash left its own core or report; add none
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        with suppress(OSError, ValueError):
            signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
        os._exit(128 - code)
    os._exit(code)


# -- run records ----------------------------------------------------------------------------------

def runs_dir(hw: Path) -> Path:
    return Path(hw).resolve() / ".cad" / "runs"


def _write_json(path: Path, data: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


@contextmanager
def _exclusive(path: Path) -> Iterator[None]:
    with open(path, "a", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _recorded_group_runs(pgid: int, recorded: str) -> bool:
    current = identity(pgid)
    if current is not None and current != recorded:
        return False  # another process holds the leader's id: the recorded group is gone
    return _group_runs(pgid)


def _record_stray(path: Path) -> Stray | None:
    """The run of record `path` if it still runs or may have left processes behind, else None."""
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        kind, run_id, host = str(record["kind"]), str(record["run_id"]), str(record["host"])
        scope = str(record.get("scope", ""))
        pid, recorded = int(record["pid"]), str(record["identity"])
        owned = [(int(group["pgid"]), str(group["identity"])) for group in record["groups"]]
        if record.get("pgid") is not None:
            owned.insert(0, (int(record["pgid"]), recorded))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        return Stray(path, "unknown", "unverifiable", f"unreadable run record ({type(error).__name__}: {error})")
    if pid == os.getpid():
        return None
    if host != socket.gethostname():
        return Stray(path, kind, "unverifiable", f"a {kind} run recorded on host {host}, which this host cannot check",
                     run_id)
    try:
        running = identity(pid) == recorded
        groups = tuple(pgid for pgid, leader in owned if _recorded_group_runs(pgid, leader))
    except Unsupported as error:
        return Stray(path, kind, "unverifiable", f"a {kind} run whose processes cannot be checked: {error}", run_id)
    what = f"a {kind} run of {scope}" if scope else f"a {kind} run"
    if running:
        return Stray(path, kind, "running", f"{what} still runs as process {pid}", run_id, scope, pid, groups)
    if groups:
        return Stray(path, kind, "orphaned", f"{what} ended and left process groups running", run_id, scope, None, groups)
    return None


def _legacy_runs(group: int, pid: int) -> bool:
    if group == os.getpgrp():  # our own group: only the recorded process tells
        return pid != os.getpid() and _pid_exists(pid)
    return _group_runs(group)


def _legacy_strays(hw: Path) -> list[Stray]:
    found = []
    locks = {*hw.glob("motion/*/.sweep-*.json"), *(hw.parent / ".cad-work").glob("**/*.sweep.json")}
    for path in sorted(locks):
        try:
            recorded = json.loads(path.read_text(encoding="utf-8"))
            group, pid = int(recorded["pgid"]), int(recorded["pid"])
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if _legacy_runs(group, pid):
            found.append(Stray(path, "sweep", "unverifiable",
                               f"a sweep lock without a start identity names process group {group}, which still runs",
                               groups=(group,)))
    return found


def _inventory(hw: Path, *, prune: bool) -> list[Stray]:
    hw = Path(hw).resolve()
    own = runs_dir(hw)
    found = []
    for path in [*sorted(own.glob("*.json")), *sorted((hw.parent / ".cad-work").glob("**/.cad/runs/*.json"))]:
        stray = _record_stray(path)
        if stray is not None:
            found.append(stray)
        elif prune and path.parent == own:
            path.unlink(missing_ok=True)
    return found + _legacy_strays(hw)


def strays(hw: Path) -> list[Stray]:
    """Every recorded run of `hw` (and of its .cad-work scratch copies) that still runs or may
    have left processes behind, plus the legacy sweep locks whose group still runs. Signals
    nothing."""
    _require_posix()
    return _inventory(hw, prune=False)


class RunGuard:
    """This process's claim on hw/.cad/runs/<run_id>.json (see `claim_run`). `spawn` starts
    commands in private groups recorded in it; `release` terminates those still running and
    removes the record. Also a context manager, and released at interpreter exit."""

    def __init__(self, path: Path, record: dict[str, Any], concurrent: tuple[Stray, ...]) -> None:
        self.path, self.concurrent = path, concurrent
        self._record = record
        self._groups: dict[int, Supervised] = {}
        self._lock = threading.Lock()
        self._released = False

    @property
    def run_id(self) -> str:
        return self._record["run_id"]

    @property
    def kind(self) -> str:
        return self._record["kind"]

    def spawn(self, argv: Sequence[str | os.PathLike[str]], **popen: Any) -> Supervised:
        """`spawn`, with the group recorded in this run's record before this returns."""
        with self._lock:
            if self._released:
                raise LifecycleError(f"run {self.run_id} was released")
        return Supervised(argv, guard=self, **popen)

    def _write(self) -> None:
        self._record["groups"] = [{"pgid": process.pid, "identity": process.group_identity,
                                   "argv": list(process.command)} for process in self._groups.values()]
        _write_json(self.path, self._record)

    def _register(self, process: Supervised) -> None:
        with self._lock:
            self._groups[process.pid] = process
            self._write()

    def _forget(self, process: Supervised) -> None:
        with self._lock:
            if self._groups.pop(process.pid, None) is not None and not self._released:
                self._write()

    def release(self) -> None:
        with self._lock:
            if self._released or self._record["pid"] != os.getpid():
                return
            self._released = True
            running = list(self._groups.values())
        for process in running:
            terminate_group(process)
        with suppress(OSError, ValueError):
            if json.loads(self.path.read_text(encoding="utf-8")).get("run_id") == self.run_id:
                self.path.unlink()
        atexit.unregister(self.release)

    def __enter__(self) -> RunGuard:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.release()


def claim_run(hw: Path, kind: str, run_id: str | None = None, *, scope: str = "") -> RunGuard:
    """Record this process as a `kind` run of `hw` for `scope` (what it works on: a version, a
    case; "" for the whole hw), or raise RunRefused (see the module docstring). The record holds
    this process's group only when this process leads it, so its stop command never reaches an
    invoking shell that shares the group."""
    if kind not in KINDS:
        raise ValueError(f"unknown run kind {kind!r}; expected one of {sorted(KINDS)}")
    run_id = run_id or uuid.uuid4().hex
    if not RUN_ID.fullmatch(run_id):
        raise ValueError(f"run id {run_id!r} must match {RUN_ID.pattern}")
    _require_posix()
    hw = Path(hw).resolve()
    runs = runs_dir(hw)
    runs.mkdir(parents=True, exist_ok=True)
    ignore = runs / ".gitignore"
    if not ignore.exists():
        ignore.write_text("*\n", encoding="utf-8")
    path = runs / f"{run_id}.json"
    pid, pgid = os.getpid(), os.getpgrp()
    with _exclusive(runs / ".lock"):
        found = _inventory(hw, prune=True)
        refused = [stray for stray in found if stray.state != "running" or (stray.kind, stray.scope) == (kind, scope)]
        if refused:
            raise RunRefused(refused)
        if path.exists():
            raise LifecycleError(f"{path} already exists: a run id names one run")
        record = {"schema": SCHEMA, "kind": kind, "scope": scope, "run_id": run_id, "host": socket.gethostname(), "pid": pid,
                  "identity": identity(pid), "pgid": pgid if pgid == pid else None, "argv": list(sys.argv),
                  "started": datetime.now(timezone.utc).isoformat(timespec="seconds"), "groups": []}
        _write_json(path, record)
    guard = RunGuard(path, record, tuple(found))
    atexit.register(guard.release)
    return guard


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["supervise"] and len(argv) >= 3:
        _supervise(int(argv[1]), argv[2:])
    parser = argparse.ArgumentParser(description="Inventory of recorded CAD runs that still run or left processes behind")
    sub = parser.add_subparsers(dest="command", required=True)
    listing = sub.add_parser("strays", help="list recorded runs that still run or left processes behind")
    listing.add_argument("--hw", type=Path, default=Path("hw"))
    args = parser.parse_args(argv)
    try:
        found = strays(args.hw)
    except LifecycleError as error:
        print(f"process_lifecycle: {error}", file=sys.stderr)
        return 2
    print(json.dumps({"hw": str(Path(args.hw).resolve()), "strays": [stray.to_json() for stray in found]}, indent=2))
    return 1 if any(stray.state != "running" for stray in found) else 0


if __name__ == "__main__":
    sys.exit(main())
