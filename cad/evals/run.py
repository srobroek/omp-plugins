# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""cad plugin eval runner (ratchet runner contract).

  run.py plan       [--pilot] [--cell H:MODEL]... [--case ID]...      pending slots and argv, no calls
  run.py run        [--pilot] [--cell H:MODEL]... [--case ID]... --out DIR [--train-ids FILE]
  run.py grade      --case ID --work DIR                            grade a sandbox directory
  run.py summary    --out DIR [--allow-contaminated]                per-cell comparison table
  run.py judge      --a DIR --b DIR --out FILE [--allow-contaminated]   pairwise blind judge
  run.py inventory  --harness H --model MODEL                       model-free isolation check (OMP)
  run.py smoke      --harness H --model MODEL --out DIR             one cheap live call: isolation + parse

The runner and adapters need only the standard library; graders run their OCCT
and YAML probes through `uv run --script`.
"""

from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
import time
from pathlib import Path

import adapters
import runner
from graders import judge
from graders.score import grade_trial

SMOKE_PROMPT = (
    "First, under the heading INSTRUCTIONS, list every instruction file, rule file, steering document and"
    " system-prompt section you were given (file path or section heading, one per line), other than skill bodies."
    " Then, under the heading SKILLS, list the names of every skill available to you, one per line."
    " Then create a file named hello.txt whose entire content is the word ok. End your reply with the single word DONE."
)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="run.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--matrix", type=Path, default=runner.EVALS / "matrix.toml")
    sub = parser.add_subparsers(dest="cmd", required=True)

    for name in ("plan", "run"):
        p = sub.add_parser(name)
        p.add_argument("--pilot", action="store_true", help="the matrix [pilot] cases and reps")
        p.add_argument("--cell", action="append", default=[], metavar="HARNESS:MODEL", help="restrict to these cells")
        p.add_argument("--case", action="append", default=[], metavar="ID", help="restrict to these cases")
        p.add_argument("--reps", type=int)
        p.add_argument("--out", type=Path, default=runner.EVALS / "out")
        if name == "run":
            p.add_argument("--train-ids", type=Path, help="one case id per line; only these get traces")
            p.add_argument("--concurrency", type=int)
            p.add_argument("--keep-sandboxes", action="store_true")
            p.add_argument("--seed", type=int)

    g = sub.add_parser("grade")
    g.add_argument("--case", required=True)
    g.add_argument("--work", type=Path, required=True)

    m = sub.add_parser("summary")
    m.add_argument("--out", type=Path, required=True, help="directory holding one subdirectory per cell")
    m.add_argument("--allow-contaminated", action="store_true", help="include cells whose rows loaded ambient config")

    j = sub.add_parser("judge")
    j.add_argument("--a", type=Path, required=True, help="cell/variant directory A")
    j.add_argument("--b", type=Path, required=True, help="cell/variant directory B")
    j.add_argument("--out", type=Path, required=True)
    j.add_argument("--seed", type=int)
    j.add_argument("--allow-contaminated", action="store_true", help="compare cells whose rows loaded ambient config")

    for name in ("inventory", "smoke"):
        s = sub.add_parser(name)
        s.add_argument("--harness", required=True, choices=adapters.HARNESSES)
        s.add_argument("--model", required=True)
        if name == "smoke":
            s.add_argument("--out", type=Path, required=True)
            s.add_argument("--timeout", type=float, default=300)
            s.add_argument("--keep-sandbox", action="store_true", help="leave the trial directory for inspection")

    args = parser.parse_args(argv[1:])
    matrix = runner.load_matrix(args.matrix)
    commands = {"plan": cmd_plan, "run": cmd_run, "grade": cmd_grade, "summary": cmd_summary, "judge": cmd_judge,
                "inventory": cmd_inventory, "smoke": cmd_smoke}
    try:
        return commands[args.cmd](args, matrix)
    except runner.Contaminated as exc:
        print(str(exc), file=sys.stderr)
        return 2


def _selection(args, matrix: runner.Matrix):
    pilot = matrix.raw.get("pilot", {})
    case_ids = args.case or (pilot.get("cases") if args.pilot else None)
    reps = args.reps or (int(pilot.get("reps", 1)) if args.pilot else matrix.reps)
    cells = matrix.cells
    if args.cell:
        wanted = {tuple(c.split(":", 1)) for c in args.cell}
        cells = [c for c in cells if (c.harness, c.model) in wanted]
        unknown = wanted - {(c.harness, c.model) for c in cells}
        if unknown:
            raise SystemExit(f"cells not in the matrix: {sorted(unknown)}")
    return cells, runner.load_cases(case_ids), reps


def cmd_plan(args, matrix) -> int:
    cells, cases, reps = _selection(args, matrix)
    slots = runner.plan_slots(cells, cases, reps, args.out)
    for cell in cells:
        adapter = adapters.build(cell.harness, matrix.harness_cfg(cell.harness))
        # The plugin path is the source checkout, so the plugin flag shows whether
        # this harness's marker exists; a real trial stages a copy without evals/.
        demo = runner.TrialPaths(Path("<trial>"), Path("<trial>/work"), runner.PLUGIN_ROOT, Path("<trial>/state"), Path("<trial>/home"))
        argv = adapter.command(model=cell.model, prompt="<prompt>", paths=demo, resume=False)
        pending = sum(1 for s in slots if s[0] == cell)
        print(f"{cell.slug}: {pending} pending slot(s)\n  {' '.join(argv)}\n  isolation: {adapter.isolation}")
    print(f"total pending: {len(slots)} ({len(cases)} cases x {reps} reps x {len(cells)} cells, minus completed)")
    return 0


def cmd_run(args, matrix) -> int:
    cells, cases, reps = _selection(args, matrix)
    trace_ids = None if args.pilot and not args.train_ids else set()
    if args.train_ids:
        trace_ids = {line.strip() for line in args.train_ids.read_text().splitlines() if line.strip()}
    counts = runner.run_matrix(
        matrix, cells, cases, reps, args.out, trace_ids=trace_ids,
        concurrency=args.concurrency or int(matrix.raw.get("concurrency", 2)), keep=args.keep_sandboxes, seed=args.seed,
    )
    print(json.dumps(counts, sort_keys=True))
    return 0


def cmd_grade(args, matrix) -> int:
    case = runner.load_cases([args.case])[0]
    validator = runner.VALIDATOR if runner.VALIDATOR.is_file() else None
    graded = grade_trial(case, args.work, runner.load_truth(case), validator)
    print(json.dumps({"grade": graded.grade, "explanation": graded.explanation}, sort_keys=True))
    return 0 if graded.grade["pass"] else 1


def cmd_summary(args, matrix) -> int:
    print(json.dumps(runner.summarize(args.out, args.allow_contaminated), indent=2, sort_keys=True))
    return 0


def _judge_call(matrix, host_source: runner.HostSource):
    cfg = matrix.raw["judge"]
    adapter = adapters.build(cfg["harness"], matrix.harness_cfg(cfg["harness"]))
    flags = list(cfg.get("flags", []))

    def call(prompt: str):
        host = host_source.get()
        paths = runner.stage_trial(None, adapter, host, require_plugin=False)
        try:
            argv = adapter.command(model=cfg["model"], prompt=prompt, paths=paths, resume=False)
            argv = argv[:-1] + flags + argv[-1:]
            turn, _, _ = runner.run_turn(adapter, argv, paths, host, float(cfg.get("timeout_s", 300)))
            return turn
        finally:
            shutil.rmtree(paths.root, ignore_errors=True)

    return call


def cmd_judge(args, matrix) -> int:
    runner.require_comparable([args.a, args.b], args.allow_contaminated)
    a_rows = {(r["prompt_id"], r["rep"]): r for r in runner.read_rows(args.a)}
    b_rows = {(r["prompt_id"], r["rep"]): r for r in runner.read_rows(args.b)}
    call = _judge_call(matrix, runner.HostSource(matrix.raw.get("auth", {})))
    rng = random.Random(args.seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    failures = 0
    with args.out.open("a", encoding="utf-8") as fh:
        for key in sorted(a_rows.keys() & b_rows.keys()):
            prompt_id, rep = key
            slot = f"{prompt_id}_rep{rep}"
            a = judge.render_candidate(args.a / "artifacts" / slot)
            b = judge.render_candidate(args.b / "artifacts" / slot)
            row = {"prompt_id": prompt_id, "rep": rep, "tags": a_rows[key]["tags"], "a": str(args.a), "b": str(args.b)}
            try:
                verdict = judge.pairwise(a_rows[key]["prompt"], a, b, call=call, rng=rng)
            except (judge.JudgeError, runner.TrialError) as exc:
                failures += 1
                row |= {"failure_class": "judge_error", "detail": str(exc)}
            else:
                row |= {
                    "grade": {"win_a": verdict.score_a}, "winner": verdict.winner, "order": verdict.order,
                    "explanation": verdict.reason, "judge_model": verdict.judge_model, "judge_usage": verdict.judge_usage,
                }
            fh.write(json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n")
    return 1 if failures else 0


def cmd_inventory(args, matrix) -> int:
    """Model-free: stage a trial, run the adapter's probe, print what loaded."""
    adapter = adapters.build(args.harness, matrix.harness_cfg(args.harness))
    host = runner.HostSource(matrix.raw.get("auth", {})).get()
    paths = runner.stage_trial(None, adapter, host, require_plugin=True)
    try:
        if not adapter.probe(paths, args.model, []):
            print(f"{args.harness} reports its components only from a turn; use `smoke`", file=sys.stderr)
            return 2
        result = runner.isolation_of(adapter, paths, runner.run_probe(adapter, paths, host, args.model, []), [])
    finally:
        shutil.rmtree(paths.root, ignore_errors=True)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["isolation"] == "clean" else 1


