# /// script
# requires-python = ">=3.11,<3.15"
# dependencies = ["pyyaml>=6.0", "imageio-ffmpeg==0.6.0"]
# ///
"""Plan and render the motion of a built cad-model version: coverage check, animated GLB, frames,
contact sheet, MP4, and an optional FreeCAD cross-check of the coupling laws.

Usage:
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/motion.py plan --hw HW --version vN|latest
        [--case CASE | --plan .cad-work/UNIT/plan.yaml] [--print-default] [--frames-out .cad-work/UNIT/frames.json]
    uv run --script skill://cad-flow/scripts/run.py cad-motion/scripts/motion.py render --hw HW --version vN|latest
        [--case CASE | --plan .cad-work/UNIT/plan.yaml] [--outputs glb,sheet,video,frames] [--size 1280x720]
        [--crosscheck freecad] [--replace] [--out-dir .cad-work/UNIT/render]

Inputs: the version's record snapshot (hw/versions/vN/record/) gives the joints and couplings; plan.py
expands the plan into frames through pose.py's Chain, the only kinematics. The plan is case
`default` (generated from the record, never authored), an accepted case at
hw/motion/cases/<case>/plan.yaml, or a scratch plan (`--plan`, under .cad-work/, renders only to
--out-dir).

plan: validates and expands the plan and prints the coverage report (plan.py `coverage`).
`--print-default` prints the generated default plan as YAML, a start for an authored case.
`--frames-out` writes the expanded frames (the input of freecad_assembly.py --frames).

render: runs the coverage check first; a failing plan writes nothing. It then builds, as --outputs
asks (default glb,sheet):
    motion.glb         the version's assembly.glb with one animation clip (motion_glb.py): LINEAR
                       translation and rotation keys at the plan frames, refined until the interpolation
                       stays within 0.1 mm / 0.1 deg of the Chain
    contact-sheet.png  the start frame and each segment's last frame, captioned (cad-render --motion)
    video.mp4          every frame, H.264 at the plan's fps, checked for constant frame timing
    frames/            every frame as PNG
and always plan.json (the effective plan), coverage.json and result.json. cad-render renders the
frames with one camera per segment, fitted to the bounds the segment sweeps (a hold without its own
camera keeps the framing before it). `--crosscheck freecad` first runs freecad_assembly.py --frames
on the same frames: FreeCAD solves the coupled record and every joint must agree within 1e-3
(crosscheck.json, evidence/motion.FCStd). Without --out-dir the files publish as the immutable
bundle hw/motion/vN/<case>/; the same recipe reuses it, another needs --replace.

stdout: JSON. Exit 0 = pass or flagged (a declared partial plan), 1 = a coverage gap or limit
finding, a cross-check deviation or a render parity failure (nothing published), 2 = a plan, usage
or infrastructure error, or a cross-check without a result.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
import struct
import subprocess
import sys
import time
import traceback
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve()
SKILLS = HERE.parents[2]
RENDER_PY = SKILLS / "cad-render" / "scripts" / "render.py"
FREECAD_PY = HERE.with_name("freecad_assembly.py")
sys.path.insert(0, str(SKILLS / "cad-model" / "scripts"))
from cadmodel import scriptenv  # noqa: E402 - standard-library-only launcher


def _load(name: str, path: Path) -> Any:
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"{path} not found")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


pose = _load("cad_motion_pose", HERE.with_name("pose.py"))
plan = _load("cad_motion_plan", HERE.with_name("plan.py"))
motion_glb = _load("cad_motion_glb", HERE.with_name("motion_glb.py"))
LAYOUT = pose.LAYOUT

OUTPUTS = ("glb", "sheet", "video", "frames")
DEFAULT_OUTPUTS = "glb,sheet"
SIZE = re.compile(r"^([1-9][0-9]{2,3})x([1-9][0-9]{2,3})$")
DEFAULT_SIZE = "1280x720"
PRODUCER = "cad-motion motion.py"
RECIPE_VERSION = 1  # bump when the outputs change for the same inputs
CRF = 18
SHEET_COLUMNS, SHEET_TILE_WIDTH = 4, 320
RENDER_TIMEOUT_S, FREECAD_TIMEOUT_S, ENCODE_TIMEOUT_S = 3600, 900, 900


class Failed(RuntimeError):
    """A check failed (exit 1); `report` is printed."""

    def __init__(self, report: dict[str, Any]) -> None:
        super().__init__(report.get("error") or report.get("status"))
        self.report = report


# --------------------------------------------------------------------------- inputs


class Context:
    """One built version: its record snapshot's chain, built pose and GLB node map."""

    def __init__(self, hw: Path, requested: str) -> None:
        self.hw = Path(hw)
        self.version, self.folder, self.record = LAYOUT.built_version(self.hw, requested)
        self.manifest = json.loads((self.folder / "manifest.json").read_text(encoding="utf-8"))
        assembly = pose.load_assembly(self.hw, self.record)
        self.attach = list(self.manifest.get("attach") or [])
        joints = [*assembly.joints, *pose.attach_joints(self.attach, assembly)]
        self.chain = pose.build_chain(joints, assembly.occurrences, couplings=assembly.couplings)
        values = (self.manifest.get("pose") or {}).get("values") or {}
        missing = [j.id for j in self.chain.movable if j.id not in values]
        if missing:
            raise pose.MotionError(f"{self.version}: manifest.json pose has no value for {missing}")
        self.built = self.chain.transforms({j.id: float(values[j.id]) for j in self.chain.movable})
        self.unbuilt = {oid: self.built[oid].inverse() for oid in self.chain.ids}

    def nodes(self) -> dict[str, list[int]]:
        """Occurrence id -> its GLB node indices, from part-map.json; every occurrence must be in the chain."""
        part_map = json.loads((self.folder / "part-map.json").read_text(encoding="utf-8"))
        if part_map.get("schema_version") != 2:
            raise pose.MotionError(f"{self.version}: part-map.json is not schema 2; build a new version")
        nodes = {oid: list(entry["node_indices"]) for oid, entry in part_map["occurrences"].items()}
        stray = sorted(set(nodes) - set(self.chain.ids))
        if stray:
            raise pose.MotionError(f"{self.version}: occurrences {stray} are in the GLB but not in the joint chain")
        return nodes

    def deltas(self, settings: Mapping[str, float]) -> dict[str, list[list[float]]]:
        """Each occurrence's rigid motion from the built pose, T(settings) T_built^-1, as 3x4 rows (mm)."""
        placed = self.chain.transforms(self.chain.complete(settings))
        return {oid: _rows(placed[oid] @ self.unbuilt[oid]) for oid in self.chain.ids}


