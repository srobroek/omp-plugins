#!/usr/bin/env python3
"""cad-viewer preview gallery tests without a browser or OCP: what the index lists per version
(render captions, captures, drawings with their PDFs, concept screenshots), the file route's
path checks, and the host's gallery routes on a real loopback server.

Run: python3 -m unittest discover -s cad/skills/cad-viewer/tests -p 'test_gallery.py' -v  (needs PyYAML)
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
SCRIPTS = SKILL / "scripts"
TEMPLATE_HW = SKILL.parent.parent / "examples" / "lamp-arm" / "hw"
sys.path.insert(0, str(SCRIPTS))

from cadviewer import ViewerError, gallery, host, session  # noqa: E402

PORTS = {"a": 1001, "b": 1002, "presenter_a": 2001, "presenter_b": 2002}
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 16
PDF = b"%PDF-1.7\n%%EOF\n"


def write(path: Path, data: bytes | str | dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, dict):
        data = json.dumps(data)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    return path

def bundle(hw: Path, kind: str, version: str, subject: str, files: dict[str, bytes | str | dict],
           recipe: dict, status: str = "pass") -> Path:
    """Create a fixture through cad-record's real bundle contract."""
    api = gallery.record._layout()
    staged = api.staging(hw, f"bundle.{kind}")
    for name, data in files.items():
        write(staged / name, data)
    return api.publish(hw, f"bundle.{kind}", {"V": version, "S": subject}, staged, recipe=recipe,
                       producer="test_gallery", status=status).path


def make_project(root: Path) -> Path:
    """A template record with built v1/v2 bundles and current plus legacy art."""
    hw = root / "hw"
    shutil.copytree(TEMPLATE_HW, hw)
    for label in ("v1", "v2"):
        folder = hw / "versions" / label
        folder.mkdir(parents=True)
        for name in ("assembly.step", "assembly.glb", "metrics.json", "part-map.json"):
            write(folder / name, "")
        write(folder / "manifest.json", {"label": label, "files": {}})
    write(hw / "versions" / "latest.json", {"label": "v2"})
    render_meta = {
        "version": "v2", "status": "pass",
        "materials": {"LMP-0001": {"rule": "al-anodised", "label": "Anodised aluminium"},
                      "LMP-0002": {"rule": "pa12", "label": "PA12 nylon"}},
        "views": {
            "iso": {"subject": ["LMP-0001", "LMP-0002"],
                    "quality": {"status": "pass", "failures": [], "warnings": []}},
            "part-LMP-0001": {"subject": ["LMP-0001"],
                              "quality": {"status": "pass", "failures": [], "warnings": ["NO_SHADOW"]}},
            "closeup-LMP-0002": {"subject": ["LMP-0002"],
                                 "quality": {"status": "pass", "failures": [], "warnings": []},
                                 "retry": {"strategy": "ghosted-context", "note": "enclosed by LMP-0001",
                                           "attempts": [{"strategy": "original", "status": "fail"},
                                                        {"strategy": "ghosted-context", "status": "pass"}]}}
        }}
    render_files = {f"{view}.png": PNG for view in ("iso", "part-LMP-0001", "closeup-LMP-0002", "stray")}
    render_files["render.json"] = render_meta
    bundle(hw, "renders", "v2", "assembly", render_files, {"views": ["iso", "part-LMP-0001"], "size": [800, 600]})
    bundle(hw, "renders", "v1", "assembly", {"iso.png": PNG, "render.json": {
        "version": "v1", "status": "fail", "views": {
            "iso": {"quality": {"status": "fail", "failures": ["BLANK"]}}}}},
        {"views": ["iso"], "size": [800, 600]}, "fail")
    for label, view in (("v2", "iso"), ("v1", "front")):
        bundle(hw, "captures", label, view, {f"{view}.png": PNG,
                                               "capture.json": {"version": label, "view": view,
                                                                "viewer_state": {"mode": "single"}}},
               {"view": view, "viewer_state": {"mode": "single"}, "size": [800, 600]})
    single = bundle(hw, "drawings", "v2", "LMP-0001", {
        "sheet-1.png": PNG, "sheet-1.pdf": PDF, "sheet-1.svg": "<svg/>",
        "coverage.json": {"status": "pass"},
        "package.json": {"status": "pass", "scale": "1:2", "projection_method": "first-angle",
                         "provenance": {"subject": "LMP-0001", "version": "v2"},
                         "sheets": [{"sheet": 1, "files": {"png": "sheet-1.png", "pdf": "sheet-1.pdf",
                                                                  "svg": "sheet-1.svg"}}]}},
        {"part": "LMP-0001"})
    bundle(hw, "drawings", "v1", "LMP-0003", {
        "sheet-1.png": PNG, "sheet-1.pdf": PDF, "sheet-1.svg": "<svg/>",
        "coverage.json": {"status": "pass"},
        "package.json": {"status": "pass", "provenance": {"subject": "LMP-0003", "version": "v1"},
                         "sheets": [{"sheet": 1, "files": {"png": "sheet-1.png", "pdf": "sheet-1.pdf",
                                                                  "svg": "sheet-1.svg"}}]}},
        {"part": "LMP-0003"})
    write(hw / "drawings" / "sketch.png", PNG)
    write(hw / "drawings" / ".pkg.staging-1" / "sheet-1.png", PNG)
    shots = hw / "concept" / "screenshots"
    write(shots / "lamp-20261027.png", PNG)
    write(shots / "lamp-20261027.json", {"scene": "lamp.scene.json", "variant": "B", "pose": {}})
    return hw


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="cad-gallery-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.hw = make_project(self.tmp)

    def section(self, model: dict, sid: str) -> dict:
        return next(s for s in model["sections"] if s["id"] == sid)

    def titles(self, model: dict, sid: str) -> list[str]:
        return [t["title"] for t in self.section(model, sid)["tiles"]]


