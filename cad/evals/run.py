# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""cad plugin eval runner (ratchet runner contract).

  run.py plan   [--pilot] [--cell H:MODEL]... [--case ID]...      list pending slots and argv, no calls
  run.py run    [--pilot] [--cell H:MODEL]... [--case ID]... --out DIR [--train-ids FILE]
  run.py grade  --case ID --work DIR                                grade a sandbox directory
  run.py judge  --a DIR --b DIR --out FILE                          pairwise blind judge, per (case, rep)
  run.py smoke  --harness H --model MODEL --out DIR                 one trivial live call, recorded

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

SMOKE_PROMPT = "Create a file named hello.txt whose entire content is the word ok, then reply with the single word DONE."


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

    j = sub.add_parser("judge")
    j.add_argument("--a", type=Path, required=True, help="cell/variant directory A")
    j.add_argument("--b", type=Path, required=True, help="cell/variant directory B")
    j.add_argument("--out", type=Path, required=True)
    j.add_argument("--seed", type=int)

    s = sub.add_parser("smoke")
    s.add_argument("--harness", required=True, choices=adapters.HARNESSES)
    s.add_argument("--model", required=True)
    s.add_argument("--out", type=Path, required=True)
    s.add_argument("--timeout", type=float, default=300)

    args = parser.parse_args(argv[1:])
    matrix = runner.load_matrix(args.matrix)
    return {"plan": cmd_plan, "run": cmd_run, "grade": cmd_grade, "judge": cmd_judge, "smoke": cmd_smoke}[args.cmd](args, matrix)


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
        # this harness's manifest exists; a real trial stages a copy without evals/.
        demo = runner.TrialPaths(Path("<trial>"), Path("<trial>/work"), runner.PLUGIN_ROOT, Path("<trial>/state"))
        argv = adapter.command(model=cell.model, prompt="<prompt>", paths=demo, resume=False)
        pending = sum(1 for s in slots if s[0] == cell)
        print(f"{cell.slug}: {pending} pending slot(s)\n  {' '.join(argv)}")
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


def _judge_call(matrix):
    cfg = matrix.raw["judge"]
    adapter = adapters.build(cfg["harness"], matrix.harness_cfg(cfg["harness"]))
    flags = list(cfg.get("flags", []))

    def call(prompt: str):
        paths = runner.stage_trial(None, adapter, require_plugin=False)
        try:
            argv = adapter.command(model=cfg["model"], prompt=prompt, paths=paths, resume=False)
            argv = argv[:-1] + flags + argv[-1:]
            turn, _, _ = runner.run_turn(adapter, argv, paths, float(cfg.get("timeout_s", 300)))
            return turn
        finally:
            shutil.rmtree(paths.root, ignore_errors=True)

    return call


def _rows(directory: Path) -> dict[tuple[str, int], dict]:
    path = directory / "results.jsonl"
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()] if path.is_file() else []
    return {(r["prompt_id"], r["rep"]): r for r in rows}


def cmd_judge(args, matrix) -> int:
    a_rows, b_rows = _rows(args.a), _rows(args.b)
    call = _judge_call(matrix)
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


def cmd_smoke(args, matrix) -> int:
    """One live call with a trivial prompt; records argv, served model, usage and the raw stream."""
    adapter = adapters.build(args.harness, matrix.harness_cfg(args.harness))
    paths = runner.stage_trial(None, adapter, require_plugin=False)
    argv = adapter.command(model=args.model, prompt=SMOKE_PROMPT, paths=paths, resume=False)
    record = {"harness": args.harness, "requested_model": args.model, "argv": argv, "at": runner._now()}
    raw: list[str] = []
    started = time.monotonic()
    try:
        turn, raw, stderr = runner.run_turn(adapter, argv, paths, args.timeout)
        hello = paths.work / "hello.txt"
        record |= {
            "ok": True, "served_model": turn.model, "served_matches": adapters.served_matches(args.model, turn.model),
            "usage": turn.usage, "text": turn.text, "tools": turn.tools, "transcript_entries": len(turn.transcript),
            "file_written": hello.is_file() and hello.read_text().strip() == "ok", "stderr_tail": stderr[-500:],
        }
    except runner.TrialError as exc:
        record |= {"ok": False, "failure_class": exc.failure_class, "detail": exc.detail}
    finally:
        record["latency_s"] = round(time.monotonic() - started, 3)
        shutil.rmtree(paths.root, ignore_errors=True)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.harness}.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (args.out / f"{args.harness}.raw.jsonl").write_text("\n".join(raw) + ("\n" if raw else ""), encoding="utf-8")
    print(json.dumps(record, sort_keys=True))
    return 0 if record["ok"] and record.get("served_model") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
