#!/usr/bin/env python3
"""cadmodel.scriptenv: PEP 723 header reading and the shared-environment launch command.

Run: python3 -m unittest discover -s cad/skills/cad-model/tests -p test_scriptenv.py -v
Standard library only; needs neither uv nor OCP.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from cadmodel import build, scriptenv  # noqa: E402 - stdlib-only imports

HEADER = """#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#     "cadquery==2.8.0",
#     "cadquery-ocp==7.9.3.1.1",
#     "PyYAML>=6.0",
# ]
# ///
\"\"\"A runner.\"\"\"
"""


class ScriptEnvTests(unittest.TestCase):
    def script(self, text: str) -> Path:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "run_kernel.py"
        path.write_text(text, encoding="utf-8")
        return path

    def test_command_passes_the_header_requires_python_and_runs_the_script_with_python(self) -> None:
        script = self.script(HEADER)
        self.assertEqual(scriptenv.script_command(script, "--flag", uv="/bin/uv"),
                         ["/bin/uv", "run", "--quiet", "--isolated", "--no-project", "--python", ">=3.12,<3.13",
                          "--with-requirements", str(script), "python", str(script), "--flag"])

    def test_python_command_runs_code_in_the_same_environment(self) -> None:
        script = self.script(HEADER)
        self.assertEqual(scriptenv.python_command(script, "-c", "pass")[-4:],
                         [str(script), "python", "-c", "pass"])

    def test_a_header_without_requires_python_leaves_the_interpreter_to_uv(self) -> None:
        script = self.script('# /// script\n# dependencies = ["pyyaml>=6.0"]\n# ///\n')
        self.assertNotIn("--python", scriptenv.script_command(script))

    def test_a_script_without_one_header_block_is_rejected(self) -> None:
        for text in ("print('no header')\n", HEADER + HEADER):
            with self.subTest(blocks=text.count("# /// script")), self.assertRaises(ValueError):
                scriptenv.script_command(self.script(text))

    def test_pins_and_dependency_names_come_from_the_header(self) -> None:
        script = self.script(HEADER)
        self.assertEqual(scriptenv.pinned(script, "cadquery_ocp"), "7.9.3.1.1")
        self.assertEqual(scriptenv.dependency_names(script), {"cadquery", "cadquery-ocp", "pyyaml"})
        with self.assertRaises(ValueError):
            scriptenv.pinned(script, "pyyaml")  # a range, not a pin

    def test_the_shipped_kernel_runners_launch_on_their_header_python(self) -> None:
        for kernel, runner in build.RUNNERS.items():
            command = scriptenv.script_command(runner)
            with self.subTest(kernel=kernel):
                requires = command[command.index("--python") + 1]
                self.assertIn(f'# requires-python = "{requires}"\n', runner.read_text(encoding="utf-8"))
                self.assertEqual(command[command.index("--with-requirements") + 1], str(runner))


if __name__ == "__main__":
    unittest.main()
