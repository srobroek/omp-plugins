#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Serve the cad-concept viewer and a scene directory, pushing reload on change.

Usage:
  uv run --script serve.py --scene-dir DIR [--host 127.0.0.1] [--port N] [--idle-timeout MIN] [--allow-remote]

Routes:
  /                     the viewer (assets/viewer)
  /api/scenes           JSON list of *.scene.json files in DIR
  /scenes/<name>        one scene file from DIR, never cached
  /events               Server-Sent Events: `change` with {"files": [...]} on edit
  /vendor/<pkg@ver>/... pinned three.js modules, fetched once from jsDelivr,
                        verified against the import map's SRI digest, cached
  POST /api/screenshot  {scene, variant, png: data URL} -> DIR/screenshots/

Every request must address the server by a loopback name and its port (`Host`), which closes
DNS rebinding; a non-loopback `--host` needs `--allow-remote` and adds that address to the names.

stdout: one JSON line {"url": ..., "scene_dir": ..., "idle_timeout_min": ...} once listening. stderr: request log.
Exit 0 on SIGINT/SIGTERM or idle timeout, 2 on usage or bind errors.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import importlib.util
import ipaddress
import json
import os
import re
import signal
import sys
import threading
import time
from collections.abc import Callable
import urllib.error
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
VIEWER_DIR = Path(__file__).resolve().parent.parent / "assets" / "viewer"
CAD_RECORD_SCRIPTS = Path(__file__).resolve().parents[2] / "cad-record" / "scripts"


def _load_layout():
    name = "cad_record_layout"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, CAD_RECORD_SCRIPTS / "layout.py")
        if spec is None or spec.loader is None:
            raise ImportError(f"layout.py not found at {CAD_RECORD_SCRIPTS}")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


layout = _load_layout()
PROJECT_ROOT = Path(__file__).resolve().parents[3]
CDN_BASE = "https://cdn.jsdelivr.net/npm/"
SCENE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.scene\.json$")
IMPORT_MAP = re.compile(r'<script type="importmap">(.*?)</script>', re.S)
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}
MAX_SCREENSHOT_BYTES = 32 * 1024 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
HEARTBEAT_S = 15.0
LOOPBACK_NAMES = ("127.0.0.1", "localhost", "[::1]")



def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def allowed_hosts(port: int, bound: str) -> frozenset[str]:
    """`Host` header values the server answers: the loopback names and the bind address."""
    return frozenset(f"{name}:{port}" for name in {*LOOPBACK_NAMES, bound})


def vendor_integrity(index_html: Path) -> dict[str, str]:
    """URL path -> SRI digest, read from the viewer's import map (the one authority)."""
    match = IMPORT_MAP.search(index_html.read_text(encoding="utf-8"))
    if not match:
        raise ValueError(f"{index_html}: no import map")
    integrity = json.loads(match.group(1)).get("integrity", {})
    return {url: sri for url, sri in integrity.items() if url.startswith("/vendor/")}


def sri_matches(data: bytes, sri: str) -> bool:
    algo, _, expected = sri.partition("-")
    if algo not in {"sha256", "sha384", "sha512"}:
        return False
    return base64.b64encode(hashlib.new(algo, data).digest()).decode() == expected


def scene_snapshot(scene_dir: Path) -> dict[str, tuple[int, int]]:
    out: dict[str, tuple[int, int]] = {}
    for path in scene_dir.glob("*.scene.json"):
        try:
            st = path.stat()
        except FileNotFoundError:
            continue
        out[path.name] = (st.st_mtime_ns, st.st_size)
    return out


def changed_files(before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]]) -> list[str]:
    return sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name))


