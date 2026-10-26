"""The viewer host: two OCP CAD Viewer processes, the side panel, and one HTTP API.

Every viewer state change goes through ocp_viewer's Python API (`show`, `set_viewer_config`,
`status`, `Animation`): the panel and the CLI only send requests here. Slot `a` shows the
active version; slot `b` holds version B while the A/B side-by-side is on, and a sync thread
copies the camera between the two.
"""

from __future__ import annotations

import json
import mimetypes
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import LimitError, ViewerError, capture, motion, record
from .capture import Presenter
from .session import HOST, port_open

SKILL = Path(__file__).resolve().parents[2]
PANEL_DIR = SKILL / "assets" / "panel"
TOKENS_CSS = SKILL.parent / "cad-concept" / "assets" / "viewer" / "tokens.css"
STATIC = {"/": PANEL_DIR / "index.html", "/panel.css": PANEL_DIR / "panel.css", "/panel.js": PANEL_DIR / "panel.js",
          "/tokens.css": TOKENS_CSS}
GHOST_ALPHA = 0.18
TREE_WIDTH = 300  # wide enough for "LMP-0001 Base plate and pivot boss" style product names
SECTION_ZOOM = 6.0  # close-up on the cut joint: the viewer fits the whole scene, then applies this
STUDIO_KEYS = ("environment", "env_intensity", "env_rotation", "background", "tone_mapping", "exposure",
               "shadow_intensity", "shadow_softness", "ao_intensity", "texture_mapping")
VIEWER_START_S = 300.0
SYNC_PERIOD_S = 0.2
SYNC_COOLDOWN_S = 0.8
CAMERA_KEYS = ("position", "quaternion", "target", "zoom")
PRESETS = {"iso": "ISO", "front": "FRONT", "side": "RIGHT", "top": "TOP"}


@dataclass
class Loaded:
    """One version as the host shows it: record, check, panel JSON, and posed shapes."""
    version: record.Version
    check_path: str | None
    panel: dict[str, Any]
    shown: dict[str, Any]  # PN -> Rigid the part is displayed at (manifest nominal pose)
    shapes: dict[str, Any]  # PN -> posed TopoDS_Shape


@dataclass
class Slot:
    name: str
    port: int
    process: subprocess.Popen | None = None
    showing: str | None = None  # "A" or "B"
    pushed: bool = False  # a model reached this viewer since its page last connected


@dataclass
class ViewState:
    hidden: set[str] = field(default_factory=set)
    isolated: tuple[str, ...] | None = None
    ghost: bool = False

    def visible(self, pn: str) -> bool:
        if pn in self.hidden:
            return False
        return self.isolated is None or pn in self.isolated or self.ghost

    def alpha(self, pn: str) -> float:
        return GHOST_ALPHA if self.isolated is not None and self.ghost and pn not in self.isolated else 1.0

    def as_json(self) -> dict[str, Any]:
        return {"hidden": sorted(self.hidden), "isolated": list(self.isolated) if self.isolated else None,
                "ghost": self.ghost}


def _load(hw: str, version: str, check_path: str | None) -> Loaded:
    loaded = record.load_version(Path(hw), version)
    check = record.read_json(Path(check_path)) if check_path else None
    panel = record.panel_model(loaded, check)
    rows = loaded.nominal_rows()
    shown = {pn: motion.rigid_from_rows(rows[pn]) for pn in rows}
    pose = motion.pose_module()
    with pose.stdout_to_stderr():
        parts = pose.load_parts(loaded.hw, parts_dir=loaded.parts_dir)
    missing = [p.pn for p in loaded.parts if p.pn not in parts]
    if missing:
        raise ViewerError(f"{loaded.parts_dir}: no STEP for {missing}")
    shapes = {p.pn: pose.placed(parts[p.pn].shape, shown[p.pn]) for p in loaded.parts}
    return Loaded(loaded, check_path, panel, shown, shapes)


