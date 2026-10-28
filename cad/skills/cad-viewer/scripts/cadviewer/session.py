"""The viewer session: one host process per harness session, found through a session file.

`serve` starts `viewer.py host` detached and records its ports and PID; every other command
reads the session file and talks to the host over loopback HTTP. Stdlib only.

The host leads its own process group (`start_new_session`), which holds its ocp_viewer servers
and Playwright driver too: a host that has to be killed is killed with its group. A PID is only
ever signalled once its host has answered /api/health with that PID and `ps` shows it as this
session's `viewer.py host --session <path>`: a session file outlives reboots and crashes, and
the PID may since belong to another process.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import shlex
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterator

from . import LimitError, ViewerError

HOST = "127.0.0.1"
START_TIMEOUT_S = 720.0  # beyond the host's own limits (viewers 480 s, presenter 180 s), so it fails first
REQUEST_TIMEOUT_S = 600.0  # a show tessellates every part
STOP_TIMEOUT_S = 60.0  # the host closes its browser and its viewers, each given 20-30 s
KILL_GRACE_S = 10.0  # between SIGTERM and SIGKILL to a process group


def session_path(project_root: Path | None = None, session_name: str | None = None) -> Path:
    """Path for one project, harness session, or explicit name; CAD_VIEWER_SESSION always wins."""
    explicit = os.environ.get("CAD_VIEWER_SESSION")
    if explicit:
        return Path(explicit)

    project = (project_root or Path.cwd()).expanduser().resolve()
    harness_session = os.environ.get("PI_SESSION_ID") or os.environ.get("CLAUDE_CODE_SESSION_ID")
    name = session_name or os.environ.get("CAD_VIEWER_SESSION_NAME")
    identity = f"{harness_session or ''}\0{name or 'default'}\0{project}"
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "cad-viewer" / digest / "session.json"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind((HOST, 0))
        return probe.getsockname()[1]


def port_open(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.5)
        return probe.connect_ex((HOST, port)) == 0


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_session(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("pid"), int) else None


def health(data: dict[str, Any]) -> dict[str, Any] | None:
    """The host's /api/health answer when it comes from the recorded PID, else None."""
    if not pid_alive(data["pid"]):
        return None
    try:
        answer = call(data, "GET", "/api/health", timeout=5)
    except ViewerError:
        return None
    return answer if answer.get("pid") == data["pid"] else None


def live_session(path: Path) -> dict[str, Any] | None:
    """The recorded session when its host answers /api/health as the recorded PID, else None."""
    data = read_session(path)
    return data if data is not None and health(data) is not None else None


def require_session(path: Path) -> dict[str, Any]:
    data = live_session(path)
    if data is None:
        raise ViewerError(f"no running viewer (session file {path}); start one with `viewer.py serve`")
    return data


def call(session: dict[str, Any], method: str, route: str, body: dict[str, Any] | None = None,
         timeout: float = REQUEST_TIMEOUT_S) -> dict[str, Any]:
    """JSON request to the host; a 422 answer is a joint-limit rejection."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"http://{HOST}:{session['panel_port']}{route}", data=data, method=method,
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        with error:
            try:
                answer = json.loads(error.read() or b"{}")
            except ValueError:
                answer = {}
        message = answer.get("error") or f"HTTP {error.code} from {route}"
        if error.code == 422:
            raise LimitError(message, answer.get("findings") or []) from error
        raise ViewerError(message) from error
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise ViewerError(f"viewer host on port {session['panel_port']} did not answer {route}: {error}") from error


def describe(session: dict[str, Any], reused: bool, session_name: str | None = None) -> dict[str, Any]:
    command = "uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py stop"
    if session_name:
        command += f" --session {shlex.quote(session_name)}"
    return {"status": "running", "reused": reused, "url": session["url"], "pid": session["pid"],
            "viewer_urls": session["viewer_urls"], "ports": session["ports"], "log": session["log"],
            "session": session["session"], "stop": command,
            "idle_timeout_minutes": session.get("idle_timeout_minutes", 30)}


@contextlib.contextmanager
def _exclusive(path: Path) -> Iterator[None]:
    """Holds an exclusive lock beside the session file: one `serve` or `stop` at a time."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path.with_name(f"{path.name}.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # closing the descriptor releases the lock


def start(path: Path, script: Path, panel_port: int, port_a: int, port_b: int,
          viewport: tuple[int, int], idle_timeout_min: int = 30) -> tuple[dict[str, Any], bool]:
    """Reuse the live session or spawn a detached host; returns (session, reused).

    `port_a`/`port_b` are the user's viewers (0 picks free ports); the presenter's pair always
    takes free ports. A host whose presenter browser died is stopped and replaced, as it could
    take no capture. Concurrent calls queue on the session lock, so a retried `serve` waits for
    the host the first one is starting instead of spawning a second.
    """
    with _exclusive(path):
        existing = read_session(path)
        answer = health(existing) if existing is not None else None
        if answer is not None and answer.get("presenter"):
            existing["idle_timeout_minutes"] = existing.get("idle_timeout_minutes", 30)
            return existing, True
        if answer is not None:
            _stop_host(existing, path)
        return _spawn(path, script, panel_port, port_a, port_b, viewport, idle_timeout_min), False