class SceneWatcher(threading.Thread):
    """Polls the scene directory and wakes every SSE client on a change."""

    def __init__(self, scene_dir: Path, interval: float) -> None:
        super().__init__(daemon=True, name="scene-watcher")
        self.scene_dir = scene_dir
        self.interval = interval
        self.cond = threading.Condition()
        self.generation = 0
        self.last_change: list[str] = []
        self.last_activity = time.monotonic()
        self.live_clients = 0
        self._halt = threading.Event()

    def record_request(self) -> None:
        with self.cond:
            self.last_activity = time.monotonic()

    def client_connected(self) -> None:
        with self.cond:
            self.live_clients += 1
            self.cond.notify_all()

    def client_disconnected(self) -> None:
        with self.cond:
            self.live_clients -= 1
            self.last_activity = time.monotonic()
            self.cond.notify_all()

    def idle_for(self, seconds: float) -> bool:
        with self.cond:
            return self.live_clients == 0 and time.monotonic() - self.last_activity >= seconds
    def run(self) -> None:
        before = scene_snapshot(self.scene_dir)
        while not self._halt.wait(self.interval):
            after = scene_snapshot(self.scene_dir)
            files = changed_files(before, after)
            before = after
            if files:
                with self.cond:
                    self.generation += 1
                    self.last_change = files
                    self.cond.notify_all()

    def stop(self) -> None:
        self._halt.set()
        with self.cond:
            self.cond.notify_all()

    @property
    def stopped(self) -> bool:
        return self._halt.is_set()


