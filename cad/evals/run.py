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
  run.py smoke      --harness H --model MODEL --out DIR             one cheap live call: isolation, parse, host effects

The runner and adapters need only the standard library; graders run their OCCT
and YAML probes through `uv run --script`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shutil
import sqlite3
import sys
import tempfile
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
    " Then, under the heading FILES, list the entries of the current working directory, using your file or"
    " directory tool rather than a shell command."
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
        result = runner.isolation_of(adapter, paths, runner.run_probe(adapter, paths, host, args.model, []), [],
                                     runner.harness_version(adapter, paths, host))
    finally:
        shutil.rmtree(paths.root, ignore_errors=True)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["isolation"] == "clean" else 1


def cmd_smoke(args, matrix) -> int:
    """One cheap live call in a clean trial: records argv, served model, usage, the
    loaded-component inventory and its leaks, the raw stream, and what the trial
    left on the host (`host`): entries it added to the shared temp directories and
    changes to the harness's user stores, both of which must be none."""
    adapter = adapters.build(args.harness, matrix.harness_cfg(args.harness))
    host = runner.HostSource(matrix.raw.get("auth", {})).get()
    refusal = adapter.preflight(host, args.timeout)
    if refusal:
        print(f"{args.harness}: smoke not started: {refusal}", file=sys.stderr)
        return 2
    # Snapshots come first, so staging (the Kiro login copy) is inside the window.
    shared = sorted({Path(tempfile.gettempdir()).resolve(), Path("/tmp").resolve()})
    stores = {store: store_state(store) for store in adapter.user_stores(host)}
    shared_before = {path: m for root in shared for path, m in tree(root).items()}
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
            **runner.isolation_of(adapter, paths, probe, raw, runner.harness_version(adapter, paths, host)),
        }
    except runner.TrialError as exc:
        record |= {"ok": False, "failure_class": exc.failure_class, "detail": exc.detail}
    finally:
        record["latency_s"] = round(time.monotonic() - started, 3)
        trial_side = {
            "tmpdir": sorted(os.path.relpath(p, paths.tmp) for p in tree(paths.tmp)),
            "stores": {str(s): len(tree(paths.home / s.relative_to(host.real_home))) for s in stores},
        }
        if args.keep_sandbox:
            record["sandbox"] = str(paths.root)
        else:
            shutil.rmtree(paths.root, ignore_errors=True)
    record["host"] = host_effects(paths.root, trial_side, shared, shared_before, stores)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"{args.harness}.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (args.out / f"{args.harness}.raw.jsonl").write_text("\n".join(raw) + ("\n" if raw else ""), encoding="utf-8")
    if probe:
        (args.out / f"{args.harness}.probe.json").write_text(json.dumps(probe, indent=1) + "\n", encoding="utf-8")
    print(json.dumps({k: record.get(k) for k in ("ok", "served_model", "isolation", "leaks", "inventory", "text", "file_written", "host")}, indent=2))
    return 0 if record.get("ok") and record.get("isolation") == "clean" and record["host"]["unchanged"] else 1


# ---------------------------------------------------------------- host effects (smoke proofs)


def tree(root: Path, depth: int = 2) -> dict[str, int]:
    """Path -> mtime_ns of every entry up to `depth` levels below `root`. A changed
    directory mtime also reveals an entry added or removed one level deeper."""
    found: dict[str, int] = {}
    pending = [(str(root), 1)]
    while pending:
        folder, level = pending.pop()
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            try:
                found[entry.path] = entry.stat(follow_symlinks=False).st_mtime_ns
            except OSError:
                continue
            if level < depth and entry.is_dir(follow_symlinks=False):
                pending.append((entry.path, level + 1))
    return found


def _sqlite(path: Path, marker: str | None = None) -> dict:
    """Per table, read-only: row count and an order-independent digest of its rows (the
    sum of the rows' SHA-256 values); with `marker`, also how many rows mention it."""
    con = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=30)
    try:
        tables: dict = {}
        mentions = 0
        for (t,) in con.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").fetchall():
            digest = count = 0
            for row in con.execute(f'SELECT * FROM "{t}"'):
                digest = (digest + int.from_bytes(hashlib.sha256(repr(row).encode()).digest(), "big")) % (1 << 256)
                count += 1
            tables[t] = {"rows": count, "digest": f"{digest:064x}"}
            if marker:
                columns = [c[1] for c in con.execute(f'PRAGMA table_info("{t}")')]
                where = " OR ".join(f'CAST("{c}" AS TEXT) LIKE ?' for c in columns)
                mentions += con.execute(f'SELECT count(*) FROM "{t}" WHERE {where}', [f"%{marker}%"] * len(columns)).fetchone()[0]
        return {"tables": tables, **({"rows_mentioning_trial": mentions} if marker else {})}
    finally:
        con.close()


def store_state(store: Path, marker: str | None = None) -> dict:
    return {"entries": tree(store), "sqlite": {p.name: _sqlite(p, marker) for p in sorted(store.glob("*.sqlite3"))}}


def host_effects(root: Path, trial_side: dict, shared: list[Path], shared_before: dict[str, int], stores: dict[Path, dict]) -> dict:
    """What one trial left outside its own directory. Shared temp entries added during
    the trial count against it when their path names the trial (as is, or slugged the
    way Claude names per-directory folders) or they share a name with something the
    harness wrote to the trial's own TMPDIR; other additions come from concurrent
    processes and are listed for review. A user store must show no added, removed or
    changed entry, no changed table and no row naming the trial."""
    own = (str(root), str(root.resolve()))
    inside = tuple(p + "/" for p in own)
    markers = {root.name, re.sub(r"[^A-Za-z0-9]", "-", root.name)}
    own_names = {Path(p).name for p in trial_side["tmpdir"]}
    added = sorted(p for temp in shared for p in tree(temp) if p not in shared_before and p not in own and not p.startswith(inside))
    by_trial = [p for p in added if any(m in p for m in markers) or Path(p).name in own_names]
    report: dict = {
        "trial_tmpdir": trial_side["tmpdir"],
        "shared_temp": {"roots": [str(r) for r in shared], "added_by_trial": by_trial,
                        "added_by_other_processes": [p for p in added if p not in by_trial]},
        "user_stores": {},
    }
    unchanged = not by_trial
    for store, before in stores.items():
        after = store_state(store, root.name)
        old, new = before["entries"], after["entries"]
        diff = {
            "added": sorted(new.keys() - old.keys()), "removed": sorted(old.keys() - new.keys()),
            "changed": sorted(p for p in old.keys() & new.keys() if old[p] != new[p]),
            "sqlite": {
                name: {
                    "rows": {t: v["rows"] for t, v in state["tables"].items()},
                    "tables_changed": sorted(t for t, v in state["tables"].items()
                                             if before["sqlite"].get(name, {}).get("tables", {}).get(t) != v),
                    "rows_mentioning_trial": state["rows_mentioning_trial"],
                }
                for name, state in after["sqlite"].items()
            },
            "trial_counterpart_entries": trial_side["stores"].get(str(store), 0),
        }
        report["user_stores"][str(store)] = diff
        unchanged = unchanged and not (diff["added"] or diff["removed"] or diff["changed"]) and all(
            not s["tables_changed"] and not s["rows_mentioning_trial"] for s in diff["sqlite"].values())
    report["unchanged"] = unchanged
    return report


if __name__ == "__main__":
    sys.exit(main(sys.argv))
