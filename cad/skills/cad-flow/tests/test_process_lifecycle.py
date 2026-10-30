#!/usr/bin/env python3
"""Lifecycle tests for process_lifecycle.py with real processes: a supervised family of a child and a
grandchild that both ignore SIGTERM (a native solver stuck in a call), parents killed outright,
timeouts, run records with live, orphaned, reused and legacy entries, and concurrent claims."""

from __future__ import annotations

import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "process_lifecycle.py"
spec = importlib.util.spec_from_file_location("cad_flow_process_lifecycle", SCRIPT)
assert spec is not None and spec.loader is not None
lifecycle = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = lifecycle
spec.loader.exec_module(lifecycle)

POSIX = os.name == "posix"
LOAD = ("import importlib.util, sys\n"
        f"spec = importlib.util.spec_from_file_location('cad_flow_process_lifecycle', {str(SCRIPT)!r})\n"
        "lifecycle = importlib.util.module_from_spec(spec)\n"
        "sys.modules[spec.name] = lifecycle\n"
        "spec.loader.exec_module(lifecycle)\n")
# A child and its grandchild that ignore SIGTERM and run for ten minutes; the child writes both pids.
FAMILY = textwrap.dedent("""
    import os, signal, subprocess, sys, time
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    with open(sys.argv[1] + ".tmp", "w") as out:
        out.write(f"{os.getpid()} {grandchild.pid}")
    os.replace(sys.argv[1] + ".tmp", sys.argv[1])
    time.sleep(600)
""")
# A command that leaves a grandchild behind and ends at once.
LEAVER = textwrap.dedent("""
    import subprocess, sys
    grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
    open(sys.argv[1], "w").write(str(grandchild.pid))
""")


def running(pid: int) -> bool:
    """Whether `pid` runs: a zombie waiting to be reaped has ended."""
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def wait_until(predicate, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


@unittest.skipUnless(POSIX, "process groups are POSIX only")
class Case(unittest.TestCase):
    def setUp(self) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name).resolve()
        self.hw = self.root / "hw"
        self.hw.mkdir()
        self.pids: list[int] = []
        self.addCleanup(self.kill_leftovers)

    def kill_leftovers(self) -> None:
        for pid in self.pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    def family_pids(self, path: Path) -> tuple[int, int]:
        self.assertTrue(wait_until(path.exists), "the supervised command did not start")
        child, grandchild = (int(pid) for pid in path.read_text().split())
        self.pids += [child, grandchild]
        return child, grandchild

    def sleeper(self) -> subprocess.Popen:
        """A live session leader that is no CAD run."""
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"], start_new_session=True)
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        return process

    def ended_pid(self) -> int:
        process = subprocess.Popen([sys.executable, "-c", "pass"])
        process.wait()
        return process.pid

    def assert_gone(self, *pids: int) -> None:
        for pid in pids:
            self.assertTrue(wait_until(lambda: not running(pid)), f"process {pid} survived")