class Index(Fixture):
    def test_versions_come_from_builds_and_renders(self) -> None:
        self.assertEqual(gallery.versions(self.hw), (["v1", "v2"], "v2"))
        self.assertEqual(gallery.index(self.hw)["version"], "v2")
        with self.assertRaises(gallery.NotFound):
            gallery.index(self.hw, "v9")

    def test_render_tiles_carry_manifest_captions_and_absolute_paths(self) -> None:
        model = gallery.index(self.hw, "v2")
        tiles = {t["title"]: t for t in self.section(model, "renders")["tiles"]}
        self.assertEqual(list(tiles), ["iso", "part-LMP-0001", "closeup-LMP-0002", "stray"])
        iso = tiles["iso"]
        self.assertEqual(iso["path"], str(self.hw / "renders" / "v2" / "assembly" / "iso.png"))
        self.assertEqual(iso["url"], "/gallery/file?path=renders/v2/assembly/iso.png")
        self.assertEqual([m["pn"] for m in iso["materials"]], ["LMP-0001", "LMP-0002"])
        self.assertIsNone(iso["subject"])
        self.assertEqual(tiles["part-LMP-0001"]["subject"], ["LMP-0001"])
        self.assertEqual(tiles["part-LMP-0001"]["warnings"], ["NO_SHADOW"])
        self.assertEqual(tiles["part-LMP-0001"]["status"], "pass")
        self.assertEqual(tiles["part-LMP-0001"]["materials"],
                         [{"pn": "LMP-0001", "label": "Anodised aluminium", "rule": "al-anodised"}])
        self.assertEqual(tiles["closeup-LMP-0002"]["retry"],
                         {"strategy": "ghosted-context", "attempts": 2, "note": "enclosed by LMP-0001"})
        self.assertEqual(tiles["stray"]["note"], "not listed in render.json")
        v1 = self.section(gallery.index(self.hw, "v1"), "renders")["tiles"]
        self.assertEqual([(t["status"], t["failures"]) for t in v1], [("fail", ["BLANK"])])

    def test_captures_and_drawings_follow_the_selected_version(self) -> None:
        v2, v1 = gallery.index(self.hw, "v2"), gallery.index(self.hw, "v1")
        self.assertEqual(self.titles(v2, "captures"), ["iso"])
        self.assertEqual(self.titles(v1, "captures"), ["front"])
        capture_tile = self.section(v2, "captures")["tiles"][0]
        self.assertTrue(capture_tile["version_recorded"])
        self.assertEqual(capture_tile["state"], {"mode": "single"})
        self.assertEqual(self.titles(v2, "drawings"), ["LMP-0001 sheet 1"])
        self.assertEqual(self.titles(v1, "drawings"), ["LMP-0003 sheet 1"])
        single = self.section(v2, "drawings")["tiles"][0]
        self.assertEqual(single["path"], str(self.hw / "drawings/v2/LMP-0001/sheet-1.png"))
        self.assertEqual(single["pdf"], {"path": str(self.hw / "drawings/v2/LMP-0001/sheet-1.pdf"),
                                         "url": "/gallery/file?path=drawings/v2/LMP-0001/sheet-1.pdf"})
        self.assertEqual((single["scale"], single["projection"]), ("1:2", "first-angle"))
        sheet = self.section(v1, "drawings")["tiles"][0]
        self.assertEqual(sheet["pdf"]["path"], str(self.hw / "drawings/v1/LMP-0003/sheet-1.pdf"))

    def test_picker_reads_verified_per_version_bundles_and_sheet_previews(self) -> None:
        entries = {entry["label"]: entry for entry in gallery.record.version_list(self.hw)}
        v2 = entries["v2"]["previews"]
        self.assertEqual([(bundle["subject"], bundle["files"]) for bundle in v2["renders"]],
                         [("assembly", ["renders/v2/assembly/closeup-LMP-0002.png",
                                        "renders/v2/assembly/iso.png", "renders/v2/assembly/part-LMP-0001.png",
                                        "renders/v2/assembly/stray.png"])])
        self.assertEqual(v2["captures"], [{"subject": "iso", "files": ["captures/v2/iso/iso.png"],
                                           "views": ["iso"]}])

    def test_concept_screenshots_take_scene_and_variant(self) -> None:
        self.assertEqual(self.titles(gallery.index(self.hw), "concept"), ["lamp B"])

    def test_an_empty_section_says_what_to_run(self) -> None:
        shutil.rmtree(self.hw / "renders" / "v2")
        renders = self.section(gallery.index(self.hw, "v2"), "renders")
        self.assertEqual(renders["tiles"], [])
        self.assertIn("render.py", renders["empty"])

    def test_a_drawing_png_outside_hw_is_not_listed(self) -> None:
        outside = write(self.tmp / "elsewhere.png", PNG)
        bundle_path = self.hw / "drawings" / "v2" / "LMP-0001"
        api = gallery.record._layout()
        stage = api.staging(self.hw, "bundle.drawings")
        for name in ("sheet-1.png", "sheet-1.pdf", "sheet-1.svg", "coverage.json", "package.json"):
            shutil.copyfile(bundle_path / name, stage / name)
        package = json.loads((stage / "package.json").read_text())
        package["sheets"][0]["files"]["png"] = str(outside)
        (stage / "package.json").write_text(json.dumps(package))
        broken = api.bundle_dir(self.hw, "drawings", "v2", "LMP-0001")
        shutil.rmtree(broken)
        api.publish(self.hw, "bundle.drawings", {"V": "v2", "S": "LMP-0001"}, stage,
                    recipe={"part": "LMP-0001", "tampered": True}, producer="test_gallery", status="fail")
        drawings = self.section(gallery.index(self.hw, "v2"), "drawings")
        self.assertNotIn(str(outside), [t["path"] for t in drawings["tiles"]])


