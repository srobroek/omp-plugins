"""The viewer host: OCP CAD Viewer processes, the side panel, and one HTTP API.

Every viewer state change goes through ocp_viewer's Python API (`show`, `set_viewer_config`,
`status`, `Animation`): the panel and the CLI only send requests here. Slot `a` shows the
active version; slot `b` holds version B while the A/B side-by-side is on, and a sync thread
copies the camera between the two. Version A and B each hold `vN` or `latest`; the host's main
loop reloads a version that follows `latest` when hw/versions/latest.json names a new build.

Each slot runs one viewer per audience. ocp_viewer serves one registered browser per port (the
last page to connect), so the user's tab and the headless presenter page that captures read
each get their own viewer, and every show, config, clip, animation, and camera change goes to
both. The presenter's camera alone moves while a capture measures the frame, and no other request
may change the viewer state until that capture is done (CaptureGuard).

The API answers only requests addressed to 127.0.0.1 or localhost on its port (`Host`), from no
page or its own (`Origin`), with a JSON body on POST: a web page the user visits can neither
send it a simple cross-origin request nor reach it through DNS rebinding.
"""

from __future__ import annotations

import contextlib
import json
import mimetypes
import os
import signal
import subprocess
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field, replace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, quote, urlsplit

from . import LimitError, ViewerError, capture, gallery, motion, record
from .capture import Presenter
from .session import HOST, port_open

SKILL = Path(__file__).resolve().parents[2]
PANEL_DIR = SKILL / "assets" / "panel"
GALLERY_DIR = SKILL / "assets" / "gallery"
TOKENS_CSS = SKILL.parent / "cad-concept" / "assets" / "viewer" / "tokens.css"
STATIC = {"/": PANEL_DIR / "index.html", "/panel.css": PANEL_DIR / "panel.css", "/panel.js": PANEL_DIR / "panel.js",
          "/tokens.css": TOKENS_CSS, "/gallery": GALLERY_DIR / "index.html",
          "/gallery.css": GALLERY_DIR / "gallery.css", "/gallery.js": GALLERY_DIR / "gallery.js"}
GHOST_ALPHA = 0.18
TREE_WIDTH = 300  # wide enough for "LMP-0001 Base plate and pivot boss" style product names
SECTION_ZOOM = 6.0  # close-up on the cut joint: the viewer fits the whole scene, then applies this
STUDIO_KEYS = ("environment", "env_intensity", "env_rotation", "background", "tone_mapping", "exposure",
               "shadow_intensity", "shadow_softness", "ao_intensity", "texture_mapping")
VIEWER_START_S = 480.0  # a cold ocp_viewer import on a loaded machine took over 240 s; within START_TIMEOUT_S
VIEWER_STOP_S = 20.0
CAPTURE_TIMEOUT_S = 540.0  # within the CLI's REQUEST_TIMEOUT_S, so its answer reaches the CLI
SYNC_PERIOD_S = 0.2
SYNC_COOLDOWN_S = 0.8
CAMERA_KEYS = ("position", "quaternion", "target", "zoom")
AUDIENCES = ("user", "presenter")  # the user's browser tab; the headless page captures read
PRESETS = {"iso": "ISO", "front": "FRONT", "side": "RIGHT", "top": "TOP"}
# POST routes that change what the viewers show: refused while a capture runs. /api/connected
# replays the state to one reconnecting page (a capture re-announces its own), and /api/stop
# must always work.
CHANGES = ("/api/show", "/api/compare", "/api/load-version", "/api/mode", "/api/parts", "/api/view", "/api/animate",
           "/api/studio")
MAIN_LOOP_S = 0.5  # idle check and latest.json poll


class CaptureBusy(ViewerError):
    """A request that would change the viewer state arrived during a capture; maps to HTTP 409."""


@dataclass(frozen=True)
class Raw:
    """A route result sent as these bytes with this Content-Type, not as JSON."""

    body: bytes
    kind: str


