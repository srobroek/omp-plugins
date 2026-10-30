from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
spec = importlib.util.spec_from_file_location("cad_motion_freecad_lifecycle", SCRIPTS / "freecad_assembly.py")
assert spec and spec.loader
freecad = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = freecad
spec.loader.exec_module(freecad)


class FreecadResultLifecycleTests(unittest.TestCase):
    def test_smoke_frames_selects_start_middle_and_end(self) -> None:
        frames = [{"frame": index} for index in range(11)]
        self.assertEqual([frame["frame"] for frame in freecad.smoke_frames(frames)], [0, 5, 10])

    def test_result_must_be_valid_and_for_this_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "result.json"
            for result in ({"run_id": "old", "status_sim": 0, "frames": [{}]},
                           {"run_id": "run", "status_sim": 1, "frames": [{}]},
                           {"run_id": "run", "status_sim": 0, "frames": []}):
                path.write_text(json.dumps(result), encoding="utf-8")
                self.assertIsNone(freecad._validated_result(path, "run"))
            valid = {"run_id": "run", "status_sim": 0, "frames": [{}]}
            path.write_text(json.dumps(valid), encoding="utf-8")
            self.assertEqual(freecad._validated_result(path, "run"), valid)

    @unittest.skipUnless(os.name == "posix", "the process-group contract is POSIX")
    def test_run_job_returns_on_valid_result_and_reaps_lingering_child(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result_path = root / "result.json"
            executable = root / "fake-freecad"
            executable.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys, time\n"
                "spec=json.loads(pathlib.Path(sys.argv[1] + '.spec').read_text())\n"
                "pathlib.Path(spec['result']).write_text(json.dumps({'run_id':spec['run_id'],'status_sim':0,'frames':[{}]}))\n"
                "time.sleep(30)\n", encoding="utf-8")
            executable.chmod(0o755)
            spec_path = root / "job.py.spec"
            job_path = root / "job.py"
            job_path.write_text("# no-op", encoding="utf-8")
            spec_path.write_text(json.dumps({"result": str(result_path), "run_id": "smoke-run"}), encoding="utf-8")
            started = __import__("time").monotonic()
            result, warnings, code = freecad.run_job(
                executable, root,
                {"result": str(result_path), "run_id": "smoke-run"},
                timeout=5)
            elapsed = __import__("time").monotonic() - started
            self.assertEqual(result["run_id"], "smoke-run")
            self.assertEqual(code, -15)
            self.assertLess(elapsed, 2.0)
            self.assertTrue(result_path.is_file())


if __name__ == "__main__":
    unittest.main()
