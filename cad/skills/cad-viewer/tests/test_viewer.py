#!/usr/bin/env python3
"""cad-viewer tests without a browser or OCP: the session lifecycle (stop, a SIGTERM while the
viewers start, a start that times out, against stand-in ocp_viewer processes), the host API's
request checks and its capture guard (stand-in ocp_viewer module and presenter), version and
part-map loading, check findings, holes, joint limits, the fan-out to both viewer pairs, and the
capture's pixel helpers.

Run: python3 -m unittest discover -s cad/skills/cad-viewer/tests -v  (needs PyYAML and Pillow)
"""

from __future__ import annotations

import hashlib
import contextlib
import importlib.util
import io
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import types
import unittest
import urllib.error
import urllib.request
from concurrent.futures import Future
from pathlib import Path
from unittest import mock

SKILL = Path(__file__).resolve().parent.parent
SCRIPTS = SKILL / "scripts"
TEMPLATE_HW = SKILL.parent.parent / "examples" / "lamp-arm" / "hw"
sys.path.insert(0, str(SCRIPTS))

from cadviewer import LimitError, ViewerError, capture, host, motion, record, session  # noqa: E402


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


viewer = load("cad_viewer_cli", SCRIPTS / "viewer.py")
PNS = tuple(f"LMP-{n:04d}" for n in range(1, 12))  # LMP-0011, the retaining ring, is placed three times
PORTS = {"a": 1001, "b": 1002, "presenter_a": 2001, "presenter_b": 2002}
# Stands in for `python -m ocp_viewer`: records its PID and process group, never opens its port.
FAKE_VIEWER = """
import os, pathlib, time
pathlib.Path(os.environ["FAKE_VIEWER_PIDS"], str(os.getpid())).write_text(str(os.getpgid(0)))
time.sleep(600)
"""


def wait_for(predicate, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.1)
    return predicate()


def make_version(hw: Path, label: str, products: dict[str, str] | None = None, latest: bool = True) -> None:
    """A schema_version 2 cad-model version folder with the files the viewer reads (no STEP or GLB content)."""
    chain = motion.load_chain(hw)
    values = chain.complete({})
    rows = {oid: rigid.rows() for oid, rigid in chain.transforms(values).items()}
    groups = {member: g.id for g in motion.pose_module().load_assembly(hw).groups for member in g.members}
    titles = {pn: record.read_yaml(hw / "parts" / pn / "part.yaml")["title"] for pn in PNS}
    products = products or {pn: f"{pn} {titles[pn]}" for pn in PNS}
    (hw / "versions").mkdir(exist_ok=True)
    folder = hw / "versions" / label
    folder.mkdir()
    (folder / "record").mkdir()
    for name in ("product.yaml", "interfaces.yaml", "assembly.yaml"):
        shutil.copyfile(hw / name, folder / "record" / name)
    shutil.copytree(hw / "parts", folder / "record" / "parts")
    (folder / "assembly.step").write_text("STEP", encoding="utf-8")
    (folder / "assembly.glb").write_text("GLB", encoding="utf-8")
    (folder / "parts").mkdir()
    for pn in PNS:
        (folder / "parts" / f"{pn}.step").write_text("STEP", encoding="utf-8")
    nodes = {oid: i for i, oid in enumerate(chain.ids, start=1)}
    (folder / "part-map.json").write_text(json.dumps({"schema_version": 2, "glb": "assembly.glb", "parts": {
        pn: {"product": name, "node_indices": [nodes[o] for o in chain.ids if chain.pn(o) == pn]}
        for pn, name in products.items()}, "occurrences": {
        oid: {"PN": chain.pn(oid), "node_indices": [i]} for oid, i in nodes.items()}}), encoding="utf-8")
    (folder / "metrics.json").write_text(json.dumps({"schema_version": 2, "label": label, "parts": {
        pn: {"volume_mm3": 1000.0 * i, "mass_g": 2.7 * i, "mass_target_g": None,
             "bbox_mm": {"min": [0, 0, 0], "max": [10 * i, 5, 5], "size": [10 * i, 5, 5]}}
        for i, pn in enumerate(PNS, start=1)}, "totals": {"volume_mm3": 28000.0, "mass_g": 75.6}}),
        encoding="utf-8")
    manifest = {"schema_version": 2, "label": label, "product_id": "lamp-arm"}
    manifest.update(occurrences={oid: {"PN": chain.pn(oid), "ref": chain.ref(oid), "group": groups.get(oid),
                                      "rest": chain.rests[oid].rows()} for oid in chain.ids},
                    pose={"transforms": rows, "motions": {oid: r.rows() for oid, r in chain.motions(values).items()}})
    files = [path.relative_to(folder).as_posix() for path in folder.rglob("*")
             if path.is_file() and path.name != "manifest.json"]
    manifest["files"] = {name: hashlib.sha256((folder / name).read_bytes()).hexdigest() for name in files}
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if latest:
        (hw / "versions" / "latest.json").write_text(json.dumps({
            "label": label, "assembly_step": f"versions/{label}/assembly.step",
            "parts": {pn: f"versions/{label}/parts/{pn}.step" for pn in PNS}, "glb": f"versions/{label}/assembly.glb",
            "metrics": f"versions/{label}/metrics.json", "part_map": f"versions/{label}/part-map.json",
            "manifest": f"versions/{label}/manifest.json"}), encoding="utf-8")


