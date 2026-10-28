# /// script
# requires-python = "==3.12.*"
# dependencies = [
#     "build123d==0.13.0",
#     "cadquery-ocp-novtk==8.0.1.1.0",
#     "bd_warehouse==0.4.0",
#     "ocp_viewer==1.2.0",
#     "playwright==1.64.1",
#     "pyyaml>=6.0",
# ]
# ///
"""Review renders of the cad-design reference lamp arm, one PNG set per kernel.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-design/scripts/review_render.py --out DIR [--kernels cadquery build123d]
        [--parts-root DIR] [--hw HW] [--pose nominal|zero] [--port 0]

Builds the checkout's `cad/examples/lamp-arm` parts with build_reference.py into
DIR/<kernel>/parts (or reads `<kernel>/<PN>.step` under --parts-root), poses
them with cad-motion's chain at the joints' nominal values, adds ISO 4762 M6
socket head cap screws from bd_warehouse in the base counterbores, and renders
through a headless OCP CAD Viewer (ocp_viewer) captured by Playwright Chromium
on SwiftShader WebGL:

    DIR/<kernel>/iso.png    the whole arm
    DIR/<kernel>/base.png   base, boss and hub close-up
    DIR/<kernel>/elbow.png  J-002 clevis close-up
    DIR/<kernel>/head.png   head knuckle, neck and shade close-up

Review aid only: a render is not a check result. The viewer process and the
browser are stopped before exit; the JSON reports the viewer PID and whether
its port is free again.

stdout: JSON {pngs, viewer: {pid, port, port_free_after}}. Exit 0 = every PNG
written, 2 = build, viewer, or browser failure.
"""

from __future__ import annotations

import argparse
import ast
import importlib.util
import json
import math
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent
POSE_PATH = SKILL.parent / "cad-motion" / "scripts" / "pose.py"
EXAMPLE = SKILL.parent.parent / "examples" / "lamp-arm"
DEFAULT_HW = EXAMPLE / "hw"
BASE_MODEL = DEFAULT_HW / "parts" / "LMP-0001" / "model.py"
CHROMIUM_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
COLORS = {"fdm": "#3a3f44", "cnc": "#c4c9cf", "purchased": "#6f747a"}
HEAD_COLOR = "#e8e2d6"  # LMP-0004 printed in a light PETG so the shade reads against the dark base
SCREW_COLOR = "#2b2b2b"
VIEWPORT = (1400, 1000)
CAD_MODEL_SCRIPTS = SKILL.parent / "cad-model" / "scripts"
sys.path.insert(0, str(CAD_MODEL_SCRIPTS))
from cadmodel import scriptenv  # noqa: E402 - standard library helper