def cmd_smoke(args, matrix) -> int:
    """One cheap live call in a clean trial: records argv, served model, usage, the
    loaded-component inventory and its leaks, and the raw stream."""
    adapter = adapters.build(args.harness, matrix.harness_cfg(args.harness))
    host = runner.HostSource(matrix.raw.get("auth", {})).get()
    paths = runner.stage_trial(None, adapter, host, require_plugin=True)
    argv = adapter.command(model=args.model, prompt=SMOKE_PROMPT, paths=paths, resume=False)
    record = {"harness": args.harness, "requested_model": args.model, "argv": argv, "at": runner._now()}
    raw: list[str] = []
    probe: list[str] = []
    started = time.monotonic()
    try:
        turn, raw, stderr = runner.run_turn(adapter, argv, paths, host, args.timeout)
        probe = runner.run_probe(adapter, paths, host, args.model, raw)
        hello = paths.work / "hello.txt"
        record |= {
            "ok": True, "served_model": turn.model, "served_matches": adapters.served_matches(args.model, turn.model),
            "usage": turn.usage, "text": turn.text, "tools": turn.tools, "transcript_entries": len(turn.transcript),
            "file_written": hello.is_file() and hello.read_text().strip() == "ok",
            **runner.isolation_of(adapter, paths, probe, raw),
        }
    except runner.TrialError as exc:
        record |= {"ok": False, "failure_class": exc.failure_class, "detail": exc.detail}
    finally:
        record["latency_s"] = round(time.monotonic() - started, 3)
        if args.keep_sandbox:
            record["sandbox"] = str(paths.root)
        else:
            shutil.rmtree(paths.root, ignore_errors=True)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.harness}.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (args.out / f"{args.harness}.raw.jsonl").write_text("\n".join(raw) + ("\n" if raw else ""), encoding="utf-8")
    if probe:
        (args.out / f"{args.harness}.probe.json").write_text(json.dumps(probe, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({k: record.get(k) for k in ("ok", "served_model", "isolation", "leaks", "inventory", "text", "file_written")}, indent=2))
    return 0 if record.get("ok") and record.get("isolation") == "clean" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