def _rows(rigid: Any) -> list[list[float]]:
    return [[*rigid.rot[i], rigid.trans[i]] for i in range(3)]


def select_plan(args: argparse.Namespace, ctx: Context) -> tuple[dict[str, Any], str]:
    """(effective plan, its source): `--plan` (scratch), an authored case, or the generated default."""
    if args.plan is not None:
        path = LAYOUT.scratch_path(ctx.hw, args.plan, "--plan")
        data = plan.read_plan(path)
        case = args.case or (data.get("case") if isinstance(data, dict) else None) or "scratch"
        if case == plan.DEFAULT_CASE:
            raise plan.PlanError(["case `default` is the generated plan; a --plan file names another case"])
        if not plan.CASE_ID.match(str(case)):
            raise plan.PlanError([f"case must match {plan.CASE_ID.pattern}, got {case!r}"])
        return plan.prepare(ctx.chain, data, case), LAYOUT.relative(ctx.hw, args.plan)  # unresolved, like hw
    case = args.case or plan.DEFAULT_CASE
    effective = plan.load(ctx.chain, ctx.hw, LAYOUT, case)
    source = ("generated from the record" if case == plan.DEFAULT_CASE
              else LAYOUT.relative(ctx.hw, plan.case_path(ctx.hw, case, LAYOUT)))
    return effective, source


def frames_document(ctx: Context, effective: Mapping[str, Any], frames: Sequence[Any]) -> dict[str, Any]:
    """The expanded frames, as freecad_assembly.py --frames reads them."""
    return {"schema": 1, "version": ctx.version, "case": effective["case"], "fps": effective["fps"],
            "frames": [{"index": f.index, "segment": f.segment, "settings": dict(f.settings), "values": dict(f.values)}
                       for f in frames]}