def load_module(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def port_open(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def build_parts(kernel: str, out: Path) -> Path:
    parts = out / kernel / "parts"
    command = scriptenv.script_command(HERE / "build_reference.py", "--kernel", kernel, "--out", str(parts))
    result = subprocess.run(command, stdout=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"build_reference.py --kernel {kernel} exited {result.returncode}: {result.stdout[-2000:]}")
    return parts


def process_of(hw: Path) -> dict[str, str]:
    import yaml

    return {r.parent.name: yaml.safe_load(r.read_text(encoding="utf-8")).get("process", "")
            for r in sorted((hw / "parts").glob("*/part.yaml"))}


def model_params(path: Path) -> dict[str, Any]:
    """A model file's PARAMS literal, read without importing its kernel."""
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "PARAMS" for t in node.targets):
            return ast.literal_eval(node.value)
    raise RuntimeError(f"{path}: no PARAMS literal")


def screws() -> list[tuple[str, Any]]:
    """ISO 4762 M6 screws seated on the base counterbore floors, in base coordinates."""
    import build123d as bd
    from bd_warehouse.fastener import SocketHeadCapScrew

    p = model_params(BASE_MODEL)
    floor = p["height"] - p["cbore_depth"]
    placed = []
    for i, angle in enumerate(p["mount_angles"]):
        a = math.radians(angle)
        screw = SocketHeadCapScrew(size="M6-1", length=20, fastener_type="iso4762", simple=True)
        location = bd.Pos(p["mount_r"] * math.cos(a), p["mount_r"] * math.sin(a), floor)
        placed.append((f"ISO 4762 M6x20 ({i + 1})", (location * screw).wrapped))
    return placed


def scene(kernel_parts: Path, hw: Path, pose_name: str, pose: Any) -> tuple[list[Any], list[str], list[str], dict[str, Any]]:
    assembly = pose.load_assembly(hw)
    parts = pose.load_definitions(hw, kernel_parts)
    chain = pose.assembly_chain(assembly, parts)
    values = chain.complete({}) if pose_name == "nominal" else {j.id: 0.0 for j in chain.movable}
    transforms = chain.transforms(values)
    process = process_of(hw)
    shapes, names, colors = [], [], []
    for oid in chain.ids:  # one shape per occurrence, its PN's definition at T = D P
        pn = chain.pn(oid)
        shapes.append(pose.placed(parts[pn].shape, transforms[oid]))
        names.append(pose.component_name(parts[pn], chain.inventory.get(oid)) or parts[pn].name)
        colors.append(HEAD_COLOR if pn == "LMP-0004" else COLORS.get(process.get(pn, ""), "#999999"))
    for name, shape in screws():
        shapes.append(pose.placed(shape, transforms[chain.root]))
        names.append(name)
        colors.append(SCREW_COLOR)
    return shapes, names, colors, {"values": values, "transforms": transforms}


def views(state: dict[str, Any]) -> dict[str, tuple[tuple[float, ...], tuple[float, ...], float]]:
    """Camera (position, target, zoom) per view; close-up targets follow the posed joints.

    The viewer fits the whole scene and then applies `zoom`; `position` sets the view direction.
    """
    t = state["transforms"]
    elbow = t["LMP-0002"].apply((160.0, 0.0, 40.0))
    head = t["LMP-0004"].apply((425.0, 0.0, 36.0))
    whole = (head[0] / 2.0, 0.0, 70.0)

    def eye(target, direction, zoom):
        n = math.sqrt(sum(c * c for c in direction))
        return tuple(target[i] + direction[i] / n * 600.0 for i in range(3)), target, zoom

    return {
        "iso": eye(whole, (0.9, -1.3, 0.8), 1.5),
        "base": eye((0.0, 0.0, 22.0), (-0.6, -1.0, 0.9), 3.2),
        "elbow": eye(elbow, (0.35, -1.0, 0.5), 8.0),
        "head": eye(head, (0.9, -1.1, 0.35), 4.5),
    }


def render(args: argparse.Namespace) -> dict[str, Any]:
    from ocp_viewer import Camera, show
    from playwright.sync_api import sync_playwright

    pose = load_module("cad_motion_pose", POSE_PATH)
    roots = {k: (args.parts_root / k if args.parts_root else build_parts(k, args.out)) for k in args.kernels}
    port = args.port or free_port()
    log = (args.out / "viewer.log").open("w")
    viewer = subprocess.Popen([sys.executable, "-m", "ocp_viewer", "--host", "127.0.0.1", "--port", str(port),
                               "--theme", "light", "--perspective"], stdout=log, stderr=subprocess.STDOUT)
    pngs: dict[str, dict[str, str]] = {}
    try:
        deadline = time.monotonic() + 120
        while not port_open(port):
            if viewer.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError(f"ocp_viewer did not start on port {port}; see {log.name}")
            time.sleep(0.5)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=CHROMIUM_ARGS)
            try:
                page = browser.new_page(viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]})
                page.goto(f"http://127.0.0.1:{port}", wait_until="load")
                page.wait_for_selector("canvas")
                time.sleep(2.0)
                for kernel, root in roots.items():
                    shapes, names, colors, state = scene(root, args.hw, args.pose, pose)
                    folder = args.out / kernel
                    folder.mkdir(parents=True, exist_ok=True)
                    pngs[kernel] = {}
                    for view, (position, target, zoom) in views(state).items():
                        show(*shapes, names=names, colors=colors, port=port, position=position, target=target,
                             zoom=zoom, up="Z", ortho=False, reset_camera=Camera.RESET, tools=False, glass=True,
                             grid=(False, False, False), axes=False, black_edges=False)
                        time.sleep(3.0)
                        path = folder / f"{view}.png"
                        page.locator("canvas").first.screenshot(path=str(path))
                        pngs[kernel][view] = str(path)
            finally:
                browser.close()
    finally:
        viewer.terminate()
        try:
            viewer.wait(timeout=20)
        except subprocess.TimeoutExpired:
            viewer.kill()
            viewer.wait()
        log.close()
    return {"pngs": pngs, "pose": args.pose,
            "viewer": {"pid": viewer.pid, "port": port, "port_free_after": not port_open(port)}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Render review PNGs of the cad-design reference lamp arm")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--kernels", nargs="+", choices=["cadquery", "build123d"], default=["cadquery", "build123d"])
    parser.add_argument("--parts-root", type=Path)
    parser.add_argument("--hw", type=Path, default=DEFAULT_HW)
    parser.add_argument("--pose", choices=["nominal", "zero"], default="nominal")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args(argv)
    if args.hw == DEFAULT_HW and not DEFAULT_HW.is_dir():
        print(json.dumps({"error": f"cad/examples/lamp-arm example is missing: expected {DEFAULT_HW}"}))
        return 2
    if not BASE_MODEL.is_file():
        print(json.dumps({"error": f"cad/examples/lamp-arm base model is missing: expected {BASE_MODEL}"}))
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    try:
        report = render(args)
    except Exception as error:
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 2
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
