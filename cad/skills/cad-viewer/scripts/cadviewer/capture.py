"""The presenter: one headless Chromium page that keeps the panel open, and the captures it takes.

OCP CAD Viewer's own `save_screenshot` returns a black frame without a GPU, so every PNG is a
Playwright screenshot of this page on SwiftShader WebGL. The page lives as long as the host, so
the camera, explode, section, and animation state a capture shows is the state the commands left.

Refit is measured, not assumed: the scene's pixel bounding box is read from the canvas, the mm per
pixel from a known sideways camera pan, and the camera is then centred and zoomed through the
host's camera route, which calls ocp_viewer's `set_viewer_config`.
"""

from __future__ import annotations

import io
import queue
import threading
import time
import traceback
from concurrent.futures import Future, wait
from pathlib import Path
from typing import Any, Callable

from . import ViewerError

CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
VIEWS = ("iso", "front", "side", "top", "exploded", "section", "current")
CROPS = ("page", "viewer", "canvas")
BACKGROUND_DELTA = 28  # channel difference from the canvas background that counts as scene
FILL = 0.84  # share of the free canvas the refitted scene spans on its limiting axis
FILL_TOLERANCE = 0.06
MARGIN_PX = 16
SETTLE_TIMEOUT_S = 20.0
MODEL_TIMEOUT_MS = 60_000
HEARTBEAT_S = 2.0  # an idle presenter checks its page this often
GIZMO_PX = 140  # the orientation axes occupy this bottom-left square of the scene canvas
CENTRE_TOLERANCE = 0.03  # scene centre offset from the free-area centre, as a share of its size
# Adds a style sheet to a page for one scene shot, or removes it again. A canvas screenshot is a
# crop of the composited panel page, so the viewer's chrome inside its frame and the panel's own
# overlays on top of it (the A/B captions) are hidden; otherwise they count as scene pixels in the
# refit. Only overlays are hidden in the panel page: hiding the panel around a viewer frame made the
# next split-view canvas screenshot time out waiting for a stable element.
BARE = """([on, css]) => {
    let style = document.getElementById('cad-viewer-bare');
    if (!on) { style?.remove(); return; }
    if (!style) {
        style = document.createElement('style');
        style.id = 'cad-viewer-bare';
        style.textContent = css;
        document.head.append(style);
    }
}"""
SCENE_CLASS = "cad-viewer-scene"
MARK_SCENE = f"""() => {{
    const main = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    main.classList.add('{SCENE_CLASS}');
}}"""
FRAME_CHROME_CSS = f"body * {{ visibility: hidden !important; }} canvas.{SCENE_CLASS} {{ visibility: visible !important; }}"
PANEL_OVERLAY_CSS = ".viewer-caption { visibility: hidden !important; }"

Box = tuple[int, int, int, int]


def parse_view(text: str) -> str:
    if text in VIEWS or (text.startswith("isolate:") and len(text) > len("isolate:")):
        return text
    raise ValueError(f"view must be one of {', '.join(VIEWS)} or isolate:<PN|group>")


# --------------------------------------------------------------------------- pixel geometry


def rotate(q: list[float], v: tuple[float, float, float]) -> tuple[float, float, float]:
    """`v` rotated by the unit quaternion q = (x, y, z, w)."""
    x, y, z, w = q
    tx, ty, tz = 2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])
    return (v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx))


