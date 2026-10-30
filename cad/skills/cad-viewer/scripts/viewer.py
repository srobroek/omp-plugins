# /// script
# requires-python = "==3.12.*"
# dependencies = [
#     "cadquery-ocp-novtk==8.0.1.1.0",
#     "ocp_viewer==1.2.0",
#     "playwright==1.64.1",
#     "pyyaml>=6.0",
# ]
# ///
"""Drive OCP CAD Viewer and the cad-viewer side panel for a cad-model hardware record.

Usage (run viewer through cad-flow's shared environment):
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py serve [--session NAME] [--idle-timeout MIN]
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py stop [--session NAME]
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py show HW [--version VERSION] [--check FILE] [--session NAME]
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py compare A B --hw HW [--session NAME]
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py gallery HW [--session NAME]
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py mode single|split [--session NAME]
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py parts ACTION [PN|GROUP] [--session NAME]
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py animate (--joint ID --from VALUE --to VALUE | --case CASE) [--session NAME]
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py studio [OPTIONS] [--session NAME]
    uv run --script skill://cad-flow/scripts/run.py cad-viewer/scripts/viewer.py capture --view VIEW --out PNG [--session NAME]

`serve` reuses one detached host per project and session. Session files use an automatic OMP or
Claude Code session ID when available, or a `--session` / `CAD_VIEWER_SESSION_NAME` value, plus
the project root. The project root is the directory containing `hw/`. `CAD_VIEWER_SESSION` keeps
its legacy behavior and overrides the session-file path.

stdout: one JSON object per command. Exit 0 = done; 1 = a joint value outside its limits
(`animate`, nothing pushed) or a blank capture; 2 = usage, record, viewer, or browser error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cadviewer import LimitError, ViewerError, session  # noqa: E402
from cadviewer.host import SECTION_ZOOM  # noqa: E402

SCRIPT = Path(__file__).resolve()


def view_arg(text: str) -> str:
    from cadviewer.capture import parse_view

    try:
        return parse_view(text)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def fraction_arg(text: str) -> float:
    value = float(text)
    if not 0.0 <= value <= 1.0:
        raise argparse.ArgumentTypeError("must be within 0..1")
    return value


def project_root(args: argparse.Namespace) -> Path:
    """Resolve a command to the project directory containing its hw/ record."""
    hardware = getattr(args, "hw", None)
    if hardware is None:
        cwd = Path.cwd().resolve()
        return cwd.parent if cwd.name == "hw" else cwd
    hw = hardware.expanduser().resolve()
    return hw.parent if hw.name == "hw" else hw


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="viewer.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def add_session(command_parser: argparse.ArgumentParser) -> None:
        command_parser.add_argument("--session", help="session name; overrides an automatic harness ID")

    serve = sub.add_parser("serve", help="start or reuse the viewer host; prints its URL, PID and stop command")
    add_session(serve)
    for flag in ("--panel-port", "--port-a", "--port-b"):
        serve.add_argument(flag, type=int, default=0, help="0 picks a free port")
    serve.add_argument("--width", type=int, default=1440, help="presenter page width (captures)")
    serve.add_argument("--height", type=int, default=900, help="presenter page height (captures)")
    serve.add_argument("--idle-timeout", type=int, default=30,
                       help="stop after this many minutes without viewer API commands; 0 disables")
    stop = sub.add_parser("stop", help="stop the viewer host and its OCP viewers")
    add_session(stop)

    show = sub.add_parser("show", help="push one version; the camera is kept on later pushes")
    add_session(show)
    show.add_argument("hw", type=Path, help="hardware record directory (hw/)")
    show.add_argument("--version", default="latest", help="vN or latest (default)")
    show.add_argument("--check", type=Path, help="cad-model check JSON for this version (panel findings)")

    compare = sub.add_parser("compare", help="push two versions for the A/B side-by-side with synced camera")
    add_session(compare)
    compare.add_argument("a", help="version A label")
    compare.add_argument("b", help="version B label")
    compare.add_argument("--hw", type=Path, required=True)
    compare.add_argument("--check-a", type=Path)
    compare.add_argument("--check-b", type=Path)

    gallery = sub.add_parser("gallery", help="open HW in the preview gallery; prints its URL and every file path")
    add_session(gallery)
    gallery.add_argument("hw", type=Path, help="hardware record directory (hw/)")
    gallery.add_argument("--version", default="latest", help="vN or latest (default)")

    mode = sub.add_parser("mode", help="switch A/B: one version, or side-by-side")
    add_session(mode)
    mode.add_argument("mode", choices=("single", "split"))
    mode.add_argument("--active", choices=("A", "B"), default="A")

    parts = sub.add_parser("parts", help="hide, isolate, ghost the rest, or reset, as the panel buttons do")
    add_session(parts)
    parts.add_argument("action", choices=("hide", "iso", "ghost", "reset"))
    parts.add_argument("target", nargs="?", help="PN or subassembly id (hide and iso)")

    animate = sub.add_parser("animate", help="animate one joint within its assembly.yaml limits, or a motion plan case")
    add_session(animate)
    target = animate.add_mutually_exclusive_group(required=True)
    target.add_argument("--joint", help="movable joint id, e.g. J-002")
    target.add_argument("--case", help="motion plan case: default (generated) or hw/motion/cases/<case>; every "
                                       "driver it moves plays at the plan's fps")
    animate.add_argument("--from", dest="start", type=float, help="start value (deg or mm), with --joint")
    animate.add_argument("--to", dest="end", type=float, help="end value (deg or mm), with --joint")
    animate.add_argument("--steps", type=int, help="keyframes, >= 2, with --joint (default 13)")
    animate.add_argument("--seconds", type=float, help="duration with --joint (default 4)")
    animate.add_argument("--at", type=fraction_arg, help="hold the playback at this fraction 0..1")

    studio = sub.add_parser("studio", help="Studio mode for look-dev: environment, tone mapping, exposure")
    add_session(studio)
    studio.add_argument("--environment", help="StudioEnvironment name, e.g. studio, white_studio_05, photo_studio_01")
    studio.add_argument("--tone-mapping", choices=("neutral", "ACES", "none"))
    studio.add_argument("--background", choices=("environment", "transparent", "gradient", "gradient-dark",
                                                   "white", "grey", "darkgrey"))
    studio.add_argument("--texture-mapping", choices=("triplanar", "parametric"))
    for flag in ("--exposure", "--env-intensity", "--env-rotation", "--shadow-intensity", "--shadow-softness",
                 "--ao-intensity"):
        studio.add_argument(flag, type=float)

    capture = sub.add_parser("capture", help="capture the displayed version into an immutable bundle")
    add_session(capture)
    capture.add_argument("--view", type=view_arg, required=True)
    capture.add_argument("--out", type=Path, help="explicit PNG path under .cad-work only")
    capture.add_argument("--replace", action="store_true", help="retain and replace a conflicting capture bundle")
    capture.add_argument("--joint", help="section plane through this joint's axis (--view section)")
    capture.add_argument("--zoom", type=float, help=f"section close-up zoom (default {SECTION_ZOOM:g})")
    capture.add_argument("--crop", choices=("page", "viewer", "canvas"), default="page")
    capture.add_argument("--refit", action=argparse.BooleanOptionalAction, default=None,
                         help="default: refit every view except section and current")

    host = sub.add_parser("host", help=argparse.SUPPRESS)
    host.add_argument("--session", type=Path, required=True)
    host.add_argument("--panel-port", type=int, required=True)
    host.add_argument("--ports", type=json.loads, required=True,
                      help='viewer ports by name: {"a": .., "b": .., "presenter_a": .., "presenter_b": ..}')
    host.add_argument("--width", type=int, required=True)
    host.add_argument("--height", type=int, required=True)
    host.add_argument("--idle-timeout", type=int, default=30)
    return parser



def request_body(args: argparse.Namespace) -> tuple[str, str, dict[str, Any]]:
    """(method, route, body) for the commands that only talk to the host."""
    def path(p: Path | None) -> str | None:
        return None if p is None else str(p.resolve())

    if args.command == "show":
        return "POST", "/api/show", {"hw": path(args.hw), "version": args.version, "check": path(args.check)}
    if args.command == "compare":
        return "POST", "/api/compare", {"hw": path(args.hw), "a": args.a, "b": args.b,
                                        "check_a": path(args.check_a), "check_b": path(args.check_b)}
    if args.command == "gallery":
        return "POST", "/api/gallery", {"hw": path(args.hw), "version": args.version}
    if args.command == "mode":
        return "POST", "/api/mode", {"mode": args.mode, "active": args.active}
    if args.command == "parts":
        if args.action in ("hide", "iso") and not args.target:
            raise ViewerError(f"parts {args.action} needs a PN or subassembly id")
        return "POST", "/api/parts", {"action": args.action, "target": args.target}
    if args.command == "animate":
        if args.case is not None:
            if any(v is not None for v in (args.start, args.end, args.steps, args.seconds)):
                raise ViewerError("--case plays the plan's own frames: --from, --to, --steps and --seconds go with --joint")
            return "POST", "/api/animate", {"case": args.case, "at": args.at}
        if args.start is None or args.end is None:
            raise ViewerError("--joint needs --from and --to")
        steps = 13 if args.steps is None else args.steps
        if steps < 2:
            raise ViewerError("--steps must be at least 2")
        return "POST", "/api/animate", {"joint": args.joint, "from": args.start, "to": args.end,
                                        "steps": steps, "seconds": 4.0 if args.seconds is None else args.seconds,
                                        "at": args.at}
    if args.command == "capture":
        return "POST", "/api/capture", {"view": args.view, "out": path(args.out), "crop": args.crop,
                                        "joint": args.joint, "zoom": args.zoom, "refit": args.refit,
                                        "replace": args.replace}
    if args.command == "studio":
        keys = ("environment", "tone_mapping", "background", "texture_mapping", "exposure", "env_intensity",
                "env_rotation", "shadow_intensity", "shadow_softness", "ao_intensity")
        return "POST", "/api/studio", {key: getattr(args, key) for key in keys}
    raise ViewerError(f"{args.command} is not a host request")


def summarise(command: str, answer: dict[str, Any], base_url: str) -> dict[str, Any]:
    """Short stdout for state-returning commands: what each slot shows, the view state, and the
    preview gallery URL of each shown version."""
    if "versions" not in answer or command == "gallery":
        return answer
    versions = {k: {"label": v["label"], "selected": answer["selected"][k]["version"], "parts": len(v["parts"]),
                    "check": (v.get("check") or {}).get("status"),
                    "gallery": f"{base_url}gallery?version={v['label']}"} for k, v in answer["versions"].items()}
    return {"status": "pass", "command": command, "mode": answer["mode"], "active": answer["active"],
            "slots": answer["slots"], "view": answer["view"], "versions": versions, "latest": answer["latest"]}


def run(args: argparse.Namespace) -> int:
    path = session.session_path(project_root(args), args.session if args.command != "host" else None)
    if args.command == "host":
        from cadviewer import host

        return host.run(args.session, args.panel_port, args.ports, args.width, args.height, args.idle_timeout)
    if args.command == "serve":
        data, reused = session.start(path, SCRIPT, args.panel_port, args.port_a, args.port_b,
                                     (args.width, args.height), args.idle_timeout)
        emit(session.describe(data, reused, args.session or os.environ.get("CAD_VIEWER_SESSION_NAME")))
        return 0
    if args.command == "stop":
        emit(session.stop(path))
        return 0
    if args.command == "capture" and args.out is not None:
        args.out = args.out.resolve()
    live = session.require_session(path)
    method, route, body = request_body(args)
    answer = summarise(args.command, session.call(live, method, route, body), live["url"])
    answer.setdefault("status", "pass")
    emit(answer)
    return 0 if answer["status"] == "pass" else 1


def emit(data: dict[str, Any]) -> None:
    print(json.dumps(data, indent=2, default=str))


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except LimitError as error:
        emit({"status": "fail", "error": str(error), "findings": error.findings})
        return 1
    except ViewerError as error:
        emit({"status": "error", "error": str(error)})
        return 2


if __name__ == "__main__":
    sys.exit(main())
