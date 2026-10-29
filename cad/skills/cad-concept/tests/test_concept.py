#!/usr/bin/env python3
"""Regression tests for the cad-concept scene checker, handoff export, and live server.

Stdlib only, so CI runs them with plain python3. The JSON Schema checks need the
PEP 723 environment and run only when `uv` is on PATH.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path


SKILL = Path(__file__).resolve().parent.parent
EXAMPLE = SKILL / "assets" / "examples" / "lamp-arm.scene.json"
CONCEPT_PY = SKILL / "scripts" / "concept.py"
SERVE_PY = SKILL / "scripts" / "serve.py"

def project_for_scene(temp: Path, scene_path: Path) -> Path:
    """Make a minimal project whose layout owns this concept scene and part."""
    template = SKILL.parent / "cad-record" / "assets" / "project-template"
    project = temp / "project"
    shutil.copytree(template, project)
    hw = project / "hw"
    (hw / "concept").mkdir(parents=True, exist_ok=True)
    shutil.copy(scene_path, hw / "concept" / "lamp-arm.scene.json")
    part = hw / "parts" / "PRT-0001"
    part.mkdir(parents=True, exist_ok=True)
    (part / "part.yaml").write_text(
        "PN: PRT-0001\nrev: X1\ntitle: Placeholder part\nmaterial: Placeholder material\n"
        "process: cnc\nfinish: As machined\nmass_target: null\nmake_buy: make\n", encoding="utf-8")
    return project

def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


concept = load("cad_concept", CONCEPT_PY)
serve = load("cad_concept_serve", SERVE_PY)


def example() -> dict:
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


def box_part(pid: str, size, position=(0, 0, 0), rotation=(0, 0, 0)) -> dict:
    return {
        "kind": "part",
        "id": pid,
        "label": pid,
        "position": list(position),
        "rotation": list(rotation),
        "shape": {"type": "box", "size": list(size)},
    }


class SemanticChecks(unittest.TestCase):
    def test_example_is_clean_and_matches_the_brief(self) -> None:
        scene = example()
        self.assertEqual(concept.semantic_errors(scene), [])
        self.assertEqual([v["id"] for v in scene["variants"]], ["short-reach", "long-reach", "square-base"])
        for variant in scene["variants"]:
            limits = {j["id"]: (j["min"], j["max"]) for j in variant["joints"]}
            self.assertEqual(limits, {"base": (-10, 80), "elbow": (-120, 0), "head": (-45, 45)})
        footprints = {v["params"]["base_footprint_mm"] for v in scene["variants"]}
        self.assertEqual(len(footprints), 3, "each variant has its own base size")

    def test_wiring_and_limit_errors_are_reported(self) -> None:
        scene = example()
        variant = scene["variants"][0]
        variant["joints"][1]["parent"] = "base"
        variant["joints"][2]["nominal"] = 90
        variant["joints"][0]["axis"] = [0, 0, 0]
        variant["root"]["children"][0]["children"][1]["id"] = "base-plate"
        errors = concept.semantic_errors(scene)
        joined = "\n".join(errors)
        self.assertIn("not a direct child of 'base'", joined)
        self.assertIn("nominal 90 is outside", joined)
        self.assertIn("axis is zero-length", joined)
        self.assertIn("duplicate node id 'base-plate'", joined)

    def test_scene_level_errors(self) -> None:
        scene = example()
        scene["chosen"] = "missing"
        scene["retired"] = [{"id": "tall", "label": "Tall", "disposition": "merged", "into": "nowhere", "reason": "r"}]
        scene["variants"][0]["root"]["children"][0]["children"][2]["children"][0]["shape"] = {
            "type": "capsule", "radius": 20, "height": 30,
        }
        joined = "\n".join(concept.semantic_errors(scene))
        self.assertIn("chosen: 'missing' is not a live variant", joined)
        self.assertIn("merged into unknown variant 'nowhere'", joined)
        self.assertIn("capsule height 30 is below 2 x radius", joined)


class Geometry(unittest.TestCase):
    def test_rotated_box_envelope_swaps_axes(self) -> None:
        variant = {
            "id": "v", "label": "v", "root": {"kind": "group", "id": "root", "label": "r",
            "children": [box_part("p", (100, 20, 10), (50, 0, 0), (0, 0, 90))]},
        }
        box = concept.envelopes(variant)["root"]
        self.assertEqual([round(v, 6) for v in box.lo], [40, -50, -5])
        self.assertEqual([round(v, 6) for v in box.hi], [60, 50, 5])

    def test_revolute_joint_poses_child_at_nominal(self) -> None:
        arm = {"kind": "group", "id": "arm", "label": "a", "children": [box_part("link", (10, 10, 100), (0, 0, 50))]}
        variant = {
            "id": "v", "label": "v", "root": {"kind": "group", "id": "root", "label": "r", "children": [arm]},
            "joints": [{"id": "j", "type": "revolute", "parent": "root", "child": "arm", "axis": [0, 1, 0],
                        "origin": [0, 0, 0], "min": 0, "max": 90, "nominal": 90}],
        }
        box = concept.envelopes(variant)["root"]
        self.assertEqual([round(v, 6) for v in box.lo], [0, -5, -5])
        self.assertEqual([round(v, 6) for v in box.hi], [100, 5, 5])

    def test_prismatic_joint_translates_along_axis(self) -> None:
        slider = {"kind": "group", "id": "slide", "label": "s", "children": [box_part("block", (10, 10, 10))]}
        variant = {
            "id": "v", "label": "v", "root": {"kind": "group", "id": "root", "label": "r", "children": [slider]},
            "joints": [{"id": "j", "type": "prismatic", "parent": "root", "child": "slide", "axis": [0, 0, 2],
                        "origin": [0, 0, 0], "min": 0, "max": 40, "nominal": 25}],
        }
        box = concept.envelopes(variant)["root"]
        self.assertEqual([round(v, 6) for v in box.lo], [-5, -5, 20])
        self.assertEqual([round(v, 6) for v in box.hi], [5, 5, 30])


class Handoff(unittest.TestCase):
    def setUp(self) -> None:
        self.scene = example()
        self.scene["chosen"] = "long-reach"
        self.scene["retired"] = [{"id": "wall-mount", "label": "Wall mount", "disposition": "dropped", "reason": "no wall"}]
        variant = concept.pick_variant(self.scene, None)
        self.manifest = concept.build_handoff(self.scene, variant, file_name="lamp-arm.scene.json", digest="0" * 64)

    def test_hierarchy_is_parents_first_with_stable_paths(self) -> None:
        nodes = self.manifest["nodes"]
        seen: set[str] = set()
        for node in nodes:
            if node["parent"] is not None:
                self.assertIn(node["parent"], seen)
            seen.add(node["id"])
        paths = {n["id"]: n["path"] for n in nodes}
        self.assertEqual(paths["bulb"], "lamp/base/lower-arm/upper-arm/head/bulb")
        self.assertIsNone(nodes[0]["parent"])
        self.assertEqual(len(nodes), 11)

    def test_joints_variant_and_alternatives(self) -> None:
        joints = {j["id"]: j for j in self.manifest["joints"]}
        self.assertEqual(joints["elbow"]["axis"], [0.0, -1.0, 0.0])
        self.assertEqual(joints["elbow"]["origin"], [0.0, 0.0, 340.0])
        self.assertEqual((joints["base"]["min"], joints["base"]["max"], joints["base"]["unit"]), (-10, 80, "deg"))
        self.assertEqual(self.manifest["variant"]["params"]["upper_link_mm"], 340)
        fates = {a["id"]: a["disposition"] for a in self.manifest["alternatives"]}
        self.assertEqual(fates, {"short-reach": "not-chosen", "square-base": "not-chosen", "wall-mount": "dropped"})

    def test_lamp_handoff_is_stable_without_viewer_pose(self) -> None:
        scene = example()
        scene["chosen"] = "long-reach"
        variant = concept.pick_variant(scene, None)
        manifest = concept.build_handoff(scene, variant, file_name=EXAMPLE.name,
                                         digest=hashlib.sha256(EXAMPLE.read_bytes()).hexdigest())
        self.assertEqual(manifest["variant"]["id"], "long-reach")
        self.assertEqual(len(manifest["joints"]), 3)
        self.assertEqual(manifest["joints"][0]["nominal"], 30)
        self.assertEqual(hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                         "48e8bf582be54a38981a655f1e347a128d3a9af6add139f76e939be41db09379")

    def test_part_envelope_is_its_primitive(self) -> None:
        plate = next(n for n in self.manifest["nodes"] if n["id"] == "base-plate")
        self.assertEqual(plate["envelope"]["size"], [220.0, 220.0, 24.0])
        self.assertEqual(plate["shape"], {"type": "cylinder", "radius": 110, "height": 24})

    def test_missing_choice_is_a_check_failure(self) -> None:
        with self.assertRaisesRegex(ValueError, "no variant chosen"):
            concept.pick_variant(example(), None)


@unittest.skipUnless(shutil.which("uv"), "uv not on PATH; schema checks need the PEP 723 environment")
class SchemaCli(unittest.TestCase):
    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["uv", "run", "--quiet", "--script", str(CONCEPT_PY), *args], capture_output=True,
                              text=True, timeout=180)

    def test_example_scene_passes_check(self) -> None:
        result = self.run_cli("check", str(EXAMPLE))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])

    def test_handoff_export_validates_against_its_schema(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "handoff.json"
            result = self.run_cli("handoff", str(EXAMPLE), "--variant", "short-reach", "--out", str(out))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            manifest = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(manifest["scene"]["sha256"], hashlib.sha256(EXAMPLE.read_bytes()).hexdigest())
            self.assertEqual(manifest["variant"]["id"], "short-reach")

    def test_schema_violation_exits_one(self) -> None:
        scene = example()
        scene["variants"][0]["root"]["children"][0]["children"][0]["shape"] = {"type": "cone", "radius": 1}
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.scene.json"
            bad.write_text(json.dumps(scene), encoding="utf-8")
            result = self.run_cli("check", str(bad))
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stdout)["ok"])

    def test_unreadable_scene_is_a_usage_error(self) -> None:
        self.assertEqual(self.run_cli("check", "/nonexistent/x.scene.json").returncode, 2)


class ServerUnits(unittest.TestCase):
    def test_import_map_is_the_vendor_allow_list(self) -> None:
        integrity = serve.vendor_integrity(serve.VIEWER_DIR / "index.html")
        self.assertEqual(sorted(integrity), [
            "/vendor/three@0.186.1/build/three.core.js",
            "/vendor/three@0.186.1/build/three.module.js",
            "/vendor/three@0.186.1/examples/jsm/controls/OrbitControls.js",
        ])
        self.assertTrue(all(v.startswith("sha384-") for v in integrity.values()))

    def test_sri_and_cache_hit(self) -> None:
        data = b"export const x = 1;\n"
        sri = "sha384-" + base64.b64encode(hashlib.sha384(data).digest()).decode()
        self.assertTrue(serve.sri_matches(data, sri))
        self.assertFalse(serve.sri_matches(data + b" ", sri))
        self.assertFalse(serve.sri_matches(data, "md5-abc"))
        with tempfile.TemporaryDirectory() as tmp:
            cached = Path(tmp) / "pkg@1/x.js"
            cached.parent.mkdir(parents=True)
            cached.write_bytes(data)
            cache = serve.VendorCache(Path(tmp), {"/vendor/pkg@1/x.js": sri})
            self.assertEqual(cache.get("/vendor/pkg@1/x.js"), data)
            with self.assertRaises(LookupError):
                cache.get("/vendor/pkg@1/other.js")

    def test_scene_names_and_change_detection(self) -> None:
        self.assertTrue(serve.SCENE_NAME.match("lamp-arm.scene.json"))
        for bad in ("../x.scene.json", "a/b.scene.json", ".hidden.scene.json", "x.json"):
            self.assertIsNone(serve.SCENE_NAME.match(bad), bad)
        before = {"a.scene.json": (1, 10), "b.scene.json": (1, 10)}
        after = {"a.scene.json": (2, 10), "c.scene.json": (1, 5)}
        self.assertEqual(serve.changed_files(before, after), ["a.scene.json", "b.scene.json", "c.scene.json"])


class ServerLive(unittest.TestCase):
    """Starts serve.py on a free port and drives its HTTP surface."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.project = project_for_scene(self.dir, EXAMPLE)
        self.hw = self.project / "hw"
        self.scene_dir = self.hw / "concept"
        self.scene_path = self.scene_dir / "lamp-arm.scene.json"
        self.proc, self.ready = self.start_server()
        self.url = self.ready["url"]

    def start_server(self, *extra: str) -> tuple[subprocess.Popen[str], dict]:
        proc = subprocess.Popen(
            [sys.executable, str(SERVE_PY), "--scene-dir", str(self.scene_dir), "--project-root", str(self.project),
             "--port", "0", "--poll", "0.1", *extra, "--cache-dir", str(self.dir / "cache")],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        assert proc.stdout
        ready = json.loads(proc.stdout.readline())
        self.assertEqual(ready["scene_dir"], str(self.scene_dir.resolve()))
        self.assertIn("idle_timeout_min", ready)
        return proc, ready

    def tearDown(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=5)
        assert self.proc.stdout
        self.proc.stdout.close()
        self.tmp.cleanup()

    def get(self, path: str, host: str | None = None) -> tuple[int, bytes]:
        req = urllib.request.Request(self.url.rstrip("/") + path)
        if host:
            req.add_header("Host", host)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            with exc:
                return exc.code, exc.read()

    def post(self, body: dict, origin: str | None = None, host: str | None = None,
             path: str = "api/screenshot") -> tuple[int, dict]:
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        if origin:
            req.add_header("Origin", origin)
        if host:
            req.add_header("Host", host)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            with exc:
                return exc.code, json.loads(exc.read())

    def test_routes(self) -> None:
        status, body = self.get("/api/scenes")
        self.assertEqual((status, json.loads(body)), (200, {"scenes": ["lamp-arm.scene.json"]}))
        self.assertEqual(self.get("/scenes/lamp-arm.scene.json"), (200, self.scene_path.read_bytes()))
        self.assertEqual(self.get("/scenes/..%2Fsecret.scene.json")[0], 404)
        self.assertEqual(self.get("/../../etc/passwd")[0], 404)
        self.assertEqual(self.get("/no-such-viewer-asset.js")[0], 404)
        status, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b'<script type="importmap">', body)

    def test_change_is_pushed_over_sse(self) -> None:
        resp = urllib.request.urlopen(self.url + "events", timeout=10)
        self.assertEqual(resp.readline().strip(), b"event: hello")
        resp.readline(), resp.readline()
        time.sleep(0.3)
        scene = example()
        scene["title"] = "Edited"
        self.scene_path.write_text(json.dumps(scene), encoding="utf-8")
        started = time.monotonic()
        lines = [resp.readline().strip() for _ in range(2)]
        resp.close()
        self.assertEqual(lines[0], b"event: change")
        self.assertEqual(json.loads(lines[1].removeprefix(b"data: ")), {"files": ["lamp-arm.scene.json"]})
        self.assertLess(time.monotonic() - started, 3)

    def test_screenshot_upload_publishes_a_content_bound_layout_bundle(self) -> None:
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
        scene_sha = hashlib.sha256(self.scene_path.read_bytes()).hexdigest()
        capture = {"scene": "lamp-arm.scene.json", "scene_sha256": scene_sha, "variant": "long-reach",
                   "camera": {"position": [1, 2, 3]}, "labels": {"parts": True}}
        body = {"scene": "lamp-arm.scene.json", "variant": "long-reach", "capture": capture,
                "png": "data:image/png;base64," + base64.b64encode(png).decode()}
        status, result = self.post(body, origin=self.url.rstrip("/"))
        self.assertEqual(status, 201, result)
        saved = Path(result["path"])
        capture_sha = hashlib.sha256(serve.layout.canonical_json(capture)).hexdigest()
        bundle = self.hw / "concept" / "screenshots" / scene_sha / capture_sha
        self.assertEqual(saved.resolve(), (bundle / "preview.png").resolve())
        self.assertEqual(saved.read_bytes(), png)
        manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["layout"], "concept.screenshot")
        self.assertEqual(manifest["recipe"]["scene_sha256"], scene_sha)
        self.assertEqual(manifest["recipe"]["capture_sha256"], capture_sha)
        self.assertEqual(manifest["files"]["preview.png"], hashlib.sha256(png).hexdigest())
        validator = SKILL.parent / "cad-record" / "scripts" / "validate.py"
        checked = subprocess.run([sys.executable, str(validator), str(self.project)],
                                 capture_output=True, text=True, timeout=60)
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertEqual(json.loads(checked.stdout), {"ok": True, "findings": []})
        self.assertEqual(self.post(body, origin="http://evil.example")[0], 403)
        self.assertEqual(self.post({**body, "png": "data:image/png;base64,aGVsbG8="})[0], 400)
        self.assertEqual(self.post({**body, "scene": "../x.scene.json"})[0], 400)
    def test_post_unknown_route_returns_404_without_saving(self) -> None:
        body = {"scene": "lamp-arm.scene.json", "png": "data:image/png;base64," +
                base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16).decode()}
        status, response = self.post(body, path="api/other")
        self.assertEqual(status, 404, response)
        self.assertFalse((self.scene_dir / "screenshots").exists())

    def test_a_rebound_host_name_is_refused(self) -> None:
        port = self.url.rstrip("/").rsplit(":", 1)[1]
        self.assertEqual(self.get("/api/scenes", host=f"evil.example:{port}")[0], 403)
        self.assertEqual(self.get("/api/scenes", host="127.0.0.1:1")[0], 403)
        self.assertEqual(self.get("/api/scenes", host=f"localhost:{port}")[0], 200)
        png = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16).decode()
        body = {"scene": "lamp-arm.scene.json", "png": png}
        status, _ = self.post(body, origin=f"http://evil.example:{port}", host=f"evil.example:{port}")
        self.assertEqual(status, 403)
        self.assertFalse((self.scene_dir / "screenshots").exists())

    def test_sigterm_exits_cleanly(self) -> None:
        self.proc.send_signal(signal.SIGTERM)
        self.assertEqual(self.proc.wait(timeout=5), 0)

