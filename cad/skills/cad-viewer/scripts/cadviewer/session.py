"""The viewer session: one host process per user, found through a session file.

`serve` starts `viewer.py host` detached and records its ports and PID; every other command
reads the session file and talks to the host over loopback HTTP. Stdlib only.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from . import LimitError, ViewerError

HOST = "127.0.0.1"
START_TIMEOUT_S = 300.0  # a cold ocp_viewer import plus its server start
REQUEST_TIMEOUT_S = 600.0  # a show tessellates every part


def session_path() -> Path:
    explicit = os.environ.get("CAD_VIEWER_SESSION")
    if explicit:
        return Path(explicit)
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "cad-viewer" / "session.json"


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


def live_session(path: Path) -> dict[str, Any] | None:
    """The recorded session when its host answers /api/health, else None."""
    data = read_session(path)
    if data is None or not pid_alive(data["pid"]):
        return None
    try:
        health = call(data, "GET", "/api/health", timeout=5)
    except ViewerError:
        return None
    return data if health.get("pid") == data["pid"] else None


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


def describe(session: dict[str, Any], script: Path, reused: bool) -> dict[str, Any]:
    return {"status": "running", "reused": reused, "url": session["url"], "pid": session["pid"],
            "viewer_urls": session["viewer_urls"], "ports": session["ports"], "log": session["log"],
            "session": session["session"],
            "stop": f"uv run --script {script} stop"}


def start(path: Path, script: Path, panel_port: int, port_a: int, port_b: int,
          viewport: tuple[int, int]) -> tuple[dict[str, Any], bool]:
    """Reuse the live session or spawn a detached host; returns (session, reused).

    `port_a`/`port_b` are the user's viewers (0 picks free ports); the presenter's pair always
    takes free ports.
    """
    existing = live_session(path)
    if existing is not None:
        return existing, True
    panel = panel_port or free_port()
    viewers = {"a": port_a, "b": port_b, "presenter_a": 0, "presenter_b": 0}
    viewers = {name: port or free_port() for name, port in viewers.items()}
    ports = [panel, *viewers.values()]
    busy = [p for p in ports if port_open(p)]
    if busy or len(set(ports)) != len(ports):
        raise ViewerError(f"ports not free or not distinct: {ports}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)  # a stale file from a host that died without `stop`
    log_path = path.with_name("host.log")
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            [sys.executable, str(script), "host", "--session", str(path), "--panel-port", str(panel),
             "--ports", json.dumps(viewers),
             "--width", str(viewport[0]), "--height", str(viewport[1])],
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.monotonic() + START_TIMEOUT_S
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ViewerError(f"viewer host exited {process.returncode}; see {log_path}")
        data = read_session(path)
        if data is not None and data["pid"] == process.pid and live_session(path) is not None:
            return data, False
        time.sleep(0.5)
    process.terminate()
    raise ViewerError(f"viewer host did not answer within {START_TIMEOUT_S:.0f} s; see {log_path}")


def stop(path: Path) -> dict[str, Any]:
    data = read_session(path)
    if data is None:
        return {"status": "stopped", "pid": None, "detail": f"no session file at {path}"}
    pid = data["pid"]
    if pid_alive(pid):
        try:
            call(data, "POST", "/api/stop", {}, timeout=10)
        except ViewerError:
            os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 30
        while pid_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.25)
        if pid_alive(pid):
            os.kill(pid, signal.SIGKILL)
    ports = data.get("ports", {})
    path.unlink(missing_ok=True)
    return {"status": "stopped", "pid": pid, "ports_free": {name: not port_open(p) for name, p in ports.items()}}