class Host:
    def __init__(self, session_file: Path, panel_port: int, port_a: int, port_b: int,
                 viewport: tuple[int, int] = (1440, 900)) -> None:
        self.session_file = session_file
        self.panel_port = panel_port
        self.viewport = viewport
        self.slots = {"a": Slot("a", port_a), "b": Slot("b", port_b)}
        self.versions: dict[str, Loaded] = {}
        self.mode = "single"  # or "split"
        self.active = "A"
        self.view = ViewState()
        self.animation: dict[str, Any] | None = None
        self.animation_request: dict[str, Any] | None = None
        self.clip: dict[str, Any] | None = None  # the section view's Clip-tab config, sent after render
        self.lock = threading.RLock()
        self.halt = threading.Event()
        self.server: ThreadingHTTPServer | None = None
        self.presenter: Presenter | None = None
        # Set while a capture moves slot a's camera to measure it: the sync thread must not copy a
        # half-reported camera back. The capture copies a -> b itself when it is done.
        self.sync_hold = threading.Event()

    # ------------------------------------------------------------------ lifecycle

    def start_viewers(self) -> None:
        log_dir = self.session_file.parent
        for slot in self.slots.values():
            log = (log_dir / f"viewer-{slot.name}.log").open("w", encoding="utf-8")
            slot.process = subprocess.Popen(
                [sys.executable, "-m", "ocp_viewer", "--host", HOST, "--port", str(slot.port), "--theme", "light",
                 "--tree_width", str(TREE_WIDTH)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + VIEWER_START_S
        for slot in self.slots.values():
            while not port_open(slot.port):
                if slot.process.poll() is not None or time.monotonic() > deadline:
                    raise ViewerError(f"ocp_viewer {slot.name} did not start on port {slot.port}")
                time.sleep(0.5)

    def stop_viewers(self) -> None:
        for slot in self.slots.values():
            if slot.process is not None and slot.process.poll() is None:
                slot.process.terminate()
                try:
                    slot.process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    slot.process.kill()
                    slot.process.wait()

    def session(self) -> dict[str, Any]:
        a, b = self.slots["a"].port, self.slots["b"].port
        return {"pid": os.getpid(), "panel_port": self.panel_port, "url": f"http://{HOST}:{self.panel_port}/",
                "viewer_urls": {"a": f"http://{HOST}:{a}/", "b": f"http://{HOST}:{b}/"},
                "ports": {"panel": self.panel_port, "a": a, "b": b},
                "viewer_pids": {n: s.process.pid if s.process else None for n, s in self.slots.items()},
                "log": str(self.session_file.with_name("host.log")), "session": str(self.session_file)}

    # ------------------------------------------------------------------ viewer calls (hold the lock)

    def _tree(self, loaded: Loaded) -> Any:
        from ocp_tessellate import Color
        from ocp_tessellate.cad_objects import OCP_Part, OCP_PartGroup

        version = loaded.version

        def leaf(part: record.Part) -> Any:
            return OCP_Part(loaded.shapes[part.pn], name=part.product, color=Color(part.colour, self.view.alpha(part.pn)))

        children: list[Any] = [OCP_PartGroup([leaf(version.part(pn)) for pn in g.parts], name=g.id)
                               for g in version.groups]
        children += [leaf(p) for p in version.parts if p.group is None]
        return OCP_PartGroup(children, name=version.product_id)

    def _push(self, slot: Slot, key: str, camera: Any = None, **config: Any) -> None:
        """Show version `key` in `slot`; the camera is kept once this page already holds a model."""
        from ocp_viewer import Camera, Collapse, show

        loaded = self.versions[key]
        if camera is None:
            camera = Camera.KEEP if slot.pushed else Camera.RESET
        settings = {"explode": False, "tab": "tree", **config}
        show(self._tree(loaded), port=slot.port, reset_camera=camera, collapse=Collapse.NONE, axes=False,
             axes0=False, grid=(False, False, False), ortho=True, progress="", **settings)
        slot.showing, slot.pushed = key, True
        self.clip = None
        if slot.name == "a":
            self.animation = self.animation_request = None
        self._apply_states(slot)

    def _apply_states(self, slot: Slot) -> None:
        from ocp_viewer import set_viewer_config

        if slot.showing is None:
            return
        version = self.versions[slot.showing].version
        states = {p.path: [1, 1] if self.view.visible(p.pn) else [0, 0] for p in version.parts}
        set_viewer_config(states=states, port=slot.port)

    def _layout(self) -> dict[str, str | None]:
        """Version key each slot must show."""
        if self.mode == "split":
            return {"a": "A", "b": "B"}
        return {"a": self.active if self.active in self.versions else "A", "b": None}

    def _push_layout(self, **config: Any) -> None:
        for name, key in self._layout().items():
            slot = self.slots[name]
            if key is not None and key in self.versions:
                self._push(slot, key, **config)
            elif name == "b":
                slot.showing = None

    def camera(self, name: str) -> dict[str, Any]:
        from ocp_viewer import status

        with self.lock:
            current = status(port=self.slots[name].port)
        return {k: current.get(k) for k in (*CAMERA_KEYS, "target0")}

    def set_camera(self, name: str, camera: dict[str, Any]) -> None:
        from ocp_viewer import set_viewer_config

        values = {k: camera[k] for k in CAMERA_KEYS if camera.get(k) is not None}
        with self.lock:
            set_viewer_config(port=self.slots[name].port, **values)

    # ------------------------------------------------------------------ API operations

    def state(self) -> dict[str, Any]:
        with self.lock:
            return {"mode": self.mode, "active": self.active, "view": self.view.as_json(),
                    "versions": {k: v.panel for k, v in self.versions.items()},
                    "checks": {k: v.check_path for k, v in self.versions.items()},
                    "slots": {n: {"url": f"http://{HOST}:{s.port}/", "showing": s.showing} for n, s in self.slots.items()},
                    "animation": self.animation}

    def show_version(self, body: dict[str, Any]) -> dict[str, Any]:
        loaded = _load(_text(body, "hw"), str(body.get("version") or "latest"), body.get("check"))
        with self.lock:
            self.versions = {"A": loaded}
            self.mode, self.active = "single", "A"
            self.view = ViewState(hidden={pn for pn in self.view.hidden if pn in loaded.shapes})
            self._push_layout()
        return self.state()

    def compare(self, body: dict[str, Any]) -> dict[str, Any]:
        hw = _text(body, "hw")
        a = _load(hw, _text(body, "a"), body.get("check_a"))
        b = _load(hw, _text(body, "b"), body.get("check_b"))
        with self.lock:
            self.versions = {"A": a, "B": b}
            self.mode, self.active, self.view = "split", "A", ViewState()
            self._push_layout()
            self._copy_camera("a", "b")
        return self.state()

    def set_mode(self, body: dict[str, Any]) -> dict[str, Any]:
        mode, active = body.get("mode", self.mode), body.get("active", self.active)
        if mode not in ("single", "split") or active not in ("A", "B"):
            raise ViewerError("mode must be single|split and active A|B")
        with self.lock:
            if (mode == "split" or active == "B") and "B" not in self.versions:
                raise ViewerError("no version B loaded; run `viewer.py compare vA vB` first")
            before = self._layout()
            self.mode, self.active = mode, active
            after = self._layout()
            for name, key in after.items():
                if key is not None and key != before[name]:
                    self._push(self.slots[name], key)
            if mode == "split":
                self._copy_camera("a", "b")
        return self.state()

    def parts(self, body: dict[str, Any]) -> dict[str, Any]:
        action = body.get("action")
        with self.lock:
            focus = self.versions.get(self.active) or self.versions.get("A")
            if focus is None:
                raise ViewerError("nothing shown yet; run `viewer.py show` first")
            ghost_before, isolated_before = self.view.ghost, self.view.isolated
            if action == "reset":
                self.view = ViewState()
            elif action == "ghost":
                self.view.ghost = not self.view.ghost
            elif action in ("hide", "iso"):
                targets = focus.version.targets(_text(body, "target"))
                if action == "hide":
                    if set(targets) <= self.view.hidden:
                        self.view.hidden -= set(targets)
                    else:
                        self.view.hidden |= set(targets)
                else:
                    self.view.isolated = None if self.view.isolated == targets else targets
            else:
                raise ViewerError("action must be hide|iso|ghost|reset")
            alpha_changed = (self.view.ghost or ghost_before) and (
                self.view.ghost != ghost_before or self.view.isolated != isolated_before)
            for slot in self.slots.values():
                if slot.showing is None:
                    continue
                if alpha_changed:
                    self._push(slot, slot.showing)
                else:
                    self._apply_states(slot)
        return self.state()

    def move_camera(self, body: dict[str, Any]) -> dict[str, Any]:
        name = body.get("slot", "a")
        if name not in self.slots:
            raise ViewerError("slot must be a or b")
        self.set_camera(name, body)
        return self.camera(name)

    def apply_view(self, body: dict[str, Any]) -> dict[str, Any]:
        """Camera preset, explode flag, section, or isolation for a capture."""
        from ocp_viewer import Camera, set_viewer_config

        view = _text(body, "view")
        with self.lock:
            if "A" not in self.versions:
                raise ViewerError("nothing shown yet; run `viewer.py show` first")
            loaded = self.versions[self._layout()["a"]]
            self.view = ViewState()
            if view.startswith("isolate:"):
                self.view.isolated = loaded.version.targets(view.split(":", 1)[1])
                view = "iso"
            if view in PRESETS or view == "exploded":
                self._push_layout(camera=Camera[PRESETS.get(view, "ISO")])
                if view == "exploded":
                    for slot in self.slots.values():
                        if slot.showing:
                            set_viewer_config(explode=True, port=slot.port)
                return {"view": view, "state": self.view.as_json()}
            if view != "section":
                raise ViewerError(f"unknown view {view!r}")
            chain = motion.load_chain(loaded.version.hw)
            plane = motion.section_plane(chain, loaded.shown, _text(body, "joint"))
            normal, point = plane["normal"], plane["point"]
            # three-cad-viewer measures a clip slider from the scene's bounding-box centre: it keeps
            # n . (x - centre) + slider >= 0, so a plane through `point` needs -n . (point - centre).
            centre = _bbox_centre(loaded.shapes.values())
            constant = -sum(normal[i] * (point[i] - centre[i]) for i in range(3))
            eye = [point[i] - normal[i] * 500.0 + (-180.0 if i == 1 else 140.0 if i == 2 else 0.0) for i in range(3)]
            self._push_layout(camera=Camera.RESET, position=eye, target=point,
                              zoom=float(body.get("zoom") or SECTION_ZOOM))
            self.clip = {"tab": "clip", "clip_normal_0": normal, "clip_slider_0": constant, "clip_object_colors": True}
            return {"view": "section", "plane": {**plane, "slider": constant, "centre": centre}}

    def apply_clip(self) -> dict[str, Any] | None:
        """Switch the shown slots to the section's Clip tab and plane.

        Sent once the page has rendered the section push: a config that arrives while the browser
        still builds the shown model is overwritten by that show's own `tab: tree`. The plane cuts
        only while the Clip tab is active.
        """
        from ocp_viewer import set_viewer_config

        with self.lock:
            if self.clip is None:
                return None
            for slot in self.slots.values():
                if slot.showing:
                    set_viewer_config(port=slot.port, **self.clip)
            return dict(self.clip)

    def studio(self, body: dict[str, Any]) -> dict[str, Any]:
        """Switch the shown slots to Studio mode with the given look-dev settings.

        The next push (show, view, animate) returns the viewer to the Tree tab.
        """
        from ocp_viewer import set_viewer_config

        values = {f"studio_{key}": body[key] for key in STUDIO_KEYS if body.get(key) is not None}
        with self.lock:
            shown = [slot for slot in self.slots.values() if slot.showing]
            if not shown:
                raise ViewerError("nothing shown yet; run `viewer.py show` first")
            for slot in shown:
                set_viewer_config(tab="studio", port=slot.port, **values)
        return {"tab": "studio", "settings": values}

    def animate(self, body: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            key = self._layout()["a"]
            if key not in self.versions:
                raise ViewerError("nothing shown yet; run `viewer.py show` first")
            self._plan(body)  # rejects out-of-limit values before anything is pushed
            self.view = ViewState()
            self._push(self.slots["a"], key)
            return self._run_animation(body)

    def _plan(self, body: dict[str, Any]) -> motion.AnimationPlan:
        loaded = self.versions[self._layout()["a"]]
        steps, seconds = int(body.get("steps") or 13), float(body.get("seconds") or 4.0)
        chain = motion.load_chain(loaded.version.hw)
        return motion.plan_animation(chain, loaded.shown, _text(body, "joint"), _number(body, "from"),
                                     _number(body, "to"), steps, seconds)

    def _run_animation(self, body: dict[str, Any]) -> dict[str, Any]:
        """Send the tracks for the model slot a just received, then hold at `at` if given."""
        from ocp_viewer import Animation
        from ocp_viewer.config import session

        at = None if body.get("at") is None else _number(body, "at")
        if at is not None and not 0.0 <= at <= 1.0:
            raise ViewerError("--at must be within 0..1")
        plan = self._plan(body)
        version = self.versions[self._layout()["a"]].version
        slot = self.slots["a"]
        animation = Animation()
        for track in plan.tracks:
            path = version.part(track.pn).path
            animation.add_track(path, "t", list(plan.times), [list(v) for v in track.translations])
            animation.add_track(path, "q", list(plan.times), [list(v) for v in track.quaternions])
        # Animation.animate has no port keyword: address slot a through the session scope.
        session.begin({"port": slot.port})
        try:
            animation.animate(speed=1)
        finally:
            session.clear()
        if at is not None:
            animation.set_relative_time(at, port=slot.port)
        self.animation_request = dict(body)
        self.animation = {"joint": plan.joint, "unit": plan.unit, "from": plan.start, "to": plan.end,
                          "keyframes": len(plan.times), "seconds": plan.times[-1],
                          "moving_parts": [t.pn for t in plan.tracks], "at": at,
                          "value_at": None if at is None else plan.value_at(at)}
        return self.animation

    def browser_connected(self, body: dict[str, Any]) -> dict[str, Any]:
        """A viewer page (re)connected: push its slot's model again, keeping the last camera.

        OCP CAD Viewer does not replay the last model to a new page, so the panel announces each
        iframe load. The camera and a running animation are restored for every connected page.
        """
        name = body.get("slot")
        if name not in self.slots:
            raise ViewerError("slot must be a or b")
        with self.lock:
            slot = self.slots[name]
            key = self._layout()[name]
            if key is None or key not in self.versions:
                return {"slot": name, "showing": None}
            camera = self.camera(name) if slot.pushed else None
            replay = self.animation_request if name == "a" else None
            self._push(slot, key)
            if camera is not None:
                self.set_camera(name, camera)
            elif name == "b":
                self._copy_camera("a", "b")
            if replay is not None:
                self._run_animation(replay)
        return {"slot": name, "showing": key}

    # ------------------------------------------------------------------ camera sync

    def _copy_camera(self, source: str, target: str) -> None:
        if self.slots[target].showing is not None:
            self.set_camera(target, self.camera(source))

    def sync_cameras(self) -> None:
        last: dict[str, Any] | None = None
        quiet_until = 0.0
        while not self.halt.wait(SYNC_PERIOD_S):
            try:
                with self.lock:
                    if self.mode != "split" or self.slots["b"].showing is None or self.sync_hold.is_set():
                        last = None
                        continue
                    a, b = self.camera("a"), self.camera("b")
                    if last is None or _moved(a, last):
                        self.set_camera("b", a)
                        last, quiet_until = a, time.monotonic() + SYNC_COOLDOWN_S
                    elif time.monotonic() > quiet_until and _moved(b, last):
                        self.set_camera("a", b)
                        last, quiet_until = b, time.monotonic() + SYNC_COOLDOWN_S
            except Exception:  # noqa: BLE001 - a dropped browser must not end the sync thread
                traceback.print_exc()

    # ------------------------------------------------------------------ HTTP

    def routes(self) -> dict[tuple[str, str], Any]:
        return {
            ("GET", "/api/health"): lambda q, b: {"pid": os.getpid()},
            ("GET", "/api/state"): lambda q, b: self.state(),
            ("GET", "/api/camera"): lambda q, b: self.camera(q.get("slot", ["a"])[0]),
            ("POST", "/api/camera"): lambda q, b: self.move_camera(b),
            ("POST", "/api/show"): lambda q, b: self.show_version(b),
            ("POST", "/api/compare"): lambda q, b: self.compare(b),
            ("POST", "/api/mode"): lambda q, b: self.set_mode(b),
            ("POST", "/api/parts"): lambda q, b: self.parts(b),
            ("POST", "/api/view"): lambda q, b: self.apply_view(b),
            ("POST", "/api/animate"): lambda q, b: self.animate(b),
            ("POST", "/api/connected"): lambda q, b: self.browser_connected(b),
            ("POST", "/api/capture"): lambda q, b: self.capture(b),
            ("POST", "/api/studio"): lambda q, b: self.studio(b),
            ("POST", "/api/stop"): lambda q, b: self.request_stop(),
        }

    def request_stop(self) -> dict[str, Any]:
        threading.Timer(0.2, self.halt.set).start()
        return {"status": "stopping", "pid": os.getpid()}

    def capture(self, body: dict[str, Any]) -> dict[str, Any]:
        if self.presenter is None:
            raise ViewerError("presenter browser is not running")
        return self.presenter.submit(lambda page: capture.capture(self, page, body))

    def serve(self) -> None:
        self.start_viewers()
        host = self
        routes = self.routes()

        class Handler(BaseHTTPRequestHandler):
            server_version = "cad-viewer/1"

            def log_message(self, fmt: str, *args: Any) -> None:
                if self.command != "GET" or not str(args[1] if len(args) > 1 else "").startswith("2"):
                    sys.stderr.write(f"[panel] {fmt % args}\n")

            def _send(self, status: int, body: bytes, kind: str) -> None:
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _json(self, status: int, data: Any) -> None:
                self._send(status, json.dumps(data, default=str).encode(), "application/json")

            def _route(self, method: str) -> None:
                url = urlsplit(self.path)
                if method == "GET" and url.path in STATIC:
                    path = STATIC[url.path]
                    kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                    self._send(HTTPStatus.OK, path.read_bytes(), f"{kind}; charset=utf-8")
                    return
                handler = routes.get((method, url.path))
                if handler is None:
                    self._json(HTTPStatus.NOT_FOUND, {"error": f"no route {method} {url.path}"})
                    return
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(length) or b"{}") if length else {}
                    if not isinstance(body, dict):
                        raise ViewerError("request body must be a JSON object")
                    self._json(HTTPStatus.OK, handler(parse_qs(url.query), body))
                except LimitError as error:
                    self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error), "findings": error.findings})
                except (ViewerError, ValueError) as error:
                    self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
                except Exception as error:  # noqa: BLE001 - report infrastructure failures to the caller
                    traceback.print_exc()
                    self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"{type(error).__name__}: {error}"})

            def do_GET(self) -> None:  # noqa: N802
                self._route("GET")

            def do_POST(self) -> None:  # noqa: N802
                self._route("POST")

        self.server = ThreadingHTTPServer((HOST, self.panel_port), Handler)
        self.server.daemon_threads = True
        signal.signal(signal.SIGTERM, lambda *_: self.halt.set())
        threading.Thread(target=self.server.serve_forever, name="http", daemon=True).start()
        threading.Thread(target=self.sync_cameras, name="camera-sync", daemon=True).start()
        self.presenter = Presenter(self, f"http://{HOST}:{self.panel_port}/", *self.viewport)
        self.presenter.start()
        try:
            self.presenter.submit(lambda page: None, timeout=60.0)
            self.session_file.write_text(json.dumps(self.session(), indent=2), encoding="utf-8")
            self.halt.wait()
        finally:
            self.presenter.stop()
            self.server.shutdown()
            self.server.server_close()
            self.stop_viewers()