class SupervisedGroupTests(Case):
    def test_terminating_the_group_kills_a_family_that_ignores_sigterm(self) -> None:
        pids = self.root / "pids"
        process = lifecycle.spawn([sys.executable, "-c", FAMILY, str(pids)])
        child, grandchild = self.family_pids(pids)
        started = time.monotonic()
        code = lifecycle.terminate_group(process, grace_seconds=0.5)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(code, -signal.SIGKILL)
        self.assert_gone(child, grandchild)
        self.assertEqual(lifecycle.terminate_group(process), code)  # idempotent

    def test_the_group_dies_when_its_parent_is_killed_outright(self) -> None:
        pids = self.root / "pids"
        parent_code = LOAD + textwrap.dedent(f"""
            import sys, time
            process = lifecycle.spawn([sys.executable, "-c", {FAMILY!r}, {str(pids)!r}])
            print(process.pid, flush=True)
            time.sleep(600)
        """)
        parent = subprocess.Popen([sys.executable, "-c", parent_code], stdout=subprocess.PIPE, text=True,
                                  start_new_session=True)
        self.addCleanup(parent.wait)
        supervisor = int(parent.stdout.readline())
        self.pids.append(supervisor)
        child, grandchild = self.family_pids(pids)
        os.killpg(parent.pid, signal.SIGKILL)  # the parent and its own group: nothing can clean up
        parent.wait()
        parent.stdout.close()
        self.assert_gone(supervisor, child, grandchild)

    def test_a_timeout_terminates_the_whole_family_before_raising(self) -> None:
        pids = self.root / "pids"
        command = [sys.executable, "-c", FAMILY, str(pids)]
        with self.assertRaises(subprocess.TimeoutExpired) as raised:
            lifecycle.run(command, timeout=1.5)
        self.assertEqual(raised.exception.cmd, command)
        child, grandchild = self.family_pids(pids)
        self.assert_gone(child, grandchild)

    def test_run_relays_the_commands_status_and_output(self) -> None:
        done = lifecycle.run([sys.executable, "-c", "import sys; print('out'); sys.exit(3)"],
                             capture_output=True, text=True, timeout=30)
        self.assertEqual((done.returncode, done.stdout), (3, "out\n"))
        killed = lifecycle.run([sys.executable, "-c", "import os, signal; os.kill(os.getpid(), signal.SIGUSR1)"],
                               timeout=30)
        self.assertEqual(killed.returncode, -signal.SIGUSR1)

    def test_a_process_left_behind_by_a_finished_command_is_killed(self) -> None:
        marker = self.root / "grandchild"
        done = lifecycle.run([sys.executable, "-c", LEAVER, str(marker)], timeout=30)
        self.assertEqual(done.returncode, 0)
        grandchild = int(marker.read_text())
        self.pids.append(grandchild)
        self.assert_gone(grandchild)

    def test_a_missing_program_raises_like_subprocess(self) -> None:
        with self.assertRaises(FileNotFoundError):
            lifecycle.spawn([str(self.root / "missing")])
        with self.assertRaises(FileNotFoundError):
            lifecycle.spawn(["cad-no-such-program"])
        script = self.root / "plain.txt"
        script.write_text("not a program")
        with self.assertRaises(PermissionError):
            lifecycle.spawn([str(script)])