def make_attached_version(hw: Path, pose: Any, attach: list[str]) -> Path:
    """Seal the lamp record with its ring PN attached in the version manifest instead of the record joints."""
    import yaml

    data = yaml.safe_load((hw / "assembly.yaml").read_text(encoding="utf-8"))
    data["joints"] = [joint for joint in data["joints"] if joint["id"] not in {"J-010", "J-011", "J-012"}]
    (hw / "assembly.yaml").write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    assembly = pose.load_assembly(hw)
    chain = pose.build_chain([*assembly.joints, *pose.attach_joints(attach, assembly)], assembly.occurrences,
                             couplings=assembly.couplings)
    values = chain.complete({})
    transforms = chain.transforms(values)
    folder = hw / "versions" / "v9"
    (folder / "record").mkdir(parents=True)
    for name in ("product.yaml", "interfaces.yaml", "assembly.yaml"):
        shutil.copyfile(hw / name, folder / "record" / name)
    shutil.copytree(hw / "parts", folder / "record" / "parts")
    (folder / "assembly.step").write_text("STEP", encoding="utf-8")
    (folder / "assembly.glb").write_text("GLB", encoding="utf-8")
    (folder / "parts").mkdir()
    for part_pn in PNS:
        (folder / "parts" / f"{part_pn}.step").write_text("STEP", encoding="utf-8")
    occurrence_nodes = {oid: index for index, oid in enumerate(chain.ids, start=1)}
    part_map = {"schema_version": 2, "glb": "assembly.glb",
                "parts": {part_pn: {"product": f"{part_pn} {record.read_yaml(hw / 'parts' / part_pn / 'part.yaml')['title']}",
                                    "node_indices": [occurrence_nodes[oid] for oid in chain.ids
                                                     if chain.pn(oid) == part_pn]}
                          for part_pn in PNS},
                "occurrences": {oid: {"PN": chain.pn(oid), "node_indices": [index]}
                                for oid, index in occurrence_nodes.items()}}
    (folder / "part-map.json").write_text(json.dumps(part_map), encoding="utf-8")
    (folder / "metrics.json").write_text(json.dumps({"schema_version": 2, "parts": {
        part_pn: {"volume_mm3": 1000.0, "mass_g": 2.7, "mass_target_g": None,
                  "bbox_mm": {"min": [0, 0, 0], "max": [10, 5, 5], "size": [10, 5, 5]}}
        for part_pn in PNS}, "totals": {"volume_mm3": 11000.0, "mass_g": 29.7}}), encoding="utf-8")
    groups = {member: group.id for group in assembly.groups for member in group.members}
    manifest = {"schema_version": 2, "label": "v9", "product_id": "lamp-arm", "attach": attach,
                "record": {}, "manufacturing": {}, "ground": chain.root,
                "occurrences": {oid: {"PN": chain.pn(oid), "ref": chain.ref(oid), "group": groups.get(oid),
                                      "rest": chain.rests[oid].rows()} for oid in chain.ids},
                "pose": {"values": values, "transforms": {oid: transform.rows() for oid, transform in transforms.items()},
                         "motions": {oid: transform.rows() for oid, transform in chain.motions(values).items()}},
                "joints": [{"id": joint.id, "type": joint.type, "parent": joint.parent, "child": joint.child,
                            "axis": list(joint.axis), "origin": list(joint.origin), "min": joint.min,
                            "max": joint.max, "nominal": joint.nominal} for joint in chain.joints]}
    files = [path for path in folder.rglob("*") if path.is_file() and path.name != "manifest.json"]
    manifest["files"] = {path.relative_to(folder).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                         for path in files}
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (hw / "versions" / "latest.json").write_text(json.dumps({"label": "v9"}), encoding="utf-8")
    return folder


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cad-viewer-test-"))
        self.hw = self.tmp / "hw"
        shutil.copytree(TEMPLATE_HW, self.hw)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

class SessionIdentity(unittest.TestCase):
    def test_session_path_keys_project_name_and_override(self) -> None:
        state = Path("/tmp/private-state")
        project = Path("/tmp/project-a")
        other_project = Path("/tmp/project-b")
        with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(state)}, clear=True):
            same_a = session.session_path(project)
            same_b = session.session_path(project.resolve())
            other = session.session_path(other_project)
            worker_a = session.session_path(project, "worker-a")
            worker_b = session.session_path(project, "worker-b")
        self.assertEqual(same_a, same_b)
        self.assertNotEqual(same_a, other)
        self.assertNotEqual(worker_a, worker_b)
        with mock.patch.dict(os.environ, {"XDG_STATE_HOME": str(state),
                                          "CAD_VIEWER_SESSION": str(Path("/tmp/explicit.json")),
                                          "PI_SESSION_ID": "harness-session"}, clear=True):
            self.assertEqual(session.session_path(other_project, "worker"), Path("/tmp/explicit.json"))

    def test_harness_session_ids_and_explicit_names_split_hosts(self) -> None:
        project = Path("/tmp/project-a")
        with mock.patch.dict(os.environ, {"XDG_STATE_HOME": "/tmp/private-state", "PI_SESSION_ID": "omp-a"},
                             clear=True):
            omp_a = session.session_path(project)
            with mock.patch.dict(os.environ, {"PI_SESSION_ID": "omp-b"}):
                omp_b = session.session_path(project)
        self.assertNotEqual(omp_a, omp_b)
        with mock.patch.dict(os.environ, {"XDG_STATE_HOME": "/tmp/private-state",
                                          "CLAUDE_CODE_SESSION_ID": "claude-a"}, clear=True):
            claude = session.session_path(project)
        self.assertNotEqual(omp_a, claude)
        with mock.patch.dict(os.environ, {"XDG_STATE_HOME": "/tmp/private-state"}, clear=True):
            self.assertNotEqual(session.session_path(project, "worker-a"),
                                session.session_path(project, "worker-b"))


    def test_command_hw_and_working_directory_share_project_root(self) -> None:
        root = Path("/tmp/project-a")
        show = viewer.build_parser().parse_args(["show", str(root / "hw")])
        serve = viewer.build_parser().parse_args(["serve"])
        with mock.patch("pathlib.Path.cwd", return_value=root / "hw"):
            self.assertEqual(viewer.project_root(show), viewer.project_root(serve))

    def test_different_projects_never_resolve_to_the_same_host_record(self) -> None:
        state = Path(tempfile.mkdtemp(prefix="cad-viewer-isolation-"))
        try:
            a = session.session_path(state / "project-a")
            b = session.session_path(state / "project-b")
            self.assertNotEqual(a, b)
            a.parent.mkdir(parents=True)
            b.parent.mkdir(parents=True)
            a.write_text(json.dumps({"pid": 10101}), encoding="utf-8")
            b.write_text(json.dumps({"pid": 20202}), encoding="utf-8")
            self.assertEqual(session.read_session(a)["pid"], 10101)
            self.assertEqual(session.read_session(b)["pid"], 20202)
        finally:
            shutil.rmtree(state, ignore_errors=True)