def content_box(png: bytes) -> Box | None:
    """Pixel bbox (x0, y0, x1, y1) of the scene: everything that differs from the background,
    except the orientation axes three-cad-viewer draws into the canvas's bottom-left corner."""
    from PIL import Image, ImageChops, ImageDraw

    image = Image.open(io.BytesIO(png)).convert("RGB")
    corners = [image.getpixel(p) for p in ((image.width - 3, 2), (image.width - 3, image.height - 3),
                                           (image.width // 2, 2), (image.width // 2, image.height - 3))]
    background = max(set(corners), key=corners.count)
    diff = ImageChops.difference(image, Image.new("RGB", image.size, background)).convert("L")
    mask = diff.point(lambda v: 255 if v > BACKGROUND_DELTA else 0)
    ImageDraw.Draw(mask).rectangle((0, image.height - GIZMO_PX, GIZMO_PX, image.height), fill=0)
    return mask.getbbox()


def _size(png: bytes) -> tuple[int, int]:
    from PIL import Image

    return Image.open(io.BytesIO(png)).size


def inside(box: Box, area: Box) -> bool:
    return box[0] >= area[0] and box[1] >= area[1] and box[2] <= area[2] and box[3] <= area[3]


def fill_ratio(box: Box, area: Box) -> float:
    return max((box[2] - box[0]) / max(area[2] - area[0], 1), (box[3] - box[1]) / max(area[3] - area[1], 1))


def framing(box: Box | None, area: Box) -> dict[str, Any]:
    if box is None:
        return {"content_px": None, "free_px": list(area), "in_frame": False, "fill": 0.0}
    return {"content_px": list(box), "free_px": list(area), "in_frame": inside(box, area),
            "fill": round(fill_ratio(box, area), 3)}


def free_area(size: tuple[int, int], overlays: list[Box]) -> Box:
    """Canvas area outside the viewer's overlays: below the toolbar, right of a tall tree.

    A tree panel that ends in the upper third (collapsed) or covers most of a narrow canvas
    is treated as part of the top band instead.
    """
    width, height = size
    left, top = 0, 0
    for x0, y0, x1, y1 in overlays:
        if y0 <= 16 and x1 - x0 > width * 0.5:
            top = max(top, y1)  # the toolbar
        elif x0 < width * 0.1:
            if y1 > height * 0.33 and x1 < width * 0.45:
                left = max(left, x1)
            else:
                top = max(top, y1)
    return (left + MARGIN_PX, top + MARGIN_PX, width - MARGIN_PX, height - MARGIN_PX)


# --------------------------------------------------------------------------- page driving


class Driver:
    """Reads one viewer frame of the presenter page; moves its camera through the host."""

    def __init__(self, host: Any, page: Any) -> None:
        self.host = host
        self.page = page

    def frame(self, slot: str) -> Any:
        handle = self.page.locator(f"#viewer-{slot}").element_handle(timeout=10_000)
        frame = handle.content_frame() if handle else None
        if frame is None:
            raise ViewerError(f"panel has no viewer frame for slot {slot}")
        return frame

    def canvas(self, slot: str) -> Any:
        frame = self.frame(slot)
        index = frame.evaluate("""() => { const c = [...document.querySelectorAll('canvas')];
            let best = 0; c.forEach((e, i) => { if (e.width * e.height > c[best].width * c[best].height) best = i; });
            return best; }""")
        return frame.locator("canvas").nth(index)

    def overlays(self, slot: str) -> list[Box]:
        """Canvas-relative boxes covered by the viewer's own toolbar, tree, and sliders."""
        rects = self.frame(slot).evaluate("""() => {
            const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
            const c = canvas.getBoundingClientRect();
            const pick = ['.tcv_cad_toolbar', '.tcv_cad_navigation', '.tcv_cad_tree', '.tcv_cad_info',
                          '.tcv_cad_animation'];
            return pick.flatMap(sel => [...document.querySelectorAll(sel)])
              .filter(e => getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none')
              .map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0)
              .map(r => [r.left - c.left, r.top - c.top, r.right - c.left, r.bottom - c.top]);
        }""")
        return [tuple(int(round(v)) for v in r) for r in rects]  # type: ignore[misc]

    def shot(self, slot: str) -> bytes:
        """The main canvas alone: viewer chrome and panel overlays are hidden for the shot, then restored."""
        frame = self.frame(slot)
        frame.evaluate(MARK_SCENE)
        frame.evaluate(BARE, [True, FRAME_CHROME_CSS])
        self.page.evaluate(BARE, [True, PANEL_OVERLAY_CSS])
        try:
            return self.canvas(slot).screenshot()
        finally:
            self.page.evaluate(BARE, [False, None])
            frame.evaluate(BARE, [False, None])

    def settle(self, slot: str, minimum_s: float = 0.4) -> bytes:
        """Wait until two consecutive canvas frames are identical; returns the last one."""
        time.sleep(minimum_s)
        deadline = time.monotonic() + SETTLE_TIMEOUT_S
        previous = self.shot(slot)
        while time.monotonic() < deadline:
            time.sleep(0.35)
            current = self.shot(slot)
            if current == previous:
                return current
            previous = current
        return previous

    def wait_model(self, product_id: str, slot: str) -> None:
        """Wait until the viewer frame lists the product in its tree; re-announce the page once.

        The node counts once attached: the Clip and Studio tabs hide the tree, and a section
        capture leaves the viewer on the Clip tab.
        """
        selector = f'.tv-tree-node[data-path="/{product_id}"]'
        for attempt in range(2):
            try:
                self.frame(slot).wait_for_selector(selector, state="attached", timeout=MODEL_TIMEOUT_MS)
                return
            except Exception as error:  # noqa: BLE001 - a Playwright timeout: re-push once, then report
                if attempt:
                    raise ViewerError(f"viewer {slot} never listed /{product_id}: {error}") from error
                self.host.browser_connected({"slot": slot, "audience": "presenter"})

    def explode(self, slot: str) -> None:
        """Drive the explode slider to its end: the Python API only switches explode on."""
        self.frame(slot).evaluate("""() => { const s = document.querySelector('.tcv_animation_slider');
            if (!s) throw new Error('no explode slider'); s.value = s.max;
            s.dispatchEvent(new Event('input', {bubbles: true})); s.dispatchEvent(new Event('change', {bubbles: true})); }""")

    def free_area(self, slot: str, png: bytes) -> Box:
        return free_area(_size(png), self.overlays(slot))

    def refit(self, slot: str) -> dict[str, Any]:
        """Centre the scene in the free canvas and zoom it to FILL of the limiting axis."""
        png = self.settle(slot)
        area = self.free_area(slot, png)
        box = content_box(png)
        if box is None:
            raise ViewerError("blank frame: no scene pixels on the canvas")
        camera = self.host.camera(slot)
        width, height = _size(png)
        for _ in range(4):
            # A scene cut by the canvas edge pans its clipped side not at all: zoom out first.
            if box[0] > 1 and box[1] > 1 and box[2] < width - 1 and box[3] < height - 1:
                break
            camera = self.host.move_presenter_camera({"slot": slot, **{k: camera[k] for k in ("position", "target", "quaternion")},
                                                      "zoom": camera["zoom"] * 0.6})
            box = content_box(self.settle(slot))
            if box is None:
                raise ViewerError("blank frame while zooming out")
        right = rotate(camera["quaternion"], (1.0, 0.0, 0.0))
        up = rotate(camera["quaternion"], (0.0, 1.0, 0.0))
        mm_per_px = self._scale(slot, camera, right, box)
        passes = 0
        for passes in range(1, 4):
            # The ortho zoom scales about the canvas centre C, so the pan puts the scene centre at
            # C + (u - C) / factor: after zooming by `factor` it lands on the free-area centre u.
            factor = min((area[2] - area[0]) * FILL / max(box[2] - box[0], 1),
                         (area[3] - area[1]) * FILL / max(box[3] - box[1], 1))
            cx, cy = (box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0
            ux, uy = (area[0] + area[2]) / 2.0, (area[1] + area[3]) / 2.0
            gx, gy = width / 2.0 + (ux - width / 2.0) / factor, height / 2.0 + (uy - height / 2.0) / factor
            dx, dy = (cx - gx) * mm_per_px, -(cy - gy) * mm_per_px
            shift = [right[i] * dx + up[i] * dy for i in range(3)]
            camera = self.host.move_presenter_camera({
                "slot": slot, "quaternion": camera["quaternion"], "zoom": camera["zoom"] * factor,
                "position": [camera["position"][i] + shift[i] for i in range(3)],
                "target": [camera["target"][i] + shift[i] for i in range(3)]})
            mm_per_px /= factor
            box = content_box(self.settle(slot))
            if box is None:
                raise ViewerError("blank frame after refit")
            off = max(abs((box[0] + box[2]) / 2.0 - ux) / (area[2] - area[0]),
                      abs((box[1] + box[3]) / 2.0 - uy) / (area[3] - area[1]))
            if inside(box, area) and abs(fill_ratio(box, area) - FILL) < FILL_TOLERANCE and off < CENTRE_TOLERANCE:
                break
        return {**framing(box, area), "refit": True, "passes": passes, "mm_per_px": round(mm_per_px, 5),
                "camera": {k: camera.get(k) for k in ("position", "target", "zoom")}}

    def _scale(self, slot: str, camera: dict[str, Any], right: tuple[float, float, float], box: Box) -> float:
        """mm per canvas pixel at the current zoom, from a measured sideways pan (then restored)."""
        restore = {"slot": slot, **{k: camera[k] for k in ("position", "target", "quaternion", "zoom")}}
        step = 10.0
        for _ in range(4):
            self.host.move_presenter_camera({**restore, "position": [camera["position"][i] + right[i] * step for i in range(3)],
                                             "target": [camera["target"][i] + right[i] * step for i in range(3)]})
            shifted = content_box(self.settle(slot))
            self.host.move_presenter_camera(restore)
            if shifted is not None:
                pixels = abs((box[0] + box[2]) - (shifted[0] + shifted[2])) / 2.0
                if pixels >= 6:
                    self.settle(slot)
                    return step / pixels
            step *= 6.0
        raise ViewerError("could not measure the canvas scale: a camera pan moved no pixels")


# --------------------------------------------------------------------------- the presenter thread


class Presenter(threading.Thread):
    """Owns Playwright: every page operation runs on this one thread, in submission order.

    While idle it evaluates a no-op on the page every HEARTBEAT_S, so a crashed browser ends the
    thread and `alive()` turns false; a job still queued then fails instead of waiting forever.
    """

    def __init__(self, host: Any, url: str, width: int, height: int) -> None:
        super().__init__(name="presenter", daemon=True)
        self.host, self.url, self.viewport = host, url, (width, height)
        self.jobs: queue.Queue[tuple[Callable[[Any], Any], Future] | None] = queue.Queue()
        self.ready = threading.Event()
        self.failure: BaseException | None = None
        self.errors: list[str] = []
        self._gate = threading.Lock()
        self._closed = False

    def run(self) -> None:
        from playwright.sync_api import sync_playwright

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, args=CHROMIUM_ARGS)
                try:
                    page = browser.new_page(viewport={"width": self.viewport[0], "height": self.viewport[1]},
                                            device_scale_factor=1)
                    page.on("pageerror", lambda e: self.errors.append(str(e)))
                    page.goto(self.url, wait_until="load")
                    page.wait_for_function("document.body.dataset.ready === 'true'", timeout=MODEL_TIMEOUT_MS)
                    self.ready.set()
                    self._serve(page)
                finally:
                    browser.close()
        except BaseException as error:  # noqa: BLE001 - surfaced through `submit` and `alive`
            self.failure = error
            traceback.print_exc()
        finally:
            self._close()

    def _serve(self, page: Any) -> None:
        while True:
            try:
                job = self.jobs.get(timeout=HEARTBEAT_S)
            except queue.Empty:
                page.evaluate("1")  # raises once the page or the browser is gone
                continue
            if job is None:
                return
            work, future = job
            try:
                future.set_result(work(page))
            except BaseException as error:  # noqa: BLE001 - handed to the waiting request
                future.set_exception(error)

    def _close(self) -> None:
        with self._gate:
            self._closed = True
        self.ready.set()
        while True:
            try:
                job = self.jobs.get_nowait()
            except queue.Empty:
                return
            if job is not None:
                job[1].set_exception(ViewerError(f"presenter browser stopped: {self.failure}"))

    def alive(self) -> bool:
        with self._gate:
            return self.ready.is_set() and not self._closed

    def submit(self, work: Callable[[Any], Any]) -> Future:
        """Queue `work(page)`; the returned future always completes, also when the browser dies."""
        if not self.ready.wait(timeout=120.0):
            raise ViewerError("presenter browser did not start within 120 s")
        future: Future = Future()
        with self._gate:
            if self._closed:
                raise ViewerError(f"presenter browser is not running: {self.failure}")
            self.jobs.put((work, future))
        return future

    @staticmethod
    def result(future: Future, timeout: float, what: str) -> Any:
        """The job's result; ViewerError when it is not done within `timeout` (it keeps running)."""
        deadline = time.monotonic() + timeout
        while not future.done():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ViewerError(f"{what} did not finish within {timeout:.0f} s; the presenter is still "
                                  "running it. `viewer.py stop` then `serve` resets the host")
            wait([future], timeout=min(1.0, remaining))  # sliced, so a SIGTERM handler runs promptly
        return future.result()

    def stop(self) -> None:
        self.jobs.put(None)
        self.join(timeout=30)


def follow_user_camera(view: str, user_connected: bool) -> bool:
    """`current` captures what the user is looking at, when a user's tab is connected.

    Every other view sets its own camera (preset, section, refit), and every host camera change
    reaches both viewer pairs, so the two cameras differ only after the user turned their view.
    """
    return view == "current" and user_connected


def capture_target(value: Any) -> Path:
    """The PNG a capture writes: an absolute `.png` path straight inside an existing directory.

    `viewer.py capture` resolves `--out` and creates its directory; the host creates none and
    writes through no symlink, so a request can only add or replace a PNG where the CLI made room.
    """
    out = Path(value) if isinstance(value, str) and value else None
    if out is None or not out.is_absolute() or out.suffix.lower() != ".png":
        raise ViewerError(f"`out` must be an absolute path to a .png file, got {value!r}")
    if not out.parent.is_dir():
        raise ViewerError(f"{out.parent} is not a directory; `viewer.py capture` creates it")
    if out.is_symlink() or (out.exists() and not out.is_file()):
        raise ViewerError(f"{out} exists and is not a regular file")
    return out


def capture(host: Any, page: Any, request: dict[str, Any]) -> dict[str, Any]:
    """One capture on the presenter page: apply the view, refit, screenshot (runs on the presenter)."""
    view = parse_view(str(request.get("view")))
    out = capture_target(request.get("out"))
    crop = request.get("crop") or "page"
    if crop not in CROPS:
        raise ViewerError(f"crop must be one of {CROPS}")
    joint, zoom = request.get("joint"), request.get("zoom")
    if view == "section" and not joint:
        raise ViewerError("--view section needs --joint J-00x: the plane runs through that joint's axis")
    refit = request.get("refit")
    refit = view not in ("section", "current") if refit is None else bool(refit)
    state = host.state()
    if "A" not in state["versions"]:
        raise ViewerError("nothing shown yet; run `viewer.py show` first")
    driver = Driver(host, page)
    slots = ["a", "b"] if state["mode"] == "split" else ["a"]
    product = state["versions"]["A"]["product_id"]
    for slot in slots:
        driver.wait_model(product, slot)
    result: dict[str, Any] = {}
    camera_from = "user" if follow_user_camera(view, host.user_connected()) else "presenter"
    if camera_from == "user":
        for slot in slots:
            host.set_camera(slot, host.camera(slot, "user"), ("presenter",))
    if view != "current":
        result = host.apply_view({"view": view, "joint": joint, "zoom": zoom})
        for slot in slots:
            driver.wait_model(product, slot)
            driver.settle(slot, minimum_s=1.0)
    if view == "section":
        result["clip"] = host.apply_clip()
        for slot in slots:
            driver.settle(slot, minimum_s=1.0)
    if view == "exploded":
        for slot in slots:
            driver.explode(slot)
            driver.settle(slot, minimum_s=1.0)
    page.mouse.move(page.viewport_size["width"] - 2, page.viewport_size["height"] - 2)
    page.evaluate("() => window.cadPanel && window.cadPanel.refresh()")
    frames: dict[str, Any] = {}
    if refit:
        host.sync_hold.set()
        try:
            frames["a"] = driver.refit("a")
        finally:
            host.sync_hold.clear()
        if "b" in slots:  # side by side: B shows A's refitted camera
            host.move_presenter_camera({"slot": "b", **host.camera("a")})
        if host.user_connected():  # the user's tab follows the refit, as it follows every camera change
            for slot in slots:
                host.set_camera(slot, host.camera(slot), ("user",))
    cameras = {slot: host.camera(slot, "presenter") for slot in slots}
    for slot in slots:
        if slot not in frames:
            png = driver.settle(slot, minimum_s=0.6)
            frames[slot] = framing(content_box(png), driver.free_area(slot, png))
    page.wait_for_timeout(400)
    if crop == "canvas":
        driver.canvas("a").screenshot(path=str(out))
    elif crop == "viewer":
        page.locator("#stage").screenshot(path=str(out))
    else:
        page.screenshot(path=str(out))
    blank = any(f["content_px"] is None for f in frames.values())
    final_state = host.state()
    return {"status": "fail" if blank else "pass", "out": str(out), "view": view, "crop": crop,
            "version": final_state["selected"]["A"]["label"],
            "viewer_state": {"mode": final_state["mode"], "view": final_state["view"],
                             "animation": final_state["animation"], "selected": final_state["selected"]},
            "selected": final_state["selected"],
            "viewport": [page.viewport_size["width"], page.viewport_size["height"]], "mode": state["mode"],
            "camera_from": camera_from, "frames": frames, "cameras": cameras, "host": result,
            "animation": final_state["animation"]}