def _bbox_centre(shapes: Any) -> list[float]:
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    for shape in shapes:
        BRepBndLib.Add_s(shape, box)
    low, high = box.CornerMin(), box.CornerMax()
    return [(low.X() + high.X()) / 2.0, (low.Y() + high.Y()) / 2.0, (low.Z() + high.Z()) / 2.0]


def _moved(a: dict[str, Any], b: dict[str, Any]) -> bool:
    for key in CAMERA_KEYS:
        x, y = a.get(key), b.get(key)
        if isinstance(x, list) and isinstance(y, list):
            if len(x) != len(y) or any(abs(p - q) > 1e-6 for p, q in zip(x, y)):
                return True
        elif isinstance(x, (int, float)) and isinstance(y, (int, float)):
            if abs(x - y) > 1e-6:
                return True
        elif x != y:
            return True
    return False


def _text(body: dict[str, Any], key: str) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value:
        raise ViewerError(f"`{key}` must be a non-empty string")
    return value


def _number(body: dict[str, Any], key: str) -> float:
    value = body.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ViewerError(f"`{key}` must be a number")
    return float(value)


def run(session_file: Path, panel_port: int, port_a: int, port_b: int, width: int, height: int) -> int:
    host = Host(session_file, panel_port, port_a, port_b, (width, height))
    try:
        host.serve()
    finally:
        host.stop_viewers()
    return 0