class SessionLifecycle(unittest.TestCase):
    """`stop` and `serve` against real processes: stand-in ocp_viewers, never the real one."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cad-viewer-session-"))
        self.path = self.tmp / "state" / "session.json"
        self.path.parent.mkdir()
        (self.tmp / "fake" / "ocp_viewer").mkdir(parents=True)
        (self.tmp / "fake" / "ocp_viewer" / "__init__.py").write_text("", encoding="utf-8")
        (self.tmp / "fake" / "ocp_viewer" / "__main__.py").write_text(FAKE_VIEWER, encoding="utf-8")
        self.pids = self.tmp / "pids"
        self.pids.mkdir()
        self.env = {"PYTHONPATH": str(self.tmp / "fake"), "FAKE_VIEWER_PIDS": str(self.pids),
                    "CAD_VIEWER_SESSION": str(self.path)}
        self.spawned: list[subprocess.Popen] = []

    def tearDown(self) -> None:
        own_group = os.getpgid(0)
        for pid, pgid in self.viewers().items():
            if pgid != own_group:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(pgid, signal.SIGKILL)
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
        for process in self.spawned:
            if process.poll() is None:
                process.kill()
            process.wait()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def viewers(self) -> dict[int, int]:
        """PID -> process group of every stand-in viewer started so far."""
        return {int(p.name): int(p.read_text()) for p in self.pids.iterdir() if p.read_text()}

    def spawn(self, *argv: str, **options) -> subprocess.Popen:
        process = subprocess.Popen([sys.executable, *argv], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   **options)
        self.spawned.append(process)
        return process

    def test_commands_without_a_host_exit_2(self) -> None:
        with mock.patch.dict(os.environ, {"CAD_VIEWER_SESSION": str(self.tmp / "none.json")}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            code = viewer.main(["show", "hw"])
        self.assertEqual(code, 2)
        self.assertIn("no running viewer", json.loads(out.getvalue())["error"])

    def test_stop_on_a_stale_session_signals_nothing(self) -> None:
        # The host died long ago and its PID now belongs to an unrelated process; its port is closed.
        bystander = self.spawn("-c", "import time; time.sleep(60)")
        port = session.free_port()
        self.path.write_text(json.dumps({"pid": bystander.pid, "panel_port": port, "ports": {"panel": port}}))
        result = session.stop(self.path)
        self.assertEqual((result["status"], result["pid"]), ("stale", bystander.pid))
        self.assertFalse(self.path.exists())
        time.sleep(0.3)
        self.assertIsNone(bystander.poll(), "stop signalled a process that is not the viewer host")

    def test_stop_signals_no_process_that_is_not_a_viewer_host(self) -> None:
        # Something answers /api/health with its own PID but refuses /api/stop: only `ps` tells it apart.
        port = session.free_port()
        impostor = self.spawn("-c", textwrap.dedent(f"""
            import json, os
            from http.server import BaseHTTPRequestHandler, HTTPServer
            class H(BaseHTTPRequestHandler):
                def log_message(self, *a): pass
                def do_GET(self):
                    body = json.dumps({{"pid": os.getpid()}}).encode()
                    self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
                    self.wfile.write(body)
                def do_POST(self):
                    self.send_response(500); self.send_header("Content-Length", "0"); self.end_headers()
            HTTPServer(("127.0.0.1", {port}), H).serve_forever()
            """))
        self.assertTrue(wait_for(lambda: session.port_open(port), 10))
        self.path.write_text(json.dumps({"pid": impostor.pid, "panel_port": port, "ports": {"panel": port}}))
        with self.assertRaisesRegex(ViewerError, "not `viewer.py host"):
            session.stop(self.path)
        self.assertIsNone(impostor.poll())

    def test_sigterm_while_the_viewers_start_stops_them(self) -> None:
        ports = {name: session.free_port() for name in PORTS}
        hosted = self.spawn(str(SCRIPTS / "viewer.py"), "host", "--session", str(self.path),
                            "--panel-port", str(session.free_port()), "--ports", json.dumps(ports),
                            "--width", "800", "--height", "600",
                            env={**os.environ, **self.env}, start_new_session=True)
        self.assertTrue(wait_for(lambda: len(self.viewers()) == 4), "the stand-in viewers did not start")
        hosted.send_signal(signal.SIGTERM)  # the host alone, as `stop` falls back to
        self.assertEqual(hosted.wait(timeout=30), 128 + signal.SIGTERM)
        self.assertTrue(wait_for(lambda: not any(session.pid_alive(pid) for pid in self.viewers()), 10),
                        f"viewers left running: {self.viewers()}")

    def test_a_start_that_times_out_leaves_no_process(self) -> None:
        with mock.patch.dict(os.environ, self.env), mock.patch.object(session, "START_TIMEOUT_S", 5.0), \
                self.assertRaisesRegex(ViewerError, "did not answer within"):
            session.start(self.path, SCRIPTS / "viewer.py", 0, 0, 0, (800, 600))
        groups = set(self.viewers().values())
        self.assertEqual(len(groups), 1, "the stand-in viewers did not start in the host's group")
        with self.assertRaises(ProcessLookupError):  # the host and every viewer are gone
            os.killpg(groups.pop(), 0)
        self.assertFalse(self.path.exists())


class StubPresenter:
    """Runs each job on a thread of its own with no page, as the presenter thread would."""

    result = staticmethod(capture.Presenter.result)

    @staticmethod
    def alive() -> bool:
        return True

    @staticmethod
    def submit(work) -> Future:
        future: Future = Future()

        def run() -> None:
            try:
                future.set_result(work(None))
            except BaseException as error:  # noqa: BLE001 - handed to the request, as Presenter does
                future.set_exception(error)

        threading.Thread(target=run, daemon=True).start()
        return future


def api_request(port: int, method: str, route: str, body: dict | None = None,
                headers: dict[str, str] | None = None) -> tuple[int, dict]:
    """(status, JSON answer) of one request to a host's API on 127.0.0.1:`port`."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{route}", data=data, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        with error:
            return error.code, json.loads(error.read() or b"{}")


class HostIdleTimeout(unittest.TestCase):
    def test_api_commands_reset_idle_but_presenter_poll_does_not(self) -> None:
        fake = types.ModuleType("ocp_viewer")
        fake.set_viewer_config = lambda **_values: None
        patcher = mock.patch.dict(sys.modules, {"ocp_viewer": fake})
        patcher.start()
        self.addCleanup(patcher.stop)
        temp = Path(tempfile.mkdtemp(prefix="cad-viewer-idle-"))
        self.addCleanup(shutil.rmtree, temp, True)
        port = session.free_port()
        viewer_host = host.Host(temp / "session.json", port, PORTS, idle_timeout_min=1)
        server = host.make_server(viewer_host)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        viewer_host._last_command_at = time.monotonic() - 61
        self.assertTrue(viewer_host.idle())
        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/state",
                                         headers={"Referer": f"http://127.0.0.1:{port}/?audience=presenter"})
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
        self.assertTrue(viewer_host.idle())
        presenter = {"Referer": f"http://127.0.0.1:{port}/?audience=presenter"}
        api_request(port, "GET", "/api/versions", headers=presenter)  # the presenter panel's version list
        self.assertTrue(viewer_host.idle())

        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/state",
                                         headers={"Referer": f"http://127.0.0.1:{port}/?audience=user"})
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)

    def test_zero_disables_idle_expiry(self) -> None:
        viewer_host = host.Host(Path("/nonexistent/session.json"), 1000, PORTS, idle_timeout_min=0)
        self.assertFalse(viewer_host.idle(now=time.monotonic() + 1_000_000))