def _spawn(path: Path, script: Path, panel_port: int, port_a: int, port_b: int,
           viewport: tuple[int, int], idle_timeout_min: int) -> dict[str, Any]:
    panel = panel_port or free_port()
    viewers = {"a": port_a, "b": port_b, "presenter_a": 0, "presenter_b": 0}
    viewers = {name: port or free_port() for name, port in viewers.items()}
    ports = [panel, *viewers.values()]
    busy = [p for p in ports if port_open(p)]
    if busy or len(set(ports)) != len(ports):
        raise ViewerError(f"ports not free or not distinct: {ports}")
    path.unlink(missing_ok=True)  # a stale file from a host that died without `stop`
    log_path = path.with_name("host.log")
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            [sys.executable, str(script), "host", "--session", str(path), "--panel-port", str(panel),
             "--ports", json.dumps(viewers), "--width", str(viewport[0]), "--height", str(viewport[1]),
             "--idle-timeout", str(idle_timeout_min)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.monotonic() + START_TIMEOUT_S
    while time.monotonic() < deadline:
        if process.poll() is not None:
            _end_group(process.pid, process)  # whatever the host left behind
            raise ViewerError(f"viewer host exited {process.returncode}; see {log_path}")
        data = read_session(path)
        if data is not None and data["pid"] == process.pid and health(data) is not None:
            return data
        time.sleep(0.5)
    _end_group(process.pid, process)
    path.unlink(missing_ok=True)
    raise ViewerError(f"viewer host did not answer within {START_TIMEOUT_S:.0f} s; see {log_path}")


def stop(path: Path) -> dict[str, Any]:
    """Stop the recorded host when it proves its PID; otherwise only drop the stale file."""
    if not path.parent.is_dir():
        return {"status": "stopped", "pid": None, "detail": f"no session file at {path}"}
    with _exclusive(path):
        data = read_session(path)
        if data is None:
            return {"status": "stopped", "pid": None, "detail": f"no session file at {path}"}
        if health(data) is None:
            path.unlink(missing_ok=True)
            return {"status": "stale", "pid": data["pid"],
                    "detail": f"no viewer host answered as PID {data['pid']}; nothing signalled, {path} removed"}
        forced = _stop_host(data, path)
        path.unlink(missing_ok=True)
    ports = data.get("ports", {})
    return {"status": "stopped", "pid": data["pid"], "forced": forced,
            "ports_free": {name: not port_open(p) for name, p in ports.items()}}


def host_command(pid: int) -> str:
    """The command line `ps` shows for `pid`, "" when there is no such process."""
    result = subprocess.run(["ps", "-ww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True,
                            check=False)
    return result.stdout.strip()


def _stop_host(data: dict[str, Any], path: Path) -> bool:
    """Stop a host that just proved its PID; True when its process group had to be killed.

    The host is asked first. Signals go only to a PID whose command line is this session's
    `viewer.py host --session <path>`, the second proof that the PID is still the host.
    """
    pid = data["pid"]
    try:
        call(data, "POST", "/api/stop", {}, timeout=10)
    except ViewerError:
        _require_host_command(pid, path)
        _send(os.kill, pid, signal.SIGTERM)  # the host's handler runs the same cleanup
    deadline = time.monotonic() + STOP_TIMEOUT_S
    while pid_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.25)
    if not pid_alive(pid):
        return False
    _require_host_command(pid, path)
    _end_group(pid)
    return True


def _require_host_command(pid: int, path: Path) -> None:
    command = host_command(pid)
    if "viewer.py" not in command or f" host --session {path}" not in command:
        raise ViewerError(f"PID {pid} is not `viewer.py host --session {path}` ({command or 'no such process'!r}); "
                          "not signalled")


def _send(kill: Callable[[int, int], None], target: int, sig: int) -> bool:
    """`os.kill` or `os.killpg` one target; False when it is already gone."""
    try:
        kill(target, sig)
    except ProcessLookupError:
        return False
    except PermissionError as error:
        raise ViewerError(f"not permitted to signal {target}: {error}") from error
    return True


def _end_group(pgid: int, leader: subprocess.Popen | None = None) -> None:
    """SIGTERM the process group `pgid`, then SIGKILL whatever is left after KILL_GRACE_S.

    `leader` is the group leader when it is this process's child: it is reaped while waiting,
    so its zombie does not keep the group alive.
    """
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not _send(os.killpg, pgid, sig):
            break
        deadline = time.monotonic() + KILL_GRACE_S
        while not _group_gone(pgid, leader) and time.monotonic() < deadline:
            time.sleep(0.2)
        if _group_gone(pgid, leader):
            break
    if leader is not None:
        leader.wait()


def _group_gone(pgid: int, leader: subprocess.Popen | None) -> bool:
    if leader is not None:
        leader.poll()
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        pass  # a member this user may not signal still exists
    return False