# --------------------------------------------------------------------------- render spec and sheet


def _value(jid: str, value: float, unit: str) -> str:
    return f"{jid}={round(value, 3):g}{'°' if unit == 'deg' else ' mm'}"


def render_spec(ctx: Context, effective: Mapping[str, Any], frames: Sequence[Any], spans: Sequence[Any],
                rendered: set[int]) -> dict[str, Any]:
    """cad-render's --motion input: GLB-frame deltas per frame, camera groups, parity checks, sheet tiles."""
    nodes = ctx.nodes()
    deltas = [{oid: motion_glb.glb_pose(rows) for oid, rows in ctx.deltas(f.settings).items() if oid in nodes}
              for f in frames]
    groups: dict[int, dict[str, Any]] = {}
    for span in spans:
        group = groups.setdefault(span.group, {"id": span.id, "camera": span.camera, "fit": set(), "render": []})
        group["fit"].update(range(span.start, span.last + 1))
    for frame in frames:
        if frame.index in rendered:
            groups[spans[frame.segment].group]["render"].append(frame.index)
    for group in groups.values():
        group["fit"] = sorted(group["fit"])
    units = {j.id: j.unit for j in ctx.chain.independent}
    tiles = [{"frame": 0, "lines": ["0. start (frame 0)",
                                    " ".join(_value(k, v, units[k]) for k, v in frames[0].settings.items())]}]
    for number, span in enumerate(spans, start=1):
        tiles.append({"frame": span.last, "lines": [f"{number}. {span.id} (frame {span.last})",
                                                    " ".join(_value(k, v, units[k])
                                                             for k, v in frames[span.last].settings.items())]})
    ordered = sorted(rendered)
    picks = sorted({ordered[0], ordered[len(ordered) // 2], ordered[-1]}) if ordered else []
    check = {}
    for index in picks:
        placed = ctx.chain.transforms(frames[index].values)
        check[str(index)] = {oid: motion_glb.glb_pose(_rows(placed[oid])) for oid in nodes}
    return {"schema": 1, "version": ctx.version, "case": effective["case"], "groups": list(groups.values()),
            "frames": [{"index": f.index, "deltas": d} for f, d in zip(frames, deltas)], "check": check,
            "sheet": {"columns": min(SHEET_COLUMNS, len(tiles)), "tile_width": SHEET_TILE_WIDTH,
                      "tiles": tiles if any(t["frame"] in rendered for t in tiles) else []}}


def _run_json(command: list[str], log: Path, timeout: float, what: str) -> tuple[int, dict[str, Any]]:
    """Run a sibling script in its own uv environment; (exit code, its JSON stdout); stderr goes to `log`."""
    try:
        with log.open("w", encoding="utf-8") as stderr:
            proc = subprocess.run(command, stdout=subprocess.PIPE, stderr=stderr, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise pose.MotionError(f"{what} did not finish within {timeout} s (log: {log})") from error
    except FileNotFoundError as error:
        raise pose.MotionError(f"{what}: uv is not on PATH") from error
    try:
        return proc.returncode, json.loads(proc.stdout)
    except json.JSONDecodeError:
        tail = "\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-15:])
        raise pose.MotionError(f"{what} exited {proc.returncode} without a JSON result (log: {log}):\n{tail}") from None


# --------------------------------------------------------------------------- video


def _boxes(data: bytes, start: int, end: int):
    offset = start
    while offset + 8 <= end:
        size, kind = struct.unpack_from(">I4s", data, offset)
        header = 8
        if size == 1:
            size, header = struct.unpack_from(">Q", data, offset + 8)[0], 16
        elif size == 0:
            size = end - offset
        if size < header or offset + size > end:
            raise ValueError(f"malformed MP4 box {kind!r} at {offset}")
        yield kind.decode("latin-1"), offset + header, offset + size
        offset += size


def _child(data: bytes, start: int, end: int, kind: str) -> tuple[int, int] | None:
    return next(((s, e) for k, s, e in _boxes(data, start, end) if k == kind), None)


def mp4_timing(data: bytes) -> dict[str, Any]:
    """The video track's timescale, sample count, distinct sample durations and codec, from the MP4
    boxes (moov/trak/mdia: mdhd, hdlr, minf/stbl: stsd, stts)."""
    moov = _child(data, 0, len(data), "moov")
    if moov is None:
        raise ValueError("no moov box")
    for kind, start, end in _boxes(data, *moov):
        if kind != "trak":
            continue
        mdia = _child(data, start, end, "mdia")
        hdlr = mdia and _child(data, *mdia, "hdlr")
        if not hdlr or data[hdlr[0] + 8:hdlr[0] + 12] != b"vide":
            continue
        mdhd = _child(data, *mdia, "mdhd")
        version = data[mdhd[0]]
        timescale = struct.unpack_from(">I", data, mdhd[0] + (20 if version == 1 else 12))[0]
        stbl = _child(data, *_child(data, *mdia, "minf"), "stbl")
        stts = _child(data, *stbl, "stts")
        count = struct.unpack_from(">I", data, stts[0] + 4)[0]
        entries = [struct.unpack_from(">II", data, stts[0] + 8 + 8 * i) for i in range(count)]
        stsd = _child(data, *stbl, "stsd")
        codec = data[stsd[0] + 12:stsd[0] + 16].decode("latin-1")
        samples = sum(n for n, _ in entries)
        return {"timescale": timescale, "samples": samples, "sample_deltas": sorted({d for _, d in entries}),
                "duration_s": sum(n * d for n, d in entries) / timescale, "codec": codec}
    raise ValueError("no video track")


def encode_video(frames_dir: Path, count: int, fps: int, out: Path) -> dict[str, Any]:
    """frames_dir/frame-0000.png .. frame-<count-1>.png as H.264 MP4 at `fps`, checked for a constant
    sample duration of timescale / fps on every one of `count` samples."""
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-framerate", str(fps), "-start_number", "0",
               "-i", str(frames_dir / "frame-%04d.png"), "-frames:v", str(count),
               "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p", "-c:v", "libx264", "-preset", "medium",
               "-crf", str(CRF), "-r", str(fps), "-fps_mode", "cfr", "-movflags", "+faststart",
               "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", str(out)]
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=ENCODE_TIMEOUT_S)
    except subprocess.TimeoutExpired as error:
        raise pose.MotionError(f"ffmpeg did not finish within {ENCODE_TIMEOUT_S} s") from error
    if proc.returncode != 0 or not out.is_file():
        raise pose.MotionError(f"ffmpeg exited {proc.returncode}: {proc.stderr[-2000:]}")
    try:
        timing = mp4_timing(out.read_bytes())
    except (ValueError, TypeError, struct.error) as error:
        raise pose.MotionError(f"{out}: cannot read the MP4 timing: {error}") from error
    constant = (timing["samples"] == count and len(timing["sample_deltas"]) == 1
                and timing["sample_deltas"][0] * fps == timing["timescale"])
    if not constant:
        raise pose.MotionError(f"{out}: expected {count} samples of 1/{fps} s, got {timing}")
    return {"file": out.name, "codec": timing["codec"], "fps": fps, "frames": timing["samples"],
            "constant_fps": True, "timescale": timing["timescale"], "sample_delta": timing["sample_deltas"][0],
            "duration_s": timing["duration_s"], "bytes": out.stat().st_size,
            "encoder": {"imageio-ffmpeg": scriptenv.pinned(HERE, "imageio-ffmpeg"),
                        "ffmpeg": imageio_ffmpeg.get_ffmpeg_version(), "codec": "libx264", "crf": CRF,
                        "pix_fmt": "yuv420p"}}


# --------------------------------------------------------------------------- commands


def parse_outputs(text: str) -> list[str]:
    outputs = [item.strip() for item in text.split(",") if item.strip()]
    unknown = sorted(set(outputs) - set(OUTPUTS))
    if unknown or not outputs:
        raise pose.MotionError(f"--outputs takes a comma list of {list(OUTPUTS)}, got {text!r}")
    return sorted(set(outputs), key=OUTPUTS.index)


def parse_size(text: str) -> list[int]:
    match = SIZE.match(text)
    if not match:
        raise pose.MotionError(f"--size must be WIDTHxHEIGHT (100-9999 px), got {text!r}")
    return [int(match.group(1)), int(match.group(2))]


def _scratch_target(hw: Path, path: Path, option: str) -> Path:
    target = LAYOUT.scratch_path(hw, path, option)
    if target.exists():
        raise pose.MotionError(f"{option} already exists; refusing to overwrite scratch output: {target}")
    return target


def command_plan(args: argparse.Namespace) -> int:
    ctx = Context(args.hw, args.version)
    if args.print_default:
        import yaml

        print(yaml.safe_dump(plan.default_plan(ctx.chain), sort_keys=False, allow_unicode=True), end="")
        return 0
    effective, source = select_plan(args, ctx)
    frames = plan.expand(ctx.chain, effective)
    report = plan.coverage(ctx.chain, effective, frames)
    out = {"status": report["status"], "version": ctx.version, "case": effective["case"], "source": source,
           "summary": plan.summary_line(report), "coverage": report, "plan": effective}
    if args.frames_out is not None:
        target = _scratch_target(ctx.hw, args.frames_out, "--frames-out")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(frames_document(ctx, effective, frames)) + "\n", encoding="utf-8")
        out["frames_out"] = str(target)
    print(json.dumps(out, indent=2))
    return 1 if report["status"] == "fail" else 0


def _recipe(ctx: Context, effective: Mapping[str, Any], outputs: list[str], size: list[int],
            crosscheck: str | None) -> dict[str, Any]:
    """Every input that makes another bundle; the frame size and renderer only when frames are rendered."""
    recipe: dict[str, Any] = {"operation": "motion_render", "case": effective["case"], "plan": dict(effective),
                              "outputs": outputs, "attach": list(ctx.manifest.get("attach") or []),
                              "tools": {"motion_render": RECIPE_VERSION}, "inputs_sha256": pose.input_sha256(ctx.folder)}
    if {"sheet", "video", "frames"} & set(outputs):
        recipe["size"] = size
        recipe["tools"]["renderer"] = _load("cad_render_render", RENDER_PY).renderer_sha256()
    if "video" in outputs:
        recipe["tools"]["encoder"] = {"imageio-ffmpeg": scriptenv.pinned(HERE, "imageio-ffmpeg"), "codec": "libx264",
                                      "crf": CRF}
    if crosscheck:
        recipe["tools"]["crosscheck"] = crosscheck
    return recipe


def crosscheck_freecad(ctx: Context, frames_path: Path, work: Path) -> tuple[dict[str, Any], Path]:
    """freecad_assembly.py --frames on the plan frames: (crosscheck.json, motion.FCStd path)."""
    job = work / "crosscheck"
    command = scriptenv.script_command(FREECAD_PY, "--hw", str(ctx.hw), "--version", ctx.version,
                                       "--frames", str(frames_path), "--job-dir", str(job))
    for attach in ctx.attach:
        command.extend(("--attach", attach))
    code, result = _run_json(command,
                             work / "crosscheck.log", FREECAD_TIMEOUT_S, "freecad_assembly.py")
    if code == 2 or not (job / "crosscheck.json").is_file():
        raise pose.MotionError(f"the FreeCAD cross-check gave no result: {result.get('error') or result}")
    report = json.loads((job / "crosscheck.json").read_text(encoding="utf-8"))
    if code == 1:
        raise Failed({"status": "fail", "error": "the FreeCAD cross-check disagrees with coupling.py",
                      "crosscheck": report, "work": str(work)})
    return report, job / "motion.FCStd"


def command_render(args: argparse.Namespace) -> int:
    wall = time.monotonic()
    ctx = Context(args.hw, args.version)
    outputs, size = parse_outputs(args.outputs), parse_size(args.size)
    effective, source = select_plan(args, ctx)
    if args.plan is not None and args.out_dir is None:
        raise pose.MotionError("a --plan file renders to scratch: pass --out-dir under .cad-work")
    frames = plan.expand(ctx.chain, effective)
    report = plan.coverage(ctx.chain, effective, frames)
    if report["status"] == "fail":
        raise Failed({"status": "fail", "version": ctx.version, "case": effective["case"],
                      "summary": plan.summary_line(report), "coverage": report})
    out_dir = None if args.out_dir is None else _scratch_target(ctx.hw, args.out_dir, "--out-dir")
    recipe = _recipe(ctx, effective, outputs, size, args.crosscheck)
    params = {"V": ctx.version, "S": effective["case"]}
    if out_dir is None:
        reused = LAYOUT.reusable(ctx.hw, "bundle.motion", params, recipe, replace=args.replace)
        if reused is not None:
            result = json.loads((reused / "result.json").read_text(encoding="utf-8"))
            result.update(bundle=str(reused), reused=True)
            print(json.dumps(result, indent=2))
            return 0
    work = ctx.hw.parent / ".cad-work" / "motion" / f"{effective['case']}-{uuid.uuid4().hex[:12]}"
    work.mkdir(parents=True)
    spans = plan.spans(effective, frames)
    files: dict[str, Path] = {}
    result: dict[str, Any] = {
        "status": report["status"], "version": ctx.version, "case": effective["case"], "source": source,
        "frames": len(frames), "segments": len(effective["segments"]), "fps": effective["fps"],
        "duration_s": round((len(frames) - 1) / effective["fps"], 6), "outputs": outputs, "size": size,
        "summary": plan.summary_line(report),
        "coverage": {k: report[k] for k in ("status", "coverage_declared", "coverage_reason", "gaps",
                                            "unmoved_derived", "combined_pose_present")}}
    timings: dict[str, float] = {}
    try:
        (work / "plan.json").write_text(json.dumps(effective, indent=2) + "\n", encoding="utf-8")
        (work / "coverage.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        files.update({"plan.json": work / "plan.json", "coverage.json": work / "coverage.json"})
        if args.crosscheck:
            started = time.monotonic()
            frames_path = work / "frames.json"
            frames_path.write_text(json.dumps(frames_document(ctx, effective, frames)) + "\n", encoding="utf-8")
            crosscheck, fcstd = crosscheck_freecad(ctx, frames_path, work)
            files["crosscheck.json"] = frames_path.parent / "crosscheck" / "crosscheck.json"
            if fcstd.is_file():
                files["evidence/motion.FCStd"] = fcstd
            result["crosscheck"] = {k: crosscheck[k] for k in ("status", "max_deviation", "tolerance", "frames",
                                                               "independent_evidence") if k in crosscheck}
            timings["crosscheck_s"] = round(time.monotonic() - started, 3)
        if "glb" in outputs:
            started = time.monotonic()
            glb, glb_report = motion_glb.animate(
                (ctx.folder / "assembly.glb").read_bytes(), ctx.nodes(), ctx.deltas,
                [(f.index / effective["fps"], f.settings) for f in frames], effective["case"])
            (work / "motion.glb").write_bytes(glb)
            files["motion.glb"] = work / "motion.glb"
            result["glb"] = glb_report
            timings["glb_s"] = round(time.monotonic() - started, 3)
        if {"sheet", "video", "frames"} & set(outputs):
            started = time.monotonic()
            everything = bool({"video", "frames"} & set(outputs))
            rendered = {f.index for f in frames} if everything else {0, *(s.last for s in spans)}
            spec_path = work / "motion-spec.json"
            spec_path.write_text(json.dumps(render_spec(ctx, effective, frames, spans, rendered)), encoding="utf-8")
            render_dir = work / "render"
            code, summary = _run_json(
                scriptenv.script_command(RENDER_PY, str(ctx.hw), "--version", ctx.version, "--motion", str(spec_path),
                                         "--out-dir", str(render_dir), "--size", f"{size[0]}x{size[1]}"),
                work / "render.log", RENDER_TIMEOUT_S, "cad-render render.py")
            if code == 2:
                raise pose.MotionError(f"cad-render failed: {summary.get('error') or summary}")
            metadata = json.loads((render_dir / "motion-render.json").read_text(encoding="utf-8"))
            result["render"] = {k: metadata[k] for k in ("image", "frames_rendered", "groups", "sheet", "parity",
                                                         "renderer", "floor_shadow")}
            if code == 1:
                raise Failed({"status": "fail", "error": "rendered placements differ from the Chain",
                              "parity": metadata["parity"], "work": str(work)})
            if "sheet" in outputs:
                files["contact-sheet.png"] = render_dir / "contact-sheet.png"
            if "frames" in outputs:
                files.update({f"frames/{p.name}": p for p in sorted((render_dir / "frames").glob("frame-*.png"))})
            timings["render_s"] = round(time.monotonic() - started, 3)
            if "video" in outputs:
                started = time.monotonic()
                result["video"] = encode_video(render_dir / "frames", len(frames), effective["fps"], work / "video.mp4")
                files["video.mp4"] = work / "video.mp4"
                timings["video_s"] = round(time.monotonic() - started, 3)
        result["files"] = sorted([*files, "result.json"])
        published = place(ctx, files, result, params, recipe, out_dir, args.replace)
    except Exception:
        print(f"motion: the work files stay in {work}", file=sys.stderr)
        raise
    shutil.rmtree(work, ignore_errors=True)
    result.update(published)
    result["timings_s"] = {**timings, "total": round(time.monotonic() - wall, 3)}
    print(json.dumps(result, indent=2))
    return 0


def place(ctx: Context, files: Mapping[str, Path], result: Mapping[str, Any], params: Mapping[str, str],
          recipe: Mapping[str, Any], out_dir: Path | None, replace: bool) -> dict[str, Any]:
    """Copy the outputs and result.json into --out-dir, or seal them as the motion bundle."""
    target = out_dir if out_dir is not None else LAYOUT.staging(ctx.hw, "bundle.motion")
    try:
        for name, source in files.items():
            (target / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target / name)
        (target / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        if out_dir is not None:
            return {"out_dir": str(out_dir), "paths": {name: str(out_dir / name) for name in result["files"]}}
        published = LAYOUT.publish(ctx.hw, "bundle.motion", params, target, recipe=recipe, producer=PRODUCER,
                                   status=result["status"], replace=replace)
    except Exception:
        if out_dir is None:
            shutil.rmtree(target, ignore_errors=True)
        raise
    return {"bundle": str(published.path), "reused": published.reused,
            "paths": {name: str(published.path / name) for name in result["files"]}}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="motion.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("plan", "render"):
        command = sub.add_parser(name)
        command.add_argument("--hw", type=Path, required=True, help="hardware design record directory (hw/)")
        command.add_argument("--version", type=pose._version, required=True, metavar="vN|latest")
        source = command.add_mutually_exclusive_group()
        source.add_argument("--case", help="default (generated) or an authored hw/motion/cases/<case>")
        source.add_argument("--plan", type=Path, help="a scratch plan.yaml under .cad-work")
    plan_cmd, render_cmd = sub.choices["plan"], sub.choices["render"]
    plan_cmd.add_argument("--print-default", action="store_true", help="print the generated default plan as YAML")
    plan_cmd.add_argument("--frames-out", type=Path, help="write the expanded frames (JSON) under .cad-work")
    render_cmd.add_argument("--outputs", default=DEFAULT_OUTPUTS, help=f"comma list of {', '.join(OUTPUTS)}")
    render_cmd.add_argument("--size", default=DEFAULT_SIZE, help="frame size WIDTHxHEIGHT")
    render_cmd.add_argument("--crosscheck", choices=("freecad",), help="cross-check the couplings in FreeCAD")
    render_cmd.add_argument("--replace", action="store_true", help="retain and replace a different recipe")
    render_cmd.add_argument("--out-dir", type=Path, help="scratch output directory under .cad-work")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return command_plan(args) if args.command == "plan" else command_render(args)
    except Failed as failure:
        print(json.dumps(failure.report, indent=2))
        return 1
    except plan.PlanError as error:
        print(json.dumps({"status": "error", "problems": error.problems}, indent=2))
        return 2
    except (pose.MotionError, motion_glb.GlbError, OSError, LAYOUT.LayoutError, LAYOUT.PublishConflict) as error:
        print(json.dumps({"status": "error", "error": str(error)}, indent=2))
        return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # an unexpected failure is infrastructure, never a check result
        traceback.print_exc()
        sys.exit(2)