class HostApi(unittest.TestCase):
    """The host's HTTP surface on a real loopback server: ocp_viewer and the presenter are stand-ins."""

    def setUp(self) -> None:
        self.calls: list[tuple[int, dict]] = []
        fake = types.ModuleType("ocp_viewer")
        fake.Camera = types.SimpleNamespace(ISO="ISO", FRONT="FRONT", RIGHT="RIGHT", TOP="TOP", RESET="RESET")
        fake.Collapse = None
        fake.show = lambda *_args, **_kwargs: None
        fake.set_viewer_config = lambda port=None, **values: self.calls.append((port, values))
        patcher = mock.patch.dict(sys.modules, {"ocp_viewer": fake})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.tmp = Path(tempfile.mkdtemp(prefix="cad-viewer-api-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.hw = self.tmp / "hw"
        shutil.copytree(TEMPLATE_HW, self.hw)
        make_version(self.hw, "v1")
        self.port = session.free_port()
        self.host = host.Host(self.tmp / "session.json", self.port, PORTS)
        version = record.load_version(self.hw)
        self.host.gallery.open(self.hw)
        self.host.versions["A"] = host.Loaded(version, None, record.panel_model(version, None), {}, {}, "v1")
        self.host.slots["a"].showing = "A"
        self.host.presenter = StubPresenter()
        server = host.make_server(self.host)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def request(self, method: str, route: str, body: dict | None = None,
                headers: dict[str, str] | None = None) -> tuple[int, dict]:
        return api_request(self.port, method, route, body, headers)

    def test_a_change_during_a_capture_is_refused_and_state_still_answers(self) -> None:
        self.host.gallery.open(self.hw)
        self.host.versions["A"].panel["product_id"] = "lamp-arm"
        started, release = threading.Event(), threading.Event()
        def slow_capture(_host, _page, body: dict) -> dict:
            started.set()
            release.wait(10)
            (Path(body["out"]).parent / f"{body['view'].replace(':', '-')}.png").write_bytes(b"PNG")
            return {"status": "pass", "view": body["view"], "viewer_state": {"mode": "single"},
                    "version": "v1", "viewport": [1440, 900], "cameras": {}}

        answers: dict[str, tuple[int, dict]] = {}
        with mock.patch.object(capture, "capture", slow_capture):
            worker = threading.Thread(target=lambda: answers.update(
                capture=self.request("POST", "/api/capture", {"view": "section"})))
            worker.start()
            self.assertTrue(started.wait(5))
            self.assertEqual(self.request("POST", "/api/parts", {"action": "hide", "target": "LMP-0002"})[0], 409)
            self.assertEqual(self.request("POST", "/api/studio", {"environment": "studio"})[0], 409)
            self.assertEqual(self.request("POST", "/api/capture", {"view": "iso"})[0], 409)
            self.assertEqual(self.request("GET", "/api/state")[0], 200)  # the panel refresh a capture triggers
            self.assertTrue(self.request("GET", "/api/health")[1]["capturing"])
            self.assertEqual(self.calls, [], "a refused request reached a viewer")
            release.set()
            worker.join(10)
        self.assertEqual(answers["capture"][0], 200)
        self.assertIn("section.png", answers["capture"][1]["out"])
        self.assertEqual(self.request("POST", "/api/studio", {"environment": "studio"})[0], 200)
        self.host.versions["A"].panel["product_id"] = "lamp-arm"

    def test_capture_reuses_and_publishes_a_versioned_bundle(self) -> None:
        hw = self.hw
        self.host.versions["A"].requested = "v1"
        self.host.versions["A"].panel["product_id"] = "lamp-arm"
        def fake_capture(_host, _page, body):
            Path(body["out"]).write_bytes(b"PNG")
            return {"status": "pass", "view": body["view"], "viewer_state": {"mode": "single"},
                    "version": "v1", "viewport": [1440, 900], "cameras": {}}

        api = record._layout()
        with mock.patch.object(capture, "capture", fake_capture), \
             mock.patch.object(self.host.presenter, "submit", side_effect=lambda work: StubPresenter.submit(work)), \
             mock.patch.object(api, "reusable", wraps=api.reusable) as reusable_mock, \
             mock.patch.object(api, "publish", wraps=api.publish) as publish_mock:
            first = self.host.capture({"view": "iso", "out": None})
            second = self.host.capture({"view": "iso", "out": None})
        self.assertEqual((first["cache"], second["cache"]), ("miss", "hit"))
        self.assertEqual(reusable_mock.call_count, 2)
        self.assertEqual(publish_mock.call_count, 1)
        bundle_path = hw / "captures" / "v1" / "iso"
        self.assertEqual(api.verify(bundle_path), [])
        self.assertEqual((bundle_path / "iso.png").read_bytes(), b"PNG")
        metadata = json.loads((bundle_path / "capture.json").read_text(encoding="utf-8"))
        self.assertEqual((metadata["version"], metadata["view"]), ("v1", "iso"))
        model = self.host.gallery.index("v1")
        self.assertEqual(model["sections"][1]["tiles"][0]["title"], "iso")

    def test_capture_explicit_scratch_output_is_never_overwritten(self) -> None:
        hw = self.hw
        self.host.versions["A"].requested = "v1"
        output = hw.parent / ".cad-work" / "test-viewer-capture-no-overwrite-3.png"
        body = {"view": "iso", "out": str(output)}

        def fake_capture(_host, _page, request):
            Path(request["out"]).write_bytes(b"new")
            return {"status": "pass", "view": request["view"], "viewer_state": {}}

        with mock.patch.object(capture, "capture", fake_capture):
            self.host.capture(body)
            output.write_bytes(b"keep")
            with self.assertRaisesRegex(ViewerError, "capture outputs are never overwritten"):
                self.host.capture(body)
            self.assertEqual(output.read_bytes(), b"keep")

    def test_requests_from_another_site_are_refused(self) -> None:
        body = {"environment": "studio"}
        self.assertEqual(self.request("POST", "/api/studio", body, {"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.request("POST", "/api/studio", body, {"Content-Type": "text/plain"})[0], 415)
        rebound = {"Host": f"evil.example:{self.port}", "Origin": f"http://evil.example:{self.port}"}
        self.assertEqual(self.request("GET", "/api/state", headers=rebound)[0], 403)
        self.assertEqual(self.request("POST", "/api/stop", {}, rebound)[0], 403)
        self.assertFalse(self.host.halt.wait(0.5))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.request("POST", "/api/studio", body, {"Origin": f"http://127.0.0.1:{self.port}"})[0], 200)
        self.assertEqual(self.request("POST", "/api/studio", body, {"Host": f"localhost:{self.port}"})[0], 200)
        self.assertEqual(self.request("POST", "/api/studio", body)[0], 200)  # the CLI sends no Origin

    def test_capture_refuses_when_the_presenter_is_not_running(self) -> None:
        self.host.presenter = None
        status, answer = self.request("POST", "/api/capture", {"view": "iso"})
        self.assertEqual(status, 400)
        self.assertIn("presenter browser is not running", answer["error"])

    def test_capture_target_validates_outputs(self) -> None:
        (self.tmp / "elsewhere.png").write_bytes(b"")
        (self.tmp / "link.png").symlink_to(self.tmp / "elsewhere.png")
        for out in ("relative.png", str(self.tmp / ".zshrc"), str(self.tmp / "link.png"), str(self.tmp)):
            with self.subTest(out=out), self.assertRaises(ViewerError):
                capture.capture_target(out)
        self.assertEqual(capture.capture_target(str(self.tmp / "shot.PNG")), self.tmp / "shot.PNG")


class PartMapLoading(Fixture):
    def test_part_map_products_keyed_by_pn(self) -> None:
        make_version(self.hw, "v1")
        products = record.load_part_map(self.hw / "versions" / "v1" / "part-map.json")
        self.assertEqual(products["LMP-0002"], "LMP-0002 Lower link")
        self.assertEqual(sorted(products), list(PNS))

    def test_product_not_starting_with_pn_is_rejected(self) -> None:
        make_version(self.hw, "v1", products={"LMP-0002": "LMP-0003 Upper link"})
        with self.assertRaisesRegex(ViewerError, "does not start with LMP-0002"):
            record.load_part_map(self.hw / "versions" / "v1" / "part-map.json")

    def test_empty_or_malformed_part_map_is_rejected(self) -> None:
        path = self.tmp / "part-map.json"
        for data in ({}, {"parts": {}}, {"parts": {"LMP-0001": {"nodes": []}}}, []):
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ViewerError, msg=data):
                record.load_part_map(path)

    def test_version_tree_paths_groups_and_colours(self) -> None:
        make_version(self.hw, "v1")
        version = record.load_version(self.hw, "latest")
        self.assertEqual((version.label, version.product_id), ("v1", "lamp-arm"))
        self.assertEqual([g.id for g in version.groups], ["base_sub", "arm_sub"])
        lower = version.part("LMP-0002")
        self.assertEqual(lower.path, "/lamp-arm/arm_sub/LMP-0002 Lower link")
        # Colours are cad-render's rule for material AND finish: machined, not anodised, aluminium.
        rules = json.loads((SKILL.parent / "cad-render" / "assets" / "materials.json").read_text(encoding="utf-8"))
        colour = {r["id"]: r["pbr"]["color"] for r in rules["rules"]}
        self.assertEqual(lower.colour, colour["aluminium-machined"])
        self.assertEqual(version.part("LMP-0001").colour, colour["petg"])
        self.assertEqual(record.colour_for("Unobtainium", ""), rules["default"]["pbr"]["color"])
        self.assertEqual(version.targets("base_sub"), ("LMP-0001", "LMP-0008"))
        with self.assertRaises(ViewerError):
            version.targets("LMP-9999")

    def test_older_label_resolves_through_the_documented_layout(self) -> None:
        make_version(self.hw, "v1", latest=False)
        make_version(self.hw, "v2")
        self.assertEqual(record.load_version(self.hw, "v1").label, "v1")
        with self.assertRaisesRegex(ViewerError, "missing"):
            record.load_version(self.hw, "v7")
        with self.assertRaisesRegex(
                ViewerError, "does not match"):
            record.load_version(self.hw, "../v1")

    def test_no_build_yet(self) -> None:
        with self.assertRaisesRegex(ViewerError, "no built version"):
            record.load_version(self.hw, "latest")


class CheckFindings(Fixture):
    CHECK = {
        "status": "fail", "label": "v1", "pose": "nominal", "blocking_failures": ["interference"], "warnings": [],
        "checks": {
            "connection": {"status": "pass", "blocking": True, "parts": {
                "LMP-0001": {"status": "floating", "nearest": "LMP-0005", "distance_mm": 0.108,
                             "joint_connected": True, "ok": True},
                "LMP-0004": {"status": "disconnected", "nearest": "LMP-0007", "distance_mm": 3.2,
                             "joint_connected": False, "ok": False},
                "LMP-0002": {"status": "touching", "nearest": "LMP-0006", "distance_mm": 0.0, "ok": True}}},
            "interference": {"status": "fail", "blocking": True, "pairs": [
                {"pair": ["LMP-0002", "LMP-0003"], "interference_mm3": 4.5, "ok": False}], "joint_pairs": []},
            "slivers_tolerances": {"status": "warn", "blocking": False, "parts": {
                "LMP-0003": {"sliver_faces": 2, "max_tolerance_mm": 0.02, "ok": False}}},
        }}

    def test_connection_and_pair_findings_per_part(self) -> None:
        found = record.part_findings(self.CHECK)
        self.assertEqual(found["LMP-0001"], [{"check": "connection", "severity": "warn",
                                              "message": "touches no other part; 0.108 mm from LMP-0005 (joint-connected)"}])
        self.assertEqual(found["LMP-0004"][0]["severity"], "fail")
        self.assertIn("interferes with LMP-0003: 4.500 mm3", [f["message"] for f in found["LMP-0002"]])
        self.assertEqual(found["LMP-0003"][-1]["severity"], "warn")
        self.assertNotIn("connection", [f["check"] for f in found.get("LMP-0002", [])])

    def test_panel_rejects_a_check_for_another_version(self) -> None:
        make_version(self.hw, "v2")
        version = record.load_version(self.hw)
        with self.assertRaisesRegex(ViewerError, "is for v1, not v2"):
            record.panel_model(version, self.CHECK)
        panel = record.panel_model(version, {**self.CHECK, "label": "v2"})
        # make_version gives the i-th part a 10*i mm box from the origin, so the union spans the largest.
        self.assertEqual(panel["totals"]["bbox_mm"]["size"], [10 * len(PNS), 5, 5])
        self.assertEqual(panel["check"]["blocking_failures"], ["interference"])


class Holes(Fixture):
    OVERLAY = json.loads((SKILL / "tests" / "fixtures" / "metrics-holes.json").read_text(encoding="utf-8"))

    def with_holes(self) -> record.Version:
        make_version(self.hw, "v1")
        path = self.hw / "versions" / "v1" / "metrics.json"
        metrics = json.loads(path.read_text(encoding="utf-8"))
        for pn, extra in self.OVERLAY["parts"].items():
            metrics["parts"][pn].update(extra)
        path.write_text(json.dumps(metrics), encoding="utf-8")
        manifest = path.parent / "manifest.json"
        data = json.loads(manifest.read_text(encoding="utf-8"))
        data["files"]["metrics.json"] = hashlib.sha256(path.read_bytes()).hexdigest()
        manifest.write_text(json.dumps(data), encoding="utf-8")
        return record.load_version(self.hw)

    def test_holes_per_part_keep_order_through_and_depth(self) -> None:
        parts = {p["pn"]: p for p in record.panel_model(self.with_holes(), None)["parts"]}
        self.assertEqual(parts["LMP-0001"]["metrics"]["holes"], [
            {"id": "H1", "diameter_mm": 3.4, "through": True, "depth_mm": 16.0},
            {"id": "H2", "diameter_mm": 5.0, "through": False, "depth_mm": 13.5}])
        self.assertEqual([h["id"] for h in parts["LMP-0002"]["metrics"]["holes"]], ["H1", "H2"])
        self.assertEqual(parts["LMP-0003"]["metrics"]["holes"], [])

    def test_a_missing_field_is_none_listed(self) -> None:
        make_version(self.hw, "v1")
        panel = record.panel_model(record.load_version(self.hw), None)
        self.assertTrue(all(p["metrics"]["holes"] == [] for p in panel["parts"]))

    def test_a_malformed_hole_is_a_contract_error(self) -> None:
        for bad in ({"holes": {"H1": 5.0}}, {"holes": [{"id": "H1", "diameter_mm": 5.0}]},
                    {"holes": [{"id": "H1", "diameter_mm": 0, "through": True}]}):
            with self.subTest(bad=bad), self.assertRaisesRegex(ViewerError, "holes"):
                record.holes("LMP-0002", bad["holes"])


class AnimateAttached(Fixture):
    def test_manifest_attachment_moves_with_parent_and_is_available_for_sections(self) -> None:
        make_attached_version(self.hw, motion.pose_module(), ["@ring-base=LMP-0005", "@ring-elbow=LMP-0006",
                                                              "@ring-head=LMP-0007"])
        version = record.load_version(self.hw)
        chain = motion.load_chain(version.record_dir, version)
        shown = {oid: motion.rigid_from_rows(rows) for oid, rows in version.nominal_rows().items()}
        plan = motion.plan_animation(chain, shown, "J-001", 0.0, 80.0, steps=3)
        ring_track = next(track for track in plan.tracks if track.id == "ring-base")
        self.assertNotEqual(ring_track.quaternions[0], ring_track.quaternions[-1])
        self.assertEqual(motion.section_plane(chain, shown, "J-001")["joint"], "J-001")


class AnimateLimits(Fixture):
    def setUp(self) -> None:
        super().setUp()
        self.chain = motion.load_chain(self.hw)
        self.shown = self.chain.transforms(self.chain.complete({}))

    def test_values_outside_the_joint_limits_are_rejected(self) -> None:
        for start, end in ((-130.0, 0.0), (-120.0, 5.0)):
            with self.assertRaises(LimitError) as caught:
                motion.plan_animation(self.chain, self.shown, "J-002", start, end)
            finding = caught.exception.findings[0]
            self.assertEqual((finding["check"], finding["joint"], finding["min"], finding["max"]),
                             ("joint_limit", "J-002", -120.0, 0.0))

    def test_fixed_unknown_and_degenerate_requests(self) -> None:
        with self.assertRaisesRegex(ViewerError, "fixed joint"):
            motion.plan_animation(self.chain, self.shown, "J-004", 0.0, 0.0)
        with self.assertRaises(ViewerError):
            motion.plan_animation(self.chain, self.shown, "J-099", 0.0, 1.0)
        with self.assertRaisesRegex(ViewerError, "steps"):
            motion.plan_animation(self.chain, self.shown, "J-002", -90.0, 0.0, steps=1)
        with self.assertRaises(ViewerError):
            motion.plan_animation(self.chain, self.shown, "J-002", math.nan, 0.0)

    def test_tracks_move_only_the_parts_beyond_the_joint(self) -> None:
        plan = motion.plan_animation(self.chain, self.shown, "J-002", -120.0, 0.0, steps=5)
        self.assertEqual(sorted(t.id for t in plan.tracks),
                         ["LMP-0003", "LMP-0004", "LMP-0007", "LMP-0009", "LMP-0010", "ring-head"])
        self.assertEqual(plan.values, (-120.0, -90.0, -60.0, -30.0, 0.0))
        upper = next(t for t in plan.tracks if t.id == "LMP-0003")
        x, y, z, w = upper.quaternions[3]  # -30 deg is the nominal pose: no motion from the shown pose
        self.assertAlmostEqual(w, 1.0, places=9)
        self.assertAlmostEqual(math.degrees(2 * math.acos(min(1.0, abs(upper.quaternions[0][3])))), 90.0, places=6)
        self.assertEqual(plan.value_at(0.5), -60.0)

    def test_section_plane_runs_through_the_elbow_axis(self) -> None:
        plane = motion.section_plane(self.chain, self.shown, "J-002")
        self.assertEqual([round(v, 9) for v in plane["point"]], [160.0, 0.0, 40.0])
        self.assertEqual([round(abs(v), 9) for v in plane["normal"]], [1.0, 0.0, 0.0])
        self.assertAlmostEqual(sum(a * b for a, b in zip(plane["normal"], plane["axis"])), 0.0)


class AnimateCase(Fixture):
    """`animate --case`: a cad-motion motion plan played with every driver it moves."""

    def setUp(self) -> None:
        super().setUp()
        self.chain = motion.load_chain(self.hw)
        self.shown = self.chain.transforms(self.chain.complete({}))

    def test_the_default_plan_drives_all_three_joints_at_its_fps(self) -> None:
        clip = motion.plan_case_animation(self.chain, self.shown, self.hw, "default")
        self.assertEqual((clip.case, clip.fps, len(clip.times), clip.coverage), ("default", 30, 179, "pass"))
        self.assertEqual(clip.drivers, ("J-001", "J-002", "J-003"))
        self.assertAlmostEqual(clip.times[-1], 178 / 30)
        self.assertIn("ring-head", {t.id for t in clip.tracks})
        self.assertTrue(all(len(t.translations) == 179 for t in clip.tracks))
        held = clip.summary(1.0)
        self.assertEqual((held["frame_at"], held["settings_at"]), (178, {"J-001": 0.0, "J-002": -30.0, "J-003": 0.0}))

    def test_an_authored_case_with_a_fixed_joint_target_is_a_usage_error(self) -> None:
        case = self.hw / "motion" / "cases" / "ring" / "plan.yaml"
        case.parent.mkdir(parents=True)
        case.write_text("schema: 1\nsegments:\n  - {id: spin, to: {J-010: 5}}\n", encoding="utf-8")
        with self.assertRaisesRegex(ViewerError, "J-010 is a fixed joint"):
            motion.plan_case_animation(self.chain, self.shown, self.hw, "ring")

    def test_animate_takes_a_joint_sweep_or_a_case_not_both(self) -> None:
        parser = viewer.build_parser()
        self.assertEqual(viewer.request_body(parser.parse_args(["animate", "--case", "default"])),
                         ("POST", "/api/animate", {"case": "default", "at": None}))
        with self.assertRaisesRegex(ViewerError, "go with --joint"):
            viewer.request_body(parser.parse_args(["animate", "--case", "default", "--from", "0"]))
        with self.assertRaisesRegex(ViewerError, "needs --from and --to"):
            viewer.request_body(parser.parse_args(["animate", "--joint", "J-002"]))


class AnimateCoupled(Fixture):
    """The head joint J-003 follows the elbow J-002 at a quarter of its angle (cad-motion coupling.py)."""

    def setUp(self) -> None:
        super().setUp()
        path = self.hw / "assembly.yaml"
        head = "    min: -45\n    max: 45\n    nominal: 0\n"
        text = path.read_text(encoding="utf-8")
        self.assertIn(head, text)
        path.write_text(text.replace(head, "    min: -45\n    max: 45\n"
                                           "    coupling: {type: linear, driver: J-002, ratio: 0.25}\n"), encoding="utf-8")
        self.chain = motion.load_chain(self.hw)
        self.shown = self.chain.transforms(self.chain.complete({}))

    def test_a_coupled_joint_is_animated_through_its_driver(self) -> None:
        with self.assertRaisesRegex(ViewerError, r"J-003 follows J-002 \(linear ratio 0.25 offset 0\); animate its "
                                                 r"driver, an independent joint: \['J-001', 'J-002'\]"):
            motion.plan_animation(self.chain, self.shown, "J-003", 0.0, 10.0)

    def test_the_driver_moves_the_coupled_joint_with_it(self) -> None:
        plan = motion.plan_animation(self.chain, self.shown, "J-002", -120.0, 0.0, steps=5)
        tracks = {t.id: t for t in plan.tracks}

        def turned(track_id: str, key: int) -> float:
            return math.degrees(2 * math.acos(min(1.0, abs(tracks[track_id].quaternions[key][3]))))

        # Both joints turn about Y. Shown at J-002 -30 and J-003 -7.5; at J-002 -120 the upper link has turned
        # 90 degrees from it and the head, also carried by J-003 = -30, 90 + 22.5.
        self.assertAlmostEqual(turned("LMP-0003", 0), 90.0, places=6)
        self.assertAlmostEqual(turned("LMP-0004", 0), 112.5, places=6)
        self.assertAlmostEqual(turned("LMP-0004", 3), 0.0, places=6)  # -30 is the shown (nominal) pose


class ViewerPairs(unittest.TestCase):
    """Every host change reaches the user's and the presenter's viewer; a capture's measuring moves
    reach the presenter only. ocp_viewer is replaced by a module that records each call's port."""

    def setUp(self) -> None:
        self.calls: list[tuple[int, dict]] = []
        fake = types.ModuleType("ocp_viewer")
        fake.set_viewer_config = lambda port=None, **values: self.calls.append((port, values))
        fake.status = lambda port=None: {"position": [float(port), 0.0, 0.0], "quaternion": [0.0, 0.0, 0.0, 1.0],
                                         "target": [0.0, 0.0, 0.0], "zoom": 1.0}
        patcher = mock.patch.dict(sys.modules, {"ocp_viewer": fake})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.host = host.Host(Path("/nonexistent/session.json"), 1000, PORTS)

    def ports(self) -> list[int]:
        return sorted(port for port, _ in self.calls)

    def test_one_change_reaches_both_pairs(self) -> None:
        self.host.slots["a"].showing = "A"
        self.host.studio({"environment": "studio"})
        self.assertEqual(self.ports(), [1001, 2001])
        self.calls.clear()
        self.host.set_camera("a", {"zoom": 2.0})
        self.assertEqual(self.ports(), [1001, 2001])
        self.assertEqual(self.calls[0][1], {"zoom": 2.0})

    def test_a_measuring_move_reaches_only_the_presenter(self) -> None:
        camera = self.host.move_presenter_camera({"slot": "a", "zoom": 3.0})
        self.assertEqual(self.ports(), [2001])
        self.assertEqual(camera["position"], [2001.0, 0.0, 0.0])

    def test_a_to_b_copies_stay_within_each_pair_and_skip_a_pair_without_a_page(self) -> None:
        self.host.slots["b"].showing = "B"
        for slot in self.host.slots.values():
            slot.viewers["presenter"].connected = True
        self.host._copy_camera("a", "b")
        self.assertEqual([(p, v["position"]) for p, v in self.calls], [(2002, [2001.0, 0.0, 0.0])])
        self.calls.clear()
        self.host.slots["a"].viewers["user"].connected = True
        self.host._copy_camera("a", "b")
        self.assertEqual(sorted((p, v["position"][0]) for p, v in self.calls), [(1002, 1001.0), (2002, 2001.0)])


def png(size: tuple[int, int], backdrop: tuple[int, int, int], rects: list[tuple[tuple[int, ...], tuple[int, ...]]]) -> bytes:
    """A synthetic canvas shot: `rects` are inclusive (x0, y0, x1, y1) boxes painted over the backdrop."""
    from PIL import Image, ImageDraw

    image = Image.new("RGB", size, backdrop)
    draw = ImageDraw.Draw(image)
    for box, colour in rects:
        draw.rectangle(box, fill=colour)
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


@unittest.skipUnless(importlib.util.find_spec("PIL"), "Pillow not installed")
class PixelHelpers(unittest.TestCase):
    BACKDROP = (240, 240, 240)
    GIZMO = ((10, 250, 60, 290), (200, 30, 30))  # inside the bottom-left GIZMO_PX square

    def test_content_box_is_the_scene_without_the_axes_gizmo(self) -> None:
        shot = png((400, 300), self.BACKDROP, [((100, 80, 199, 149), (60, 64, 70)), self.GIZMO])
        self.assertEqual(capture.content_box(shot), (100, 80, 200, 150))

    def test_a_frame_of_backdrop_gizmo_and_faint_noise_is_blank(self) -> None:
        faint = ((150, 100, 250, 200), (250, 250, 250))  # within BACKGROUND_DELTA of the backdrop
        self.assertIsNone(capture.content_box(png((400, 300), self.BACKDROP, [self.GIZMO, faint])))

    def test_free_area_clears_the_toolbar_and_a_tall_tree(self) -> None:
        toolbar = (0, 0, 800, 40)
        margin = capture.MARGIN_PX
        self.assertEqual(capture.free_area((800, 600), [toolbar, (0, 40, 300, 500)]),
                         (300 + margin, 40 + margin, 800 - margin, 600 - margin))
        # A collapsed tree ends in the upper third: it widens the top band instead.
        self.assertEqual(capture.free_area((800, 600), [toolbar, (0, 40, 300, 120)]),
                         (margin, 120 + margin, 800 - margin, 600 - margin))
        self.assertEqual(capture.free_area((800, 600), []), (margin, margin, 800 - margin, 600 - margin))


class VersionList(Fixture):
    def test_every_version_folder_newest_first_with_build_time_and_part_count(self) -> None:
        for label in ("v1", "v2", "v10"):
            make_version(self.hw, label)
        version_manifest = self.hw / "versions" / "v2" / "manifest.json"
        data = json.loads(version_manifest.read_text(encoding="utf-8"))
        updated = {**data, "created_utc": "2026-10-28T09:15:00Z"}
        version_manifest.write_text(json.dumps(updated), encoding="utf-8")
        (self.hw / "versions" / "v3").mkdir()
        (self.hw / "versions" / "v3" / "manifest.json").write_text(json.dumps({"schema_version": 2, "label": "v3", "files": {}}))
        (self.hw / "versions" / ".v11-partial").mkdir()
        listed = record.version_list(self.hw)
        self.assertEqual([entry["label"] for entry in listed], ["v10", "v3", "v2", "v1"])
        v2 = next(entry for entry in listed if entry["label"] == "v2")
        self.assertEqual(v2["built_utc"], "2026-10-28T09:15:00Z")
        self.assertEqual(v2["parts"], len(data["occurrences"]))
        self.assertEqual(v2["previews"], {"renders": [], "captures": [], "drawings": []})
        self.assertRegex(listed[0]["built_utc"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(record.latest_label(self.hw), "v10")

    def test_latest_label_is_none_without_a_readable_latest_json(self) -> None:
        self.assertIsNone(record.latest_label(self.hw))
        make_version(self.hw, "v1")
        latest = self.hw / "versions" / "latest.json"
        for text in ("{", '{"label": "newest"}', "[]"):
            with self.subTest(text=text):
                latest.write_text(text, encoding="utf-8")
                self.assertIsNone(record.latest_label(self.hw))

    def test_show_follows_latest_unless_a_version_is_named(self) -> None:
        for argv, version in ((["show", str(self.hw)], "latest"), (["show", str(self.hw), "--version", "v2"], "v2")):
            with self.subTest(argv=argv):
                self.assertEqual(viewer.request_body(viewer.build_parser().parse_args(argv))[2]["version"], version)


class HostVersions(Fixture):
    """load-version, the selection /api/state reports, and keys on `latest` following new builds:
    real version folders, a loader without STEP shapes, and a push stand-in that records each model."""

    def setUp(self) -> None:
        super().setUp()
        for label in ("v1", "v2", "v3"):
            make_version(self.hw, label)
        self.loads: list[str] = []
        self.pushes: list[tuple[str, str]] = []
        self.failing: set[str] = set()

        def load(hw: str, version: str, check: str | None) -> host.Loaded:
            loaded = record.load_version(Path(hw), version)
            self.loads.append(loaded.label)
            if loaded.label in self.failing:
                raise ViewerError(f"{loaded.parts_dir}: no STEP for ['LMP-0001']")
            return host.Loaded(loaded, check, record.panel_model(loaded, None), {},
                               {p.id: p.id for p in loaded.parts}, version)

        def push(viewer_host: host.Host, slot: host.Slot, key: str, *_args, **_config) -> None:
            slot.showing = key
            self.pushes.append((slot.name, viewer_host.versions[key].version.label))

        for patcher in (mock.patch.object(host, "_load", load), mock.patch.object(host.Host, "_push", push)):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.host = host.Host(self.tmp / "session.json", session.free_port(), PORTS)
        server = host.make_server(self.host)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def request(self, method: str, route: str, body: dict | None = None) -> tuple[int, dict]:
        return api_request(self.host.panel_port, method, route, body)

    def selected(self) -> dict[str, tuple[str, str]]:
        state = self.request("GET", "/api/state")[1]
        return {key: (entry["version"], entry["label"]) for key, entry in state["selected"].items()}

    def test_the_versions_route_lists_the_shown_project(self) -> None:
        self.assertEqual(self.request("GET", "/api/versions")[0], 400)  # nothing shown or opened yet
        self.host.show_version({"hw": str(self.hw)})
        status, answer = self.request("GET", "/api/versions")
        self.assertEqual(status, 200)
        self.assertEqual((answer["hw"], answer["latest"]), (str(self.hw.resolve()), "v3"))
        self.assertEqual([entry["label"] for entry in answer["versions"]], ["v3", "v2", "v1"])

    def test_load_version_switches_the_key_and_state_reports_request_and_label(self) -> None:
        self.assertEqual(self.request("POST", "/api/show", {"hw": str(self.hw), "version": "latest"})[0], 200)
        self.assertEqual(self.selected(), {"A": ("latest", "v3")})
        status, answer = self.request("POST", "/api/load-version", {"slot": "A", "version": "v1"})
        self.assertEqual(status, 200)
        self.assertEqual(answer["selected"]["A"], {"version": "v1", "label": "v1", "error": None})
        self.assertEqual(answer["versions"]["A"]["label"], "v1")
        self.assertEqual(self.request("POST", "/api/load-version", {"slot": "a", "version": "v3"})[0], 200)
        self.assertEqual(self.pushes, [("a", "v3"), ("a", "v1"), ("a", "v3")])
        # latest names the vN already shown: the model and its check stay, only the request changes
        loads = len(self.loads)
        self.assertEqual(self.request("POST", "/api/load-version", {"slot": "A", "version": "latest"})[0], 200)
        self.assertEqual((len(self.loads), len(self.pushes)), (loads, 3))
        self.assertEqual(self.selected(), {"A": ("latest", "v3")})

    def test_a_refused_load_leaves_the_key_as_it_was(self) -> None:
        self.assertEqual(self.request("POST", "/api/load-version", {"slot": "A", "version": "v1"})[0], 400)
        self.host.show_version({"hw": str(self.hw), "version": "v2"})
        self.failing.add("v1")
        for body, error in (({"slot": "C", "version": "v1"}, "slot must be A or B"),
                            ({"slot": "A", "version": "v9"}, "v9"), ({"slot": "A", "version": "v1"}, "no STEP")):
            with self.subTest(body=body):
                status, answer = self.request("POST", "/api/load-version", body)
                self.assertEqual(status, 400)
                self.assertIn(error, answer["error"])
        self.assertEqual(self.selected(), {"A": ("v2", "v2")})
        self.assertEqual(self.pushes, [("a", "v2")])

    def test_split_keys_load_independently(self) -> None:
        self.host.compare({"hw": str(self.hw), "a": "v1", "b": "v2"})
        self.request("POST", "/api/load-version", {"slot": "B", "version": "latest"})
        self.assertEqual(self.pushes[-1], ("b", "v3"))
        self.request("POST", "/api/load-version", {"slot": "A", "version": "v2"})
        self.assertEqual(self.pushes[-1], ("a", "v2"))
        self.assertEqual(self.selected(), {"A": ("v2", "v2"), "B": ("latest", "v3")})

    def test_a_key_on_latest_follows_a_new_build_and_a_pinned_key_stays(self) -> None:
        self.host.compare({"hw": str(self.hw), "a": "latest", "b": "v2"})
        self.host.follow_latest()
        self.assertEqual(len(self.pushes), 2)  # latest.json still names v3
        make_version(self.hw, "v4")
        self.host.follow_latest()
        self.assertEqual(self.pushes[-1], ("a", "v4"))
        self.assertEqual(self.selected(), {"A": ("latest", "v4"), "B": ("v2", "v2")})
        self.assertEqual(self.request("GET", "/api/state")[1]["latest"], "v4")
        self.host.follow_latest()
        self.assertEqual(len(self.pushes), 3)

    def test_a_build_that_does_not_load_is_reported_and_not_retried_until_the_next(self) -> None:
        self.host.show_version({"hw": str(self.hw)})
        self.failing.add("v4")
        make_version(self.hw, "v4")
        self.host.follow_latest()
        self.host.follow_latest()
        self.assertEqual(self.loads.count("v4"), 1)
        selected = self.request("GET", "/api/state")[1]["selected"]["A"]
        self.assertEqual((selected["version"], selected["label"]), ("latest", "v3"))
        self.assertIn("latest is v4, which did not load", selected["error"])
        make_version(self.hw, "v5")
        self.host.follow_latest()
        self.assertEqual(self.selected(), {"A": ("latest", "v5")})
        self.assertIsNone(self.request("GET", "/api/state")[1]["selected"]["A"]["error"])

    def test_a_capture_holds_the_new_build_until_it_is_done(self) -> None:
        self.host.show_version({"hw": str(self.hw)})
        make_version(self.hw, "v4")
        self.host.guard.begin_capture()
        self.host.follow_latest()
        self.assertEqual(self.selected(), {"A": ("latest", "v3")})
        self.assertEqual(self.request("POST", "/api/load-version", {"slot": "A", "version": "v1"})[0], 409)
        self.host.guard.end_capture()
        self.host.follow_latest()
        self.assertEqual(self.selected(), {"A": ("latest", "v4")})
        self.assertEqual(self.loads.count("v4"), 1)


if __name__ == "__main__":
    unittest.main()