class VendorCache:
    def __init__(self, cache_dir: Path, integrity: dict[str, str]) -> None:
        self.cache_dir = cache_dir
        self.integrity = integrity
        self._lock = threading.Lock()

    def get(self, url_path: str) -> bytes:
        """Return verified module bytes; raise LookupError (404) or OSError (502)."""
        sri = self.integrity.get(url_path)
        if sri is None:
            raise LookupError(url_path)
        rel = url_path.removeprefix("/vendor/")
        cached = self.cache_dir / rel
        with self._lock:
            if cached.is_file():
                data = cached.read_bytes()
                if sri_matches(data, sri):
                    return data
                print(f"vendor cache mismatch, refetching {rel}", file=sys.stderr)
            try:
                with urllib.request.urlopen(CDN_BASE + rel, timeout=30) as resp:
                    data = resp.read()
            except (urllib.error.URLError, TimeoutError) as exc:
                raise OSError(f"cannot fetch {CDN_BASE + rel}: {exc}") from exc
            if not sri_matches(data, sri):
                raise OSError(f"{CDN_BASE + rel} does not match pinned digest {sri}")
            cached.parent.mkdir(parents=True, exist_ok=True)
            tmp = cached.with_suffix(cached.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(cached)
            return data


class Handler(BaseHTTPRequestHandler):
    server_version = "cad-concept/1"
    scene_dir: Path
    watcher: SceneWatcher
    vendor: VendorCache
    hosts: frozenset[str] = frozenset()  # set by run() once the port is bound
    heartbeat_s = HEARTBEAT_S
    def _host_ok(self) -> bool:
        """A request naming another host (DNS rebinding, a stray proxy) is refused."""
        if self.headers.get("Host") in self.hosts:
            return True
        self._error(HTTPStatus.FORBIDDEN, f"unexpected Host {self.headers.get('Host')!r}")
        return False

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} {fmt % args}", file=sys.stderr)

    def _send(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: HTTPStatus, payload: object) -> None:
        self._send(status, json.dumps(payload).encode(), CONTENT_TYPES[".json"])

    def _error(self, status: HTTPStatus, message: str) -> None:
        self._json(status, {"ok": False, "error": message})

    def parse_request(self) -> bool:
        parsed = super().parse_request()
        if parsed:
            self.watcher.record_request()
        return parsed

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        self.watcher.record_request()
        if not self._host_ok():
            return
        path = unquote(urlsplit(self.path).path)
        if path == "/events":
            self._events()
        elif path == "/api/scenes":
            self._json(HTTPStatus.OK, {"scenes": sorted(scene_snapshot(self.scene_dir))})
        elif path.startswith("/scenes/"):
            name = path.removeprefix("/scenes/")
            file = self.scene_dir / name
            if not SCENE_NAME.match(name) or not file.is_file():
                self._error(HTTPStatus.NOT_FOUND, f"no scene {name!r} in {self.scene_dir}")
                return
            self._send(HTTPStatus.OK, file.read_bytes(), CONTENT_TYPES[".json"])
        elif path.startswith("/vendor/"):
            if path not in self.vendor.integrity:
                self._error(HTTPStatus.NOT_FOUND, f"{path} is not a pinned module")
                return
            try:
                data = self.vendor.get(path)
            except LookupError:
                self._error(HTTPStatus.NOT_FOUND, f"{path} is not a pinned module")
            except OSError as exc:
                self._error(HTTPStatus.BAD_GATEWAY, str(exc))
            else:
                self._send(HTTPStatus.OK, data, CONTENT_TYPES[".js"])
        else:
            self._static(path)

    def _static(self, path: str) -> None:
        rel = "index.html" if path in {"", "/"} else path.lstrip("/")
        file = (VIEWER_DIR / rel).resolve()
        if not file.is_relative_to(VIEWER_DIR) or not file.is_file():
            self._error(HTTPStatus.NOT_FOUND, f"{path} not found")
            return
        ctype = CONTENT_TYPES.get(file.suffix, "application/octet-stream")
        self._send(HTTPStatus.OK, file.read_bytes(), ctype)

    def _events(self) -> None:
        watcher = self.watcher
        watcher.client_connected()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            with watcher.cond:
                seen = watcher.generation
            self.wfile.write(b"event: hello\ndata: {}\n\n")
            self.wfile.flush()
            while not watcher.stopped:
                with watcher.cond:
                    watcher.cond.wait_for(lambda: watcher.generation != seen or watcher.stopped, self.heartbeat_s)
                    fresh = watcher.generation != seen
                    seen, files = watcher.generation, list(watcher.last_change)
                if fresh:
                    self.wfile.write(f"event: change\ndata: {json.dumps({'files': files})}\n\n".encode())
                else:
                    self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        finally:
            watcher.client_disconnected()

    def do_POST(self) -> None:
        if not self._host_ok():
            return
        if urlsplit(self.path).path != "/api/screenshot":
            self._error(HTTPStatus.NOT_FOUND, "unknown endpoint")
            return
        origin = self.headers.get("Origin")
        if origin is not None and origin != f"http://{self.headers.get('Host')}":
            self._error(HTTPStatus.FORBIDDEN, "cross-origin screenshot rejected")
            return
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_SCREENSHOT_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f"body must be 1..{MAX_SCREENSHOT_BYTES} bytes")
            return
        try:
            body = json.loads(self.rfile.read(length))
            scene = str(body["scene"])
            header, _, b64 = str(body["png"]).partition(",")
            png = base64.b64decode(b64, validate=True)
        except (ValueError, KeyError, TypeError, binascii.Error) as exc:
            self._error(HTTPStatus.BAD_REQUEST, f"expected JSON {{scene, png, capture}}: {exc}")
            return
        if header != "data:image/png;base64" or not png.startswith(PNG_MAGIC) or not SCENE_NAME.fullmatch(scene):
            self._error(HTTPStatus.BAD_REQUEST, "png must be a PNG data URL and scene a *.scene.json name")
            return
        scene_path = self.scene_dir / scene
        if not scene_path.is_file():
            self._error(HTTPStatus.NOT_FOUND, f"no scene {scene!r} in {self.scene_dir}")
            return
        scene_sha = hashlib.sha256(scene_path.read_bytes()).hexdigest()
        capture = body.get("capture")
        if not isinstance(capture, dict) or capture.get("scene") != scene or capture.get("variant") != body.get("variant"):
            self._error(HTTPStatus.BAD_REQUEST, "capture must bind the exact scene and selected variant")
            return
        if capture.get("scene_sha256") != scene_sha:
            self._error(HTTPStatus.CONFLICT, "scene changed while the screenshot was being captured; capture it again")
            return
        try:
            capture_sha = hashlib.sha256(layout.canonical_json(capture)).hexdigest()
            staged = layout.staging(self.project_root / "hw", "concept.screenshot")
            (staged / "preview.png").write_bytes(png)
            published = layout.publish(
                self.project_root / "hw", "concept.screenshot",
                {"SCENE_SHA": scene_sha, "CAPTURE_SHA": capture_sha}, staged,
                recipe={"scene_sha256": scene_sha, "scene": scene, "capture": capture,
                        "capture_sha256": capture_sha, "png_sha256": hashlib.sha256(png).hexdigest()},
                producer="cad-concept serve.py screenshot")
        except layout.PublishConflict as error:
            self._error(HTTPStatus.CONFLICT, str(error))
            return
        except (layout.LayoutError, OSError, ValueError) as error:
            self._error(HTTPStatus.BAD_REQUEST, str(error))
            return
        path = published.path / "preview.png"
        self._json(HTTPStatus.CREATED, {"ok": True, "path": str(path), "reused": published.reused})