class CaptureGuard:
    """Keeps the viewer state still for one capture at a time.

    A change (CHANGES) or a second capture that arrives while a capture runs is refused; a
    capture waits for the changes already in flight. The guard is not `Host.lock`: the capture's
    own host calls and the panel's GET /api/state, which the capture triggers, run meanwhile.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._capturing = False
        self._changes = 0

    @property
    def capturing(self) -> bool:
        with self._cond:
            return self._capturing

    @contextlib.contextmanager
    def change(self) -> Iterator[None]:
        with self._cond:
            if self._capturing:
                raise CaptureBusy("capture in progress; retry when it has finished")
            self._changes += 1
        try:
            yield
        finally:
            with self._cond:
                self._changes -= 1
                self._cond.notify_all()

    def begin_capture(self) -> None:
        with self._cond:
            if self._capturing:
                raise CaptureBusy("capture in progress; retry when it has finished")
            self._capturing = True
            self._cond.wait_for(lambda: self._changes == 0)

    def end_capture(self) -> None:
        with self._cond:
            self._capturing = False


@dataclass
class Loaded:
    """One version as the host shows it: record, check, panel JSON, and posed shapes."""
    version: record.Version
    check_path: str | None
    panel: dict[str, Any]
    shown: dict[str, Any]  # PN -> Rigid the part is displayed at (manifest nominal pose)
    shapes: dict[str, Any]  # PN -> posed TopoDS_Shape
    requested: str  # what the slot asked for: a vN, or `latest` to follow new builds


@dataclass
class Viewer:
    """One ocp_viewer process: a slot as one audience sees it."""
    port: int
    process: subprocess.Popen | None = None
    pushed: bool = False  # a model reached this viewer since its page last connected
    connected: bool = False  # a panel page announced itself on this viewer


@dataclass
class Slot:
    name: str
    viewers: dict[str, Viewer]  # audience -> viewer
    showing: str | None = None  # "A" or "B"

    def ports(self) -> list[int]:
        return [viewer.port for viewer in self.viewers.values()]


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
    shown = {oid: motion.rigid_from_rows(rows[oid]) for oid in rows}
    pose = motion.pose_module()
    with pose.stdout_to_stderr():
        parts = pose.load_definitions(loaded.hw, loaded.parts_dir)
    missing = sorted({p.pn for p in loaded.parts if p.pn not in parts})
    if missing:
        raise ViewerError(f"{loaded.parts_dir}: no STEP for {missing}")
    # One shape per occurrence: its PN's definition at the occurrence's built placement T = D P.
    shapes = {p.id: pose.placed(parts[p.pn].shape, shown[p.id]) for p in loaded.parts}
    return Loaded(loaded, check_path, panel, shown, shapes, version)


def port_name(slot: str, audience: str) -> str:
    """Session `ports` key of one viewer: `a`/`b` for the user's, `presenter_a`/`presenter_b`."""
    return slot if audience == "user" else f"{audience}_{slot}"