class Resolve(Fixture):
    def test_files_inside_hw_resolve(self) -> None:
        self.assertEqual(gallery.resolve(self.hw, "renders/v2/assembly/iso.png"),
                         self.hw / "renders" / "v2" / "assembly" / "iso.png")
        self.assertEqual(gallery.resolve(self.hw, "drawings/v2/LMP-0001/sheet-1.pdf").suffix, ".pdf")

    def test_traversal_hidden_folders_other_types_and_escaping_links_are_forbidden(self) -> None:
        write(self.tmp / "secret.png", PNG)
        (self.hw / "renders" / "link.png").symlink_to(self.tmp / "secret.png")
        (self.hw / "linkdir").symlink_to(self.tmp)
        for rel in ("../secret.png", "renders/../../secret.png", str(self.tmp / "secret.png"), "/etc/hosts.png",
                    ".cad/x.png", "drawings/.pkg.staging-1/sheet-1.png", "product.yaml", "renders\\..\\x.png",
                    "renders/link.png", "linkdir/secret.png", "", "a\x00.png"):
            with self.subTest(rel=rel), self.assertRaises(gallery.Forbidden):
                gallery.resolve(self.hw, rel)

    def test_a_missing_file_is_not_found(self) -> None:
        with self.assertRaises(gallery.NotFound):
            gallery.resolve(self.hw, "renders/v2/none.png")

    def test_only_a_hardware_record_opens(self) -> None:
        with self.assertRaises(ViewerError):
            gallery.Gallery().open("relative/hw")
        with self.assertRaises(ViewerError):
            gallery.Gallery().open(str(self.tmp))
        self.assertEqual(gallery.Gallery().open(str(self.hw)), self.hw)