class RunRecordTests(Case):
    def record(self, name: str, **fields) -> Path:
        path = lifecycle.runs_dir(self.hw) / f"{name}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        record = {"schema": 1, "kind": "sweep", "run_id": name, "host": socket.gethostname(), "pid": self.ended_pid(),
                  "identity": "ended", "pgid": None, "argv": [], "started": "", "groups": []}
        path.write_text(json.dumps({**record, **fields}), encoding="utf-8")
        return path

    def holder(self, kind: str, scope: str = "") -> subprocess.Popen:
        """Another process holding a `kind` claim on self.hw for `scope`."""
        code = LOAD + f"guard = lifecycle.claim_run({str(self.hw)!r}, {kind!r}, scope={scope!r})\n" \
                      "print('claimed', flush=True)\nimport time; time.sleep(600)\n"
        process = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (process.kill(), process.wait(), process.stdout.close()))
        self.assertEqual(process.stdout.readline().strip(), "claimed")
        return process

    def test_a_claim_records_its_groups_and_release_removes_it(self) -> None:
        guard = lifecycle.claim_run(self.hw, "fea", "first-run")
        record = json.loads(guard.path.read_text())
        self.assertEqual((record["kind"], record["pid"], record["identity"]),
                         ("fea", os.getpid(), lifecycle.identity(os.getpid())))
        self.assertEqual(guard.path, self.hw.resolve() / ".cad" / "runs" / "first-run.json")
        pids = self.root / "pids"
        process = guard.spawn([sys.executable, "-c", FAMILY, str(pids)])
        child, grandchild = self.family_pids(pids)
        groups = json.loads(guard.path.read_text())["groups"]
        self.assertEqual([(g["pgid"], g["identity"]) for g in groups], [(process.pid, process.group_identity)])
        lifecycle.terminate_group(process, grace_seconds=0.2)
        self.assertEqual(json.loads(guard.path.read_text())["groups"], [])
        self.assert_gone(child, grandchild)
        guard.release()
        self.assertFalse(guard.path.exists())

    def test_release_terminates_groups_still_running(self) -> None:
        pids = self.root / "pids"
        with lifecycle.claim_run(self.hw, "fea") as guard:
            guard.spawn([sys.executable, "-c", FAMILY, str(pids)])
            child, grandchild = self.family_pids(pids)
        self.assert_gone(child, grandchild)
        self.assertFalse(guard.path.exists())

    def test_a_live_run_refuses_its_own_identity_and_allows_every_other(self) -> None:
        holder = self.holder("static", "v3 all-pairs")
        with self.assertRaises(lifecycle.RunRefused) as raised:
            lifecycle.claim_run(self.hw, "static", scope="v3 all-pairs")
        [stray] = raised.exception.strays
        self.assertEqual((stray.state, stray.kind, stray.scope, stray.pid), ("running", "static", "v3 all-pairs", holder.pid))
        self.assertIn(f"a static run of v3 all-pairs still runs as process {holder.pid}; stop it with `kill -TERM {holder.pid}`",
                      str(raised.exception))
        for kind, scope in (("static", "v4 all-pairs"), ("static", "v3 changed-pairs since previous"), ("fea", "v3 all-pairs")):
            with self.subTest(kind=kind, scope=scope), lifecycle.claim_run(self.hw, kind, scope=scope) as other:
                self.assertEqual([s.pid for s in other.concurrent], [holder.pid])
        listed = lifecycle.strays(self.hw)
        self.assertEqual([(s.state, s.scope) for s in listed], [("running", "v3 all-pairs")])
        holder.kill()
        holder.wait()
        with lifecycle.claim_run(self.hw, "static", scope="v3 all-pairs") as guard:  # the killed holder's record is stale
            self.assertEqual(list(lifecycle.runs_dir(self.hw).glob("*.json")), [guard.path])
        self.assertEqual(list(lifecycle.runs_dir(self.hw).glob("*.json")), [])

    def test_an_orphaned_group_refuses_every_kind_and_is_never_signalled(self) -> None:
        group = self.sleeper()
        path = self.record("orphan", groups=[{"pgid": group.pid, "identity": lifecycle.identity(group.pid)}])
        for kind in ("sweep", "fea"):
            with self.assertRaises(lifecycle.RunRefused) as raised:
                lifecycle.claim_run(self.hw, kind)
            [stray] = raised.exception.strays
            self.assertEqual((stray.state, stray.groups, stray.path), ("orphaned", (group.pid,), path))
            self.assertIn(f"kill -TERM -- -{group.pid}", str(raised.exception))
        listed = subprocess.run([sys.executable, str(SCRIPT), "strays", "--hw", str(self.hw)],
                                capture_output=True, text=True)
        self.assertEqual(listed.returncode, 1, listed.stderr)
        self.assertEqual([s["state"] for s in json.loads(listed.stdout)["strays"]], ["orphaned"])
        self.assertIsNone(group.poll())

    def test_a_record_whose_ids_were_reused_is_stale_and_never_signalled(self) -> None:
        other = self.sleeper()
        path = self.record("reused", pid=other.pid, identity="an earlier process", pgid=other.pid,
                           groups=[{"pgid": other.pid, "identity": "an earlier process"}])
        self.assertEqual(lifecycle.strays(self.hw), [])
        with lifecycle.claim_run(self.hw, "sweep"):
            self.assertFalse(path.exists())
        self.assertIsNone(other.poll())

    def test_a_record_of_an_ended_run_with_nothing_left_is_removed(self) -> None:
        path = self.record("ended", groups=[{"pgid": self.ended_pid(), "identity": "ended"}])
        with lifecycle.claim_run(self.hw, "sweep"):
            self.assertFalse(path.exists())

    def test_unverifiable_records_refuse(self) -> None:
        runs = lifecycle.runs_dir(self.hw)
        runs.mkdir(parents=True)
        (runs / "broken.json").write_text("{", encoding="utf-8")
        self.record("elsewhere", host="another-host")
        with self.assertRaises(lifecycle.RunRefused) as raised:
            lifecycle.claim_run(self.hw, "static")
        self.assertEqual([(s.path.name, s.state) for s in raised.exception.strays],
                         [("broken.json", "unverifiable"), ("elsewhere.json", "unverifiable")])
        self.assertIn("delete", str(raised.exception))

    def test_a_legacy_sweep_lock_refuses_only_while_its_group_runs(self) -> None:
        group = self.sleeper()
        lock = self.hw / "motion" / "v1" / ".sweep-old.json"
        lock.parent.mkdir(parents=True)
        lock.write_text(json.dumps({"pgid": group.pid, "pid": group.pid}), encoding="utf-8")
        with self.assertRaises(lifecycle.RunRefused) as raised:
            lifecycle.claim_run(self.hw, "static")
        [stray] = raised.exception.strays
        self.assertEqual((stray.state, stray.path, stray.groups), ("unverifiable", lock, (group.pid,)))
        self.assertIsNone(group.poll())
        group.kill()
        group.wait()
        with lifecycle.claim_run(self.hw, "static"):
            self.assertTrue(lock.exists())  # never ours to delete

    def test_concurrent_claims_admit_exactly_one(self) -> None:
        go = self.root / "go"
        code = LOAD + textwrap.dedent(f"""
            import os, time
            while not os.path.exists({str(go)!r}):
                time.sleep(0.005)
            try:
                guard = lifecycle.claim_run({str(self.hw)!r}, "sweep")
            except lifecycle.RunRefused:
                print("refused", flush=True)
            else:
                print("claimed", flush=True)
                time.sleep(600)
        """)
        claimants = [subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
                     for _ in range(4)]
        for claimant in claimants:
            self.addCleanup(lambda c=claimant: (c.kill(), c.wait(), c.stdout.close()))
        go.touch()
        answers = sorted(claimant.stdout.readline().strip() for claimant in claimants)
        self.assertEqual(answers, ["claimed", "refused", "refused", "refused"])

    def test_claims_validate_kind_and_id(self) -> None:
        with self.assertRaises(ValueError):
            lifecycle.claim_run(self.hw, "render")
        with self.assertRaises(ValueError):
            lifecycle.claim_run(self.hw, "sweep", "../escape")


@unittest.skipUnless(sys.platform.startswith("linux") or hasattr(__import__("select"), "kqueue"),
                     "die_with needs PR_SET_PDEATHSIG or kqueue")
class DieWithTests(Case):
    def test_a_worker_dies_with_its_killed_parent_mid_call(self) -> None:
        worker = LOAD + "import os, sys, time\nlifecycle.die_with(int(sys.argv[1]))\nprint(os.getpid(), flush=True)\n" \
                        "time.sleep(600)\n"
        parent_code = textwrap.dedent(f"""
            import os, subprocess, sys, time
            worker = subprocess.Popen([sys.executable, "-c", {worker!r}, str(os.getpid())], stdout=subprocess.PIPE, text=True)
            print(worker.stdout.readline().strip(), flush=True)
            time.sleep(600)
        """)
        parent = subprocess.Popen([sys.executable, "-c", parent_code], stdout=subprocess.PIPE, text=True)
        self.addCleanup(parent.wait)
        pid = int(parent.stdout.readline())
        self.pids.append(pid)
        self.assertTrue(running(pid))
        parent.kill()
        parent.wait()
        parent.stdout.close()
        self.assert_gone(pid)


if __name__ == "__main__":
    unittest.main()