class ServerTimeout(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        shutil.copy(EXAMPLE, self.dir / EXAMPLE.name)
        self.ready: dict | None = None
        self.url = ""
        self._server_done = None
        self._server_thread = None

    def tearDown(self) -> None:
        self.stop_server()
        self.tmp.cleanup()

    def stop_server(self) -> None:
        if self._server_done and not self._server_done.is_set():
            self._shutdown(signal.SIGTERM, None)
            self.assertTrue(self._server_done.wait(2))
        self._server_thread.join(timeout=2)

    def start_server(self, idle_timeout_s: float | None) -> None:
        done = threading.Event()

        def ready(info: dict[str, object]) -> None:
            self.ready = info
            self.url = str(info["url"])
        def request_shutdown(stop) -> None:
            self._shutdown = stop

        def serve_forever() -> None:
            try:
                serve.run([
                    "--scene-dir", str(self.dir), "--project-root", str(self.dir), "--port", "0", "--idle-timeout",
                    "1" if idle_timeout_s is not None else "0", "--poll", "0.1",
                    "--cache-dir", str(self.dir / "cache"),
                ], idle_timeout_s=idle_timeout_s, ready_callback=ready, install_signals=False,
                   shutdown_callback=request_shutdown)
            finally:
                done.set()
        self._server_done = done
        self._server_thread = threading.Thread(target=serve_forever, daemon=True)
        self._server_thread.start()
        self.assertTrue(wait_until(lambda: self.ready is not None, 2), "server did not announce ready")

    def test_idle_expiry_uses_seconds_level_timeout(self) -> None:
        started = time.monotonic()
        self.start_server(0.4)
        self.assertTrue(self._server_done.wait(2))
        self.assertLess(time.monotonic() - started, 2)

    def test_live_sse_connection_holds_server_then_disconnect_expires(self) -> None:
        self.start_server(0.4)
        resp = urllib.request.urlopen(self.url + "events", timeout=5)
        self.assertEqual(resp.readline().strip(), b"event: hello")
        resp.readline(), resp.readline()
        time.sleep(0.6)
        self.assertFalse(self._server_done.is_set(), "connected SSE client must keep the server alive")
        resp.close()
        self.assertTrue(self._server_done.wait(2), "server did not expire after SSE disconnect")

    def test_zero_disables_idle_expiry(self) -> None:
        self.start_server(None)
        time.sleep(0.6)
        self.assertFalse(self._server_done.is_set(), "0 disables idle expiry")
        self.stop_server()

def wait_until(predicate, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()

class ServerUsage(unittest.TestCase):
    def test_missing_scene_dir_is_a_usage_error(self) -> None:
        result = subprocess.run([sys.executable, str(SERVE_PY), "--scene-dir", "/nonexistent-dir"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)

    def test_a_non_loopback_bind_needs_allow_remote(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run([sys.executable, str(SERVE_PY), "--scene-dir", tmp, "--host", "0.0.0.0", "--port", "0"],
                                    capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--allow-remote", result.stderr)


if __name__ == "__main__":
    unittest.main()