class HostRoutes(Fixture):
    """The gallery routes on the host's real loopback server; no viewer process is started."""

    def setUp(self) -> None:
        super().setUp()
        self.port = session.free_port()
        self.host = host.Host(self.tmp / "session.json", self.port, PORTS)
        server = host.make_server(self.host)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def request(self, method: str, route: str, body: dict | None = None,
                headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{route}", data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, dict(error.headers), error.read()

    def open_project(self) -> dict:
        status, _, raw = self.request("POST", "/api/gallery", {"hw": str(self.hw)})
        self.assertEqual(status, 200, raw)
        return json.loads(raw)

    def test_opening_a_project_answers_the_url_and_every_file(self) -> None:
        answer = self.open_project()
        self.assertEqual(answer["url"], f"http://127.0.0.1:{self.port}/gallery?version=v2")
        self.assertEqual(answer["versions"], ["v1", "v2"])
        self.assertIn(str(self.hw / "renders/v2/assembly/iso.png"), answer["files"]["renders"])
        self.assertIn(str(self.hw / "drawings/v2/LMP-0001/sheet-1.pdf"), answer["files"]["drawings"])
        status, _, raw = self.request("POST", "/api/gallery", {"hw": str(self.tmp)})
        self.assertEqual(status, 400, raw)

    def test_page_index_and_files_are_served(self) -> None:
        status, headers, page = self.request("GET", "/gallery?version=v1")
        self.assertEqual((status, headers["Content-Type"]), (200, "text/html; charset=utf-8"))
        self.assertIn(b"/gallery.js", page)
        for asset in ("/gallery.js", "/gallery.css"):
            self.assertEqual(self.request("GET", asset)[0], 200, asset)
        self.assertEqual(self.request("GET", "/api/gallery")[0], 400)  # no project open yet
        self.open_project()
        status, _, raw = self.request("GET", "/api/gallery?version=v1")
        self.assertEqual((status, json.loads(raw)["version"]), (200, "v1"))
        self.assertEqual(self.request("GET", "/api/gallery?version=v9")[0], 404)
        status, headers, body = self.request("GET", "/gallery/file?path=renders/v2/assembly/iso.png")
        self.assertEqual((status, headers["Content-Type"], body), (200, "image/png", PNG))
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        status, headers, body = self.request("GET", "/gallery/file?path=drawings/v2/LMP-0001/sheet-1.pdf")
        self.assertEqual((status, headers["Content-Type"], body), (200, "application/pdf", PDF))

    def test_the_file_route_rejects_traversal_and_other_sites(self) -> None:
        self.open_project()
        write(self.tmp / "secret.png", PNG)
        for query in ("../secret.png", "%2e%2e/secret.png", "renders/..%2f..%2fsecret.png",
                      f"{self.tmp}/secret.png", "product.yaml", ".cad/recheck.png"):
            with self.subTest(query=query):
                status, _, body = self.request("GET", f"/gallery/file?path={query}")
                self.assertEqual(status, 403, body)
                self.assertNotEqual(body, PNG)
        self.assertEqual(self.request("GET", "/gallery/file?path=renders/v2/none.png")[0], 404)
        self.assertEqual(self.request("GET", "/gallery/file")[0], 403)
        route = "/gallery/file?path=renders/v2/assembly/iso.png"
        self.assertEqual(self.request("GET", route, headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.request("GET", route, headers={"Host": f"evil.example:{self.port}"})[0], 403)
        self.assertEqual(self.request("POST", "/api/gallery", None, {"Content-Type": "text/plain"})[0], 415)


@unittest.skipUnless(importlib.util.find_spec("yaml"), "PyYAML not installed")
class Cli(unittest.TestCase):
    def setUp(self) -> None:
        spec = importlib.util.spec_from_file_location("cad_viewer_cli_gallery", SCRIPTS / "viewer.py")
        assert spec and spec.loader
        self.viewer = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.viewer
        spec.loader.exec_module(self.viewer)

    def test_gallery_command_posts_the_absolute_hw(self) -> None:
        args = self.viewer.build_parser().parse_args(["gallery", "hw", "--version", "v3"])
        self.assertEqual(self.viewer.request_body(args),
                         ("POST", "/api/gallery", {"hw": str(Path("hw").resolve()), "version": "v3"}))

    def test_show_prints_the_gallery_url_and_selection_of_each_version(self) -> None:
        answer = {"mode": "single", "active": "A", "slots": {}, "view": {}, "latest": "v2",
                  "versions": {"A": {"label": "v2", "parts": [1, 2], "check": None}},
                  "selected": {"A": {"version": "latest", "label": "v2", "error": None}}}
        out = self.viewer.summarise("show", answer, "http://127.0.0.1:9/")
        self.assertEqual(out["versions"]["A"]["gallery"], "http://127.0.0.1:9/gallery?version=v2")
        self.assertEqual((out["versions"]["A"]["selected"], out["latest"]), ("latest", "v2"))


if __name__ == "__main__":
    unittest.main()