def default_cache_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base) / "cad-concept" / "vendor"


def run(argv: list[str], *, idle_timeout_s: float | None = None,
        ready_callback: Callable[[dict[str, object]], None] | None = None,
        install_signals: bool = True,
        shutdown_callback: Callable[[Callable[[int, object], None]], None] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="serve.py", description=__doc__.splitlines()[0])
    parser.add_argument("--project-root", type=Path, default=PROJECT_ROOT,
                        help="project root that contains hw/ (defaults to the skill checkout root)")
    parser.add_argument("--scene-dir", type=Path, required=True, help="directory holding *.scene.json")
    parser.add_argument("--host", default="127.0.0.1", help="bind address; a non-loopback one needs --allow-remote")
    parser.add_argument("--port", type=int, default=0, help="port to listen on; 0 picks a free port")
    parser.add_argument("--idle-timeout", type=int, default=30, metavar="MIN",
                        help="exit after this many idle minutes (default: 30; 0 disables)")
    parser.add_argument("--allow-remote", action="store_true",
                        help="allow a non-loopback --host: every client on that network can then reach the server")
    parser.add_argument("--poll", type=float, default=0.3, help="scene poll interval, seconds")
    parser.add_argument("--cache-dir", type=Path, default=default_cache_dir(), help="pinned module cache")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    if args.idle_timeout < 0:
        print("serve.py: --idle-timeout must be 0 or greater", file=sys.stderr)
        return 2
    timeout_s = args.idle_timeout * 60 if idle_timeout_s is None else idle_timeout_s
    if timeout_s < 0:
        print("serve.py: idle timeout must be 0 or greater", file=sys.stderr)
        return 2
    if not is_loopback(args.host) and not args.allow_remote:
        print(f"serve.py: --host {args.host} is not a loopback address; add --allow-remote to serve it", file=sys.stderr)
        return 2

    scene_dir = args.scene_dir.resolve()
    if not scene_dir.is_dir():
        print(f"serve.py: scene dir {scene_dir} does not exist", file=sys.stderr)
        return 2
    try:
        integrity = vendor_integrity(VIEWER_DIR / "index.html")
    except (OSError, ValueError) as exc:
        print(f"serve.py: {exc}", file=sys.stderr)
        return 2

    watcher = SceneWatcher(scene_dir, args.poll)
    handler = type(
        "BoundHandler",
        (Handler,),
        {
            "project_root": args.project_root.resolve(),
            "watcher": watcher,
            "scene_dir": scene_dir,
            "heartbeat_s": HEARTBEAT_S if timeout_s <= 0 else min(HEARTBEAT_S, timeout_s / 4),
        },
    )
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), handler)
    except OSError as exc:
        print(f"serve.py: cannot listen on {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 2
    host, port = httpd.server_address[:2]
    httpd.daemon_threads = True
    handler.hosts = allowed_hosts(httpd.server_address[1], args.host)
    watcher.start()

    def shutdown(_sig: int, _frame: object) -> None:
        watcher.stop()
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    if install_signals:
        signal.signal(signal.SIGINT, shutdown)
        signal.signal(signal.SIGTERM, shutdown)
    if shutdown_callback:
        shutdown_callback(shutdown)
    ready = {"url": f"http://{host}:{port}/", "scene_dir": str(scene_dir),
             "idle_timeout_min": args.idle_timeout}
    print(json.dumps(ready), flush=True)
    if ready_callback:
        ready_callback(ready)
    if timeout_s > 0:
        def stop_when_idle() -> None:
            while True:
                with watcher.cond:
                    while not watcher.stopped:
                        remaining = timeout_s - (time.monotonic() - watcher.last_activity)
                        if watcher.live_clients == 0 and remaining <= 0:
                            break
                        watcher.cond.wait(max(0.01, min(0.2, remaining if watcher.live_clients == 0 else 0.2)))
                    if watcher.stopped:
                        return
                shutdown(signal.SIGTERM, None)
                return

        threading.Thread(target=stop_when_idle, daemon=True, name="idle-timeout").start()
    try:
        httpd.serve_forever(poll_interval=0.2)
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