class Host:
    def __init__(self, session_file: Path, panel_port: int, ports: dict[str, int],
                 viewport: tuple[int, int] = (1440, 900), idle_timeout_min: int = 30) -> None:
        """`ports` maps every port_name() of slots a and b to its viewer port."""
        self.session_file = session_file
        self.panel_port = panel_port
        self.viewport = viewport
        self.idle_timeout_min = idle_timeout_min
        self._activity_lock = threading.Lock()
        self._last_command_at = time.monotonic()
        self._commands_active = 0
        self.slots = {name: Slot(name, {aud: Viewer(ports[port_name(name, aud)]) for aud in AUDIENCES})
                      for name in ("a", "b")}
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
        self.sync_hold = threading.Event()
        self.guard = CaptureGuard()
        self.gallery = gallery.Gallery()
        self.follow_failures: dict[str, tuple[str, str]] = {}  # version key -> (latest label, why it did not load)
        self._latest_build: Loaded | None = None  # the last `latest` load, reused while a capture holds the view

    def command_started(self) -> None:
        with self._activity_lock:
            self._commands_active += 1

    def command_finished(self) -> None:
        with self._activity_lock:
            self._commands_active -= 1
            self._last_command_at = time.monotonic()

    def idle(self, now: float | None = None) -> bool:
        if self.idle_timeout_min == 0:
            return False
        with self._activity_lock:
            return (self._commands_active == 0
                    and (time.monotonic() if now is None else now) - self._last_command_at
                    >= self.idle_timeout_min * 60)

    def _viewers(self) -> list[tuple[str, str, Viewer]]:
        return [(slot.name, aud, viewer) for slot in self.slots.values() for aud, viewer in slot.viewers.items()]

    # ------------------------------------------------------------------ lifecycle

    def start_viewers(self) -> None:
        log_dir = self.session_file.parent
        for name, aud, viewer in self._viewers():
            with (log_dir / f"viewer-{port_name(name, aud)}.log").open("w", encoding="utf-8") as log:
                viewer.process = subprocess.Popen(
                    [sys.executable, "-m", "ocp_viewer", "--host", HOST, "--port", str(viewer.port), "--theme",
                     "light", "--tree_width", str(TREE_WIDTH)],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + VIEWER_START_S
        for name, aud, viewer in self._viewers():
            while not port_open(viewer.port):
                if viewer.process.poll() is not None or time.monotonic() > deadline:
                    raise ViewerError(f"ocp_viewer {port_name(name, aud)} did not start on port {viewer.port}")

    def stop_viewers(self) -> None:
        """Terminate every running viewer at once, then kill those still up after VIEWER_STOP_S."""
        running = [v.process for _, _, v in self._viewers() if v.process is not None and v.process.poll() is None]
        for process in running:
            process.terminate()
        deadline = time.monotonic() + VIEWER_STOP_S
        for process in running:
            try:
                process.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def session(self) -> dict[str, Any]:
        user = {n: s.viewers["user"].port for n, s in self.slots.items()}
        return {"pid": os.getpid(), "panel_port": self.panel_port, "url": f"http://{HOST}:{self.panel_port}/",
                "viewer_urls": {n: f"http://{HOST}:{p}/" for n, p in user.items()},
                "ports": {"panel": self.panel_port, **{port_name(n, a): v.port for n, a, v in self._viewers()}},
                "viewer_pids": {port_name(n, a): v.process.pid if v.process else None for n, a, v in self._viewers()},
                "log": str(self.session_file.with_name("host.log")), "session": str(self.session_file),
                "idle_timeout_minutes": self.idle_timeout_min}

    # ------------------------------------------------------------------ viewer calls (hold the lock)

    def _tree(self, loaded: Loaded) -> Any:
        from ocp_tessellate import Color
        from ocp_tessellate.cad_objects import OCP_Part, OCP_PartGroup

        version = loaded.version

        def leaf(part: record.Part) -> Any:
            return OCP_Part(loaded.shapes[part.id], name=part.product, color=Color(part.colour, self.view.alpha(part.id)))

        children: list[Any] = [OCP_PartGroup([leaf(version.part(oid)) for oid in g.parts], name=g.id)
                               for g in version.groups]
        children += [leaf(p) for p in version.parts if p.group is None]
        return OCP_PartGroup(children, name=version.product_id)

    def _push(self, slot: Slot, key: str, camera: Any = None, audiences: tuple[str, ...] = AUDIENCES,
              **config: Any) -> None:
        """Show version `key` in `slot`; each viewer keeps its camera once its page holds a model."""
        from ocp_viewer import Camera, Collapse, show

        loaded = self.versions[key]
        settings = {"explode": False, "tab": "tree", **config}
        tree = self._tree(loaded)
        for audience in audiences:
            viewer = slot.viewers[audience]
            reset = camera if camera is not None else Camera.KEEP if viewer.pushed else Camera.RESET
            show(tree, port=viewer.port, reset_camera=reset, collapse=Collapse.NONE, axes=False,
                 axes0=False, grid=(False, False, False), ortho=True, progress="", **settings)
            viewer.pushed = True
        slot.showing = key
        if set(audiences) == set(AUDIENCES):  # a new show; a replay to one reconnected page is not
            self.clip = None
            if slot.name == "a":
                self.animation = self.animation_request = None
        self._apply_states(slot, audiences)

    def _config(self, slot: Slot, audiences: tuple[str, ...] = AUDIENCES, **values: Any) -> None:
        """One set_viewer_config change, sent to the slot's viewer of every audience given."""
        from ocp_viewer import set_viewer_config

        for audience in audiences:
            set_viewer_config(port=slot.viewers[audience].port, **values)

    def _apply_states(self, slot: Slot, audiences: tuple[str, ...] = AUDIENCES) -> None:
        if slot.showing is None:
            return
        version = self.versions[slot.showing].version
        states = {p.path: [1, 1] if self.view.visible(p.id) else [0, 0] for p in version.parts}
        self._config(slot, audiences, states=states)

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

    def camera(self, name: str, audience: str = "presenter") -> dict[str, Any]:
        from ocp_viewer import status

        with self.lock:
            current = status(port=self.slots[name].viewers[audience].port)
        return {k: current.get(k) for k in (*CAMERA_KEYS, "target0")}

    def set_camera(self, name: str, camera: dict[str, Any], audiences: tuple[str, ...] = AUDIENCES) -> None:
        values = {k: camera[k] for k in CAMERA_KEYS if camera.get(k) is not None}
        with self.lock:
            self._config(self.slots[name], audiences, **values)

    def user_connected(self) -> bool:
        """A user's panel tab announced itself on slot a's user viewer."""
        return self.slots["a"].viewers["user"].connected

    # ------------------------------------------------------------------ API operations

    def state(self) -> dict[str, Any]:
        """`selected` is each version key's request (`latest` or vN) and the vN it shows; `latest`
        is the vN hw/versions/latest.json names now."""
        with self.lock:
            shown = self.versions.get("A")
            return {"mode": self.mode, "active": self.active, "view": self.view.as_json(),
                    "versions": {k: v.panel for k, v in self.versions.items()},
                    "checks": {k: v.check_path for k, v in self.versions.items()},
                    "selected": {k: {"version": v.requested, "label": v.version.label,
                                     "error": self.follow_failures[k][1] if k in self.follow_failures else None}
                                 for k, v in self.versions.items()},
                    "latest": record.latest_label(shown.version.hw) if shown else None,
                    "slots": {n: {"urls": {a: f"http://{HOST}:{v.port}/" for a, v in s.viewers.items()},
                                  "showing": s.showing} for n, s in self.slots.items()},
                    "animation": self.animation}

    def show_version(self, body: dict[str, Any]) -> dict[str, Any]:
        loaded = _load(_text(body, "hw"), str(body.get("version") or "latest"), body.get("check"))
        self.gallery.open(loaded.version.hw)
        with self.lock:
            self.versions = {"A": loaded}
            self.follow_failures = {}
            self.mode, self.active = "single", "A"
            self.view = ViewState(hidden={oid for oid in self.view.hidden if oid in loaded.shapes})
            self._push_layout()
        return self.state()

    def compare(self, body: dict[str, Any]) -> dict[str, Any]:
        hw = _text(body, "hw")
        a = _load(hw, _text(body, "a"), body.get("check_a"))
        b = _load(hw, _text(body, "b"), body.get("check_b"))
        self.gallery.open(a.version.hw)
        with self.lock:
            self.versions = {"A": a, "B": b}
            self.follow_failures = {}
            self.mode, self.active, self.view = "split", "A", ViewState()
            self._push_layout()
            self._copy_camera("a", "b")
        return self.state()

    def load_version(self, body: dict[str, Any]) -> dict[str, Any]:
        """Put `version` (vN or `latest`) of the shown project into version key `slot` (A or B).

        The viewers showing that key get the new model and keep their camera; the view state
        (hidden, isolated, ghost) stays, as it does when `mode` switches A and B. Choosing the vN
        the key already shows, or `latest` while it shows that vN, keeps the loaded model and its check.
        """
        key = str(body.get("slot") or "").upper()
        if key not in ("A", "B"):
            raise ViewerError("slot must be A or B")
        version = _text(body, "version")
        with self.lock:
            shown, current = self.versions.get("A"), self.versions.get(key)
        if shown is None:
            raise ViewerError("nothing shown yet; run `viewer.py show` first")
        hw = shown.version.hw
        label, _folder, _record_snapshot = record.version_files(hw, version)
        same = current is not None and label == current.version.label
        loaded = replace(current, requested=version) if same else _load(str(hw), version, None)
        with self.lock:
            if self.versions.get("A") is None or self.versions["A"].version.hw != hw:
                raise ViewerError("another project was shown during the load; choose the version again")
            self._replace(key, loaded, push=not same)
        return self.state()

    def _replace(self, key: str, loaded: Loaded, push: bool = True) -> None:
        """Version key `key` holds `loaded`; each slot showing the key gets its model (lock held)."""
        self.versions[key] = loaded
        self.follow_failures.pop(key, None)
        if push:
            for name, shown in self._layout().items():
                if shown == key:
                    self._push(self.slots[name], key)

    def follow_latest(self) -> None:
        """Reload each version key that follows `latest` once latest.json names another vN.

        Called from the host's main loop. One load serves both keys. A build that does not load is
        reported under /api/state `selected.<key>.error` and not retried until latest.json names
        another vN. While a capture runs the push waits for the next tick, reusing the load.
        """
        with self.lock:
            following = {k: v for k, v in self.versions.items() if v.requested == "latest"}
            failed = {k: f[0] for k, f in self.follow_failures.items()}
        if not following:
            return
        hw = next(iter(following.values())).version.hw
        label = record.latest_label(hw)
        stale = {k: v for k, v in following.items() if label not in (None, v.version.label) and failed.get(k) != label}
        if not stale:
            return
        build = self._latest_build
        if build is None or build.version.hw != hw or build.version.label != label:
            try:
                build = self._latest_build = _load(str(hw), "latest", None)
            except Exception as error:  # noqa: BLE001 - reported to the panel; the host keeps serving
                with self.lock:
                    for k in stale:
                        self.follow_failures[k] = (label, f"latest is {label}, which did not load: {error}")
                return
        try:
            with self.guard.change(), self.lock:
                for k, before in stale.items():
                    if self.versions.get(k) is before:  # no show, compare, or load-version since
                        self._replace(k, build)
        except CaptureBusy:
            return

    def version_list(self) -> dict[str, Any]:
        """Every built version of the shown project (else the gallery's), newest first, and the vN
        `latest` names."""
        with self.lock:
            shown = self.versions.get("A")
        hw = shown.version.hw if shown is not None else self.gallery.project()
        return {"hw": str(hw), "latest": record.latest_label(hw), "versions": record.version_list(hw)}

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

    def move_presenter_camera(self, body: dict[str, Any]) -> dict[str, Any]:
        """A capture's measuring move: the presenter's viewer only, so the user's view stays put."""
        name = body.get("slot", "a")
        if name not in self.slots:
            raise ViewerError("slot must be a or b")
        self.set_camera(name, body, ("presenter",))
        return self.camera(name, "presenter")

    def apply_view(self, body: dict[str, Any]) -> dict[str, Any]:
        """Camera preset, explode flag, section, or isolation for a capture."""
        from ocp_viewer import Camera

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
                            self._config(slot, explode=True)
                return {"view": view, "state": self.view.as_json()}
            if view != "section":
                raise ViewerError(f"unknown view {view!r}")
            chain = motion.load_chain(loaded.version.hw, loaded.version)
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
        with self.lock:
            if self.clip is None:
                return None
            for slot in self.slots.values():
                if slot.showing:
                    self._config(slot, **self.clip)
            return dict(self.clip)

    def studio(self, body: dict[str, Any]) -> dict[str, Any]:
        """Switch the shown slots to Studio mode with the given look-dev settings.

        The next push (show, view, animate) returns the viewer to the Tree tab.
        """
        values = {f"studio_{key}": body[key] for key in STUDIO_KEYS if body.get(key) is not None}
        with self.lock:
            shown = [slot for slot in self.slots.values() if slot.showing]
            if not shown:
                raise ViewerError("nothing shown yet; run `viewer.py show` first")
            for slot in shown:
                self._config(slot, tab="studio", **values)
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

    def _plan(self, body: dict[str, Any]) -> motion.AnimationPlan | motion.CaseAnimation:
        """A one-joint sweep (`joint`, `from`, `to`) on the current record, or a motion plan `case` on the
        shown version's record snapshot, whose nominal pose the viewer displays."""
        loaded = self.versions[self._layout()["a"]]
        if body.get("case"):
            chain = motion.load_chain(loaded.version.record_dir, loaded.version)
            return motion.plan_case_animation(chain, loaded.shown, loaded.version.hw, _text(body, "case"))
        steps, seconds = int(body.get("steps") or 13), float(body.get("seconds") or 4.0)
        chain = motion.load_chain(loaded.version.hw, loaded.version)
        return motion.plan_animation(chain, loaded.shown, _text(body, "joint"), _number(body, "from"),
                                     _number(body, "to"), steps, seconds)

    def _run_animation(self, body: dict[str, Any], audiences: tuple[str, ...] = AUDIENCES) -> dict[str, Any]:
        """Send the tracks for the model slot a just received, then hold at `at` if given."""
        from ocp_viewer import Animation
        from ocp_viewer.config import session

        at = None if body.get("at") is None else _number(body, "at")
        if at is not None and not 0.0 <= at <= 1.0:
            raise ViewerError("--at must be within 0..1")
        plan = self._plan(body)
        version = self.versions[self._layout()["a"]].version
        animation = Animation()
        for track in plan.tracks:
            path = version.part(track.id).path
            animation.add_track(path, "t", list(plan.times), [list(v) for v in track.translations])
            animation.add_track(path, "q", list(plan.times), [list(v) for v in track.quaternions])
        for audience in audiences:
            port = self.slots["a"].viewers[audience].port
            # Animation.animate has no port keyword: address the viewer through the session scope.
            session.begin({"port": port})
            try:
                animation.animate(speed=1)
            finally:
                session.clear()
            if at is not None:
                animation.set_relative_time(at, port=port)
        self.animation_request = dict(body)
        self.animation = {**plan.summary(at), "keyframes": len(plan.times), "seconds": plan.times[-1],
                          "moving_parts": [version.part(t.id).ref for t in plan.tracks], "at": at}
        return self.animation

    def browser_connected(self, body: dict[str, Any]) -> dict[str, Any]:
        """A panel page (re)connected a viewer: push its slot's model again, keeping the camera.

        OCP CAD Viewer does not replay the last model to a new page, so the panel announces each
        iframe load with its slot and audience. Only that viewer is pushed; it keeps its last camera,
        or takes the other audience's, and a running animation is restored.
        """
        name, audience = body.get("slot"), body.get("audience", "user")
        if name not in self.slots or audience not in AUDIENCES:
            raise ViewerError(f"slot must be a or b and audience one of {AUDIENCES}")
        with self.lock:
            slot = self.slots[name]
            # A viewer reports a real camera only once a page has drawn on it: that is the source.
            source = next((a for a in (audience, *AUDIENCES) if slot.viewers[a].connected and slot.viewers[a].pushed),
                          None)
            slot.viewers[audience].connected = True
            key = self._layout()[name]
            if key is None or key not in self.versions:
                return {"slot": name, "audience": audience, "showing": None}
            camera = self.camera(name, source) if source else None
            replay = self.animation_request if name == "a" else None
            self._push(slot, key, audiences=(audience,))
            if camera is not None:
                self.set_camera(name, camera, (audience,))
            elif name == "b":
                self._copy_camera("a", "b", (audience,))
            if self.clip is not None:
                self._config(slot, (audience,), **self.clip)
            if replay is not None:
                self._run_animation(replay, (audience,))
        return {"slot": name, "audience": audience, "showing": key}

    # ------------------------------------------------------------------ camera sync

    def _copy_camera(self, source: str, target: str, audiences: tuple[str, ...] = AUDIENCES) -> None:
        """Slot `target` takes slot `source`'s camera, within each audience's pair."""
        if self.slots[target].showing is not None:
            for audience in audiences:
                if self.slots[source].viewers[audience].connected:
                    self.set_camera(target, self.camera(source, audience), (audience,))

    def sync_cameras(self) -> None:
        """Keep A and B on one camera in split mode, separately for each audience's pair."""
        last: dict[str, dict[str, Any] | None] = dict.fromkeys(AUDIENCES)
        quiet_until = dict.fromkeys(AUDIENCES, 0.0)
        while not self.halt.wait(SYNC_PERIOD_S):
            for audience in AUDIENCES:
                try:
                    with self.lock:
                        held = audience == "presenter" and self.sync_hold.is_set()
                        drawn = all(self.slots[n].viewers[audience].connected for n in ("a", "b"))
                        if self.mode != "split" or self.slots["b"].showing is None or held or not drawn:
                            last[audience] = None
                            continue
                        a, b = self.camera("a", audience), self.camera("b", audience)
                        if last[audience] is None or _moved(a, last[audience]):
                            self.set_camera("b", a, (audience,))
                            last[audience], quiet_until[audience] = a, time.monotonic() + SYNC_COOLDOWN_S
                        elif time.monotonic() > quiet_until[audience] and _moved(b, last[audience]):
                            self.set_camera("a", b, (audience,))
                            last[audience], quiet_until[audience] = b, time.monotonic() + SYNC_COOLDOWN_S
                except Exception:  # noqa: BLE001 - a dropped browser must not end the sync thread
                    traceback.print_exc()

    # ------------------------------------------------------------------ HTTP

    def routes(self) -> dict[tuple[str, str], Any]:
        routes = {
            ("GET", "/api/health"): lambda q, b: self.health(),
            ("GET", "/api/state"): lambda q, b: self.state(),
            ("POST", "/api/show"): lambda q, b: self.show_version(b),
            ("POST", "/api/compare"): lambda q, b: self.compare(b),
            ("GET", "/api/versions"): lambda q, b: self.version_list(),
            ("POST", "/api/load-version"): lambda q, b: self.load_version(b),
            ("POST", "/api/mode"): lambda q, b: self.set_mode(b),
            ("POST", "/api/parts"): lambda q, b: self.parts(b),
            ("POST", "/api/view"): lambda q, b: self.apply_view(b),
            ("POST", "/api/animate"): lambda q, b: self.animate(b),
            ("POST", "/api/connected"): lambda q, b: self.browser_connected(b),
            ("POST", "/api/capture"): lambda q, b: self.capture(b),
            ("POST", "/api/studio"): lambda q, b: self.studio(b),
            ("POST", "/api/stop"): lambda q, b: self.request_stop(),
            ("GET", "/api/gallery"): lambda q, b: self.gallery_index(q),
            ("POST", "/api/gallery"): lambda q, b: self.open_gallery(b),
            ("GET", gallery.FILE_ROUTE): lambda q, b: self.gallery_file(q),
        }
        return {key: self._held_for_capture(route) if key[1] in CHANGES else route for key, route in routes.items()}

    def _held_for_capture(self, route: Any) -> Any:
        def guarded(query: dict[str, Any], body: dict[str, Any]) -> Any:
            with self.guard.change():
                return route(query, body)
        return guarded

    # ------------------------------------------------------------------ preview gallery (read-only)

    def gallery_url(self, version: str) -> str:
        return f"http://{HOST}:{self.panel_port}/gallery?version={quote(version)}"

    def open_gallery(self, body: dict[str, Any]) -> dict[str, Any]:
        """Open `hw` in the gallery; answers the gallery URL and every file it lists, by section."""
        self.gallery.open(_text(body, "hw"))
        model = self.gallery.index(str(body.get("version") or "latest"), self._gallery_showing())
        return {**gallery.summary(model), "url": self.gallery_url(model["version"])}

    def gallery_index(self, query: dict[str, list[str]]) -> dict[str, Any]:
        return self.gallery.index(_query(query, "version") or "latest", self._gallery_showing())

    def gallery_file(self, query: dict[str, list[str]]) -> Raw:
        path = self.gallery.file(_query(query, "path") or "")
        return Raw(path.read_bytes(), gallery.media_type(path))

    def _gallery_showing(self) -> str | None:
        """The version label the live viewer's slot a shows, when it is of the gallery's project."""
        with self.lock:
            loaded = self.versions.get(self.slots["a"].showing or "")
            if loaded is None or loaded.version.hw != self.gallery.hw:
                return None
            return loaded.version.label

    def health(self) -> dict[str, Any]:
        """`presenter` is false once the headless browser is gone: such a host takes no capture."""
        return {"pid": os.getpid(), "presenter": self.presenter is not None and self.presenter.alive(),
                "capturing": self.guard.capturing}

    def request_stop(self) -> dict[str, Any]:
        threading.Timer(0.2, self.halt.set).start()
        return {"status": "stopping", "pid": os.getpid()}

    def capture(self, body: dict[str, Any]) -> dict[str, Any]:
        """Capture once, then seal its pixels and displayed state as an immutable version bundle."""
        if self.presenter is None:
            raise ViewerError("presenter browser is not running")
        state = self.state()
        selected = state.get("selected", {}).get("A")
        with self.lock:
            shown = self.versions.get("A")
        if not selected or not selected.get("label") or shown is None:
            raise ViewerError("nothing shown yet; run `viewer.py show` first")

        hw, label = shown.version.hw, selected["label"]
        api = record._layout()
        requested = Path(str(body["out"])) if body.get("out") else None
        view = str(body.get("view"))
        subject = view.replace(":", "-")
        viewer_state = {"mode": state["mode"], "view": state["view"], "animation": state["animation"],
                        "selected": selected}
        size = [self.viewport[0], self.viewport[1]]
        recipe = {"view": view, "viewer_state": viewer_state, "size": size}

        filename_view = view.replace(":", "-")
        subject = filename_view.lower()
        staged: Path | None = None
        try:
            if requested is None:
                existing = api.reusable(hw, "bundle.captures", {"V": label, "S": subject}, recipe,
                                        replace=bool(body.get("replace")))
                if existing is not None:
                    return {"status": "pass", "cache": "hit", "out": str(existing / f"{filename_view}.png"),
                            "version": label, "view": view, "viewer_state": viewer_state}
                staged = api.staging(hw, "bundle.captures")
                target = staged / f"{filename_view}.png"
            else:
                target = api.scratch_path(hw, requested, "--out")
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    raise ViewerError(f"{target} already exists; capture outputs are never overwritten")
            body["out"] = str(target)
        except api.LayoutError as error:
            raise ViewerError(str(error)) from error

        self.guard.begin_capture()
        try:
            job = self.presenter.submit(lambda page: capture.capture(self, page, body))
        except BaseException:
            self.guard.end_capture()
            raise
        job.add_done_callback(lambda _: self.guard.end_capture())
        result = self.presenter.result(job, CAPTURE_TIMEOUT_S, "capture")
        if staged is not None:
            metadata = {"version": label, "view": result["view"], "viewer_state": result["viewer_state"]}
            (staged / "capture.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
            try:
                published = api.publish(hw, "bundle.captures", {"V": label, "S": subject}, staged, recipe=recipe,
                                        producer="cad-viewer viewer.py capture", status=result["status"],
                                        replace=bool(body.get("replace")))
            except api.LayoutError as error:
                raise ViewerError(str(error)) from error
            result["out"] = str(published.path / f"{filename_view}.png")
            result["cache"] = "hit" if published.reused else "miss"
        return result

    def serve(self) -> None:
        """Start the viewers, the API, and the presenter; serve until /api/stop or SIGTERM.

        SIGTERM raises SystemExit from the first line on, so a host stopped at any point, even
        while its viewers start, runs the cleanup below; a second SIGTERM during it is ignored.
        """
        signal.signal(signal.SIGTERM, _exit_on_sigterm)
        serving = False
        try:
            self.start_viewers()
            self.server = make_server(self)
            threading.Thread(target=self.server.serve_forever, name="http", daemon=True).start()
            serving = True
            threading.Thread(target=self.sync_cameras, name="camera-sync", daemon=True).start()
            self.presenter = Presenter(self, f"http://{HOST}:{self.panel_port}/?audience=presenter", *self.viewport)
            self.presenter.start()
            self.presenter.result(self.presenter.submit(lambda page: None), 60.0, "presenter start")
            with self._activity_lock:
                self._last_command_at = time.monotonic()
            self.session_file.write_text(json.dumps(self.session(), indent=2), encoding="utf-8")
            while not self.halt.wait(MAIN_LOOP_S):
                if self.idle():
                    self.halt.set()
                    break
                try:
                    self.follow_latest()
                except Exception:  # noqa: BLE001 - a failed push must not end the host
                    traceback.print_exc()
        finally:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            self.halt.set()
            if self.presenter is not None:
                self.presenter.stop()
            if serving:
                self.server.shutdown()
            if self.server is not None:
                self.server.server_close()
            self.stop_viewers()
            self.session_file.unlink(missing_ok=True)

def _exit_on_sigterm(signum: int, _frame: Any) -> None:
    raise SystemExit(128 + signum)


def make_server(host: Host) -> ThreadingHTTPServer:
    """The panel page and API on host.panel_port, bound but not yet serving.

    A request is refused unless its Host names this port on 127.0.0.1 or localhost (403, DNS
    rebinding), an Origin it carries is that same origin (403, another site's page), and a POST
    body is application/json (415): a cross-origin JSON POST needs a preflight this server never
    grants. The panel's same-origin fetches and the CLI's urllib calls pass all three. The
    preview gallery's file route (a `Raw` result) answers only files `gallery.resolve` allows
    inside the open project's hw/ (403 otherwise, 404 when absent).
    """
    routes = host.routes()
    names = {f"{HOST}:{host.panel_port}", f"localhost:{host.panel_port}"}
    origins = {f"http://{name}" for name in names}

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
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, data: Any) -> None:
            self._send(status, json.dumps(data, default=str).encode(), "application/json")

        def _refusal(self, method: str) -> tuple[HTTPStatus, str] | None:
            if self.headers.get("Host") not in names:
                return HTTPStatus.FORBIDDEN, f"unexpected Host {self.headers.get('Host')!r}"
            origin = self.headers.get("Origin")
            if origin is not None and origin not in origins:
                return HTTPStatus.FORBIDDEN, f"cross-origin request from {origin!r} rejected"
            if method == "POST" and self.headers.get_content_type() != "application/json":
                return HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "POST bodies must be application/json"
            return None

        def _route(self, method: str) -> None:
            refusal = self._refusal(method)
            if refusal is not None:
                self._json(refusal[0], {"error": refusal[1]})
                return
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
                # `/api/state` and `/api/versions` are read by both the user panel and the headless
                # presenter. Their panel-page URLs differ by `audience=presenter`, so only user reads count as use.
                user_panel = (url.path not in ("/api/state", "/api/versions", "/api/connected")
                              or body.get("audience") == "user"
                              or "audience=presenter" not in (self.headers.get("Referer") or ""))
                if user_panel:
                    host.command_started()
                    try:
                        result = handler(parse_qs(url.query), body)
                    finally:
                        host.command_finished()
                else:
                    result = handler(parse_qs(url.query), body)
                if isinstance(result, Raw):
                    self._send(HTTPStatus.OK, result.body, result.kind)
                else:
                    self._json(HTTPStatus.OK, result)
            except LimitError as error:
                self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(error), "findings": error.findings})
            except CaptureBusy as error:
                self._json(HTTPStatus.CONFLICT, {"error": str(error)})
            except gallery.Forbidden as error:
                self._json(HTTPStatus.FORBIDDEN, {"error": str(error)})
            except gallery.NotFound as error:
                self._json(HTTPStatus.NOT_FOUND, {"error": str(error)})
            except (ViewerError, ValueError) as error:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            except Exception as error:  # noqa: BLE001 - report infrastructure failures to the caller
                traceback.print_exc()
                self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"{type(error).__name__}: {error}"})

        def do_GET(self) -> None:  # noqa: N802
            self._route("GET")

        def do_POST(self) -> None:  # noqa: N802
            self._route("POST")

    server = ThreadingHTTPServer((HOST, host.panel_port), Handler)
    server.daemon_threads = True
    return server


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


def _query(query: dict[str, list[str]], key: str) -> str | None:
    """The first value of one query-string parameter, None when absent."""
    values = query.get(key)
    return values[0] if values else None


def _number(body: dict[str, Any], key: str) -> float:
    value = body.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ViewerError(f"`{key}` must be a number")
    return float(value)


def run(session_file: Path, panel_port: int, ports: dict[str, int], width: int, height: int,
        idle_timeout_min: int = 30) -> int:
    Host(session_file, panel_port, ports, (width, height), idle_timeout_min).serve()
    return 0
